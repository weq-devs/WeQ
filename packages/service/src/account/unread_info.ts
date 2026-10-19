import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import { ReportRead, type ReadReportParams } from '@weq/protocol';
import { queueSsoWork, ssoWorkState } from './sso_lifecycle';
import { LocalUnreadStore, type ResolvedUnreadInfo } from './local_unread';
import { NEW_CONV_FRESH_SEC, type NewMessages } from './nt_msg_hook';
import type {
  UnreadHighlightInput,
  UnreadInfoResult,
  UnreadInfoTarget,
  UnreadInfoSnapshot,
} from '@weq/db';
import { randomUUID } from 'node:crypto';
import type { ManualReadChange } from './local_unread';

export type ReadReportState =
  | 'disabled'
  | 'unavailable'
  | 'skipped'
  | 'pending'
  | 'acknowledged'
  | 'unconfirmed'
  | 'failed';
export interface ReadReportStatus {
  state: ReadReportState;
  sequence?: string;
}
export interface ReadReportOptions {
  nt: Pick<NtHelperBinding, 'sendPacket' | 'hasSsoSession'>;
  enabled(): boolean;
  /** 只返回已存在的在线会话，不读内存、不提权，不为自动上报启动登录。 */
  resolvePid(): number | null;
}

interface PendingReport {
  target: ReadReportParams;
  pid: number;
  owner: object | undefined;
  promise: Promise<ReadReportStatus>;
}

export class UnreadInfoService {
  private readonly local: LocalUnreadStore;
  private readonly openedAt = Date.now() / 1000;
  private disposed = false;
  private generation = 0;
  private readonly pending = new Map<string, PendingReport>();
  private readonly confirmed = new Map<
    string,
    { pid: number; owner: object | undefined; sequence: number }
  >();
  private lastReport: ReadReportStatus = { state: 'disabled' };
  private readonly readHistory = new Map<
    string,
    Array<UnreadInfoTarget & { change: ManualReadChange }>
  >();

  constructor(
    private readonly session: AccountSession,
    private readonly report?: ReadReportOptions,
    private readonly localOptions?: { statePath: string; readOnly?: boolean },
  ) {
    this.local = new LocalUnreadStore(localOptions?.statePath);
  }

  /** 仅接数据库实时差分；漫游缓存事件不走这里，旧消息导入不增加未读。 */
  observeNewMessages(change: NewMessages): void {
    if (this.disposed || this.localOptions?.readOnly) return;
    const observedAt = change.file.at / 1000;
    const live = (time: bigint) =>
      Number(time) >= Math.max(this.openedAt, observedAt) - NEW_CONV_FRESH_SEC &&
      Number(time) <= observedAt + NEW_CONV_FRESH_SEC;
    for (const msg of change.c2c) {
      if (live(msg.sendTime) && msg.senderUid === msg.targetUid)
        this.local.recordLive(1, msg.targetUid, String(msg.msgSeq));
    }
    for (const msg of change.group) {
      if (
        live(msg.sendTime) &&
        msg.senderUid !== this.session.selfUid &&
        String(msg.senderUin) !== this.session.context.uin
      )
        this.local.recordLive(2, msg.targetGroupCode, String(msg.msgSeq));
    }
    this.local.flush();
  }

  getReadReportStatus(): ReadReportStatus {
    return this.report?.enabled() ? this.lastReport : { state: 'disabled' };
  }

  dispose(): void {
    this.disposed = true;
    this.cancelReports();
    this.readHistory.clear();
  }

  cancelReports(): void {
    this.generation++;
    this.confirmed.clear();
    this.pending.clear();
    this.lastReport = { state: 'disabled' };
  }

  getUnreadInfo(chatType: number, uid: string): Promise<UnreadInfoResult | null> {
    return this.session.unreadInfo.getUnreadInfo(chatType, uid);
  }

  async getUnreadInfos(targets: UnreadInfoTarget[]): Promise<ResolvedUnreadInfo[]> {
    const snapshots = await this.session.unreadInfo.getUnreadInfos(targets);
    if (this.disposed) return snapshots.map((row) => ({ ...row, readError: true }));
    const rows = snapshots.map((row) => this.local.resolve(row));
    this.local.flush();
    return rows;
  }

  async markLocalRead(chatType: number, uid: string, latestSeq?: string): Promise<boolean> {
    const snapshot =
      latestSeq === undefined ? (await this.getUnreadInfos([{ chatType, uid }]))[0] : undefined;
    if (this.disposed || snapshot?.readError) return false;
    const sequence = latestSeq ?? snapshot?.latestSeq;
    if (sequence === undefined || sequence === null) return false;
    const changed = this.local.markRead(chatType, uid, sequence);
    this.local.flush();
    return changed;
  }

  /** 手动标记只覆盖 WeQ 状态，不回退 QQ 水位或发送不可撤销的已读回执。 */
  async setReadState(targets: UnreadInfoTarget[], unread: boolean) {
    const unique = [
      ...new Map(targets.map((target) => [`${target.chatType}_${target.uid}`, target])).values(),
    ];
    const snapshots: UnreadInfoSnapshot[] = [];
    for (let index = 0; index < unique.length; index += 256)
      snapshots.push(
        ...(await this.session.unreadInfo.getUnreadInfos(unique.slice(index, index + 256))),
      );
    if (
      this.disposed ||
      snapshots.length !== unique.length ||
      snapshots.some((row) => row.readError)
    )
      throw new Error('未读状态读取失败，请稍后重试');
    const changes = snapshots.map((snapshot) => ({
      chatType: snapshot.chatType,
      uid: snapshot.uid,
      change: this.local.setManualRead(this.local.resolve(snapshot), unread),
    }));
    try {
      this.local.flush();
    } catch (error) {
      for (const row of changes) this.local.restoreManualRead(row.chatType, row.uid, row.change);
      throw error;
    }
    if (this.readHistory.size >= 20) this.readHistory.delete(this.readHistory.keys().next().value!);
    const undoToken = randomUUID();
    this.readHistory.set(undoToken, changes);
    return { undoToken, rows: snapshots.map((snapshot) => this.local.resolve(snapshot)) };
  }

  async undoReadState(undoToken: string) {
    const changes = this.readHistory.get(undoToken);
    if (!changes || this.disposed) throw new Error('撤销记录已失效');
    // 先取快照；读取失败不消耗撤销机会，也不留下部分恢复。
    const snapshots: UnreadInfoSnapshot[] = [];
    for (let index = 0; index < changes.length; index += 256)
      snapshots.push(
        ...(await this.session.unreadInfo.getUnreadInfos(changes.slice(index, index + 256))),
      );
    if (
      this.disposed ||
      snapshots.length !== changes.length ||
      snapshots.some((row) => row.readError)
    )
      throw new Error('未读状态读取失败，请稍后重试');
    const restored: typeof changes = [];
    for (const row of changes)
      if (this.local.restoreManualRead(row.chatType, row.uid, row.change)) restored.push(row);
    try {
      this.local.flush();
    } catch (error) {
      for (const row of restored)
        this.local.restoreManualRead(row.chatType, row.uid, row.change, true);
      throw error;
    }
    this.readHistory.delete(undoToken);
    return {
      restored: restored.length,
      rows: snapshots.map((snapshot) => this.local.resolve(snapshot)),
    };
  }

  /**
   * Mark a conversation read (raises the last-read seq, drops highlight groups).
   * `latestSeq` is optional — the DB layer falls back to the conversation's
   * recent-contact watermark when omitted.
   */
  async markRead(chatType: number, uid: string, latestSeq?: string): Promise<boolean> {
    const local = await this.markLocalRead(chatType, uid, latestSeq);
    if (this.disposed || this.localOptions?.readOnly) return local;
    const changed = await this.session.unreadInfo.markRead(chatType, uid, latestSeq);
    return changed || local;
  }

  async markReadAndReport(
    chatType: number,
    uid: string,
    latestSeq?: string,
  ): Promise<{ changed: boolean; report: ReadReportStatus }> {
    const generation = this.generation;
    const enabledAtStart = this.report?.enabled() === true;
    const initialPid = enabledAtStart ? this.report!.resolvePid() : null;
    const initialOwner =
      initialPid === null ? undefined : ssoWorkState(this.report!.nt, initialPid).owner;
    const snapshot = (await this.getUnreadInfos([{ chatType, uid }]))[0];
    if (this.disposed || snapshot?.readError)
      return { changed: false, report: { state: 'unavailable' } };
    const sequence = latestSeq ?? snapshot?.latestSeq ?? '0';
    const changed = await this.markRead(chatType, uid, sequence);
    const finish = (status: ReadReportStatus) => {
      if (!this.disposed && this.generation === generation) this.lastReport = status;
      return { changed, report: status };
    };
    if (!enabledAtStart || !this.report?.enabled()) return finish({ state: 'disabled' });
    if (
      this.disposed ||
      this.generation !== generation ||
      initialPid === null ||
      this.report.resolvePid() !== initialPid ||
      ssoWorkState(this.report.nt, initialPid).owner !== initialOwner
    )
      return finish({ state: 'unavailable' });
    const seq = BigInt(sequence);
    if (seq <= 0n || seq > 0xffffffffn || !snapshot?.latestSeq || seq > BigInt(snapshot.latestSeq))
      return finish({ state: 'skipped' });
    try {
      let target: ReadReportParams;
      if (chatType === 2) {
        target = { kind: 'group', groupUin: Number(uid), sequence: Number(seq) };
      } else if (chatType === 1 && /^u_[A-Za-z0-9_-]+$/.test(uid)) {
        const sortNo = this.session.uidMap.sortNoByUid(uid);
        const rows = await this.session.c2cMsgs.listBySeqsInPartition(
          sortNo === undefined ? { uid } : { sortNo },
          [seq],
        );
        // 灰条可能与正文共用 msgSeq；只接受带发送方序号且时间唯一的原消息。
        const candidates = rows.filter(
          (row) => row.msgSeq === seq && row.sendTime > 0n && (row.clientSeq ?? 0n) > 0n,
        );
        const row = candidates[0];
        if (!row || candidates.some((candidate) => candidate.sendTime !== row.sendTime))
          return finish({ state: 'skipped' });
        target = {
          kind: 'c2c',
          targetUid: uid,
          sequence: Number(seq),
          timestamp: Number(row.sendTime),
        };
      } else return finish({ state: 'skipped' });
      ReportRead.serialize(target);
      if (
        this.disposed ||
        this.generation !== generation ||
        !this.report.enabled() ||
        this.report.resolvePid() !== initialPid ||
        ssoWorkState(this.report.nt, initialPid).owner !== initialOwner
      )
        return finish({ state: 'unavailable' });
      const result = finish({ state: 'pending', sequence });
      void this.reportTarget(`${chatType}_${uid}`, target).then(
        (status) => {
          finish(status);
        },
        () => {
          finish({ state: 'failed', sequence });
        },
      );
      return result;
    } catch {
      return finish({ state: 'failed', sequence });
    }
  }

  private reportTarget(key: string, target: ReadReportParams): Promise<ReadReportStatus> {
    const options = this.report!;
    const pid = options.resolvePid();
    if (pid === null || this.disposed || !options.enabled())
      return Promise.resolve({ state: 'unavailable' });
    const owner = ssoWorkState(options.nt, pid).owner;
    const generation = this.generation;
    const prior = this.confirmed.get(key);
    if (prior?.pid === pid && prior.owner === owner && prior.sequence >= target.sequence)
      return Promise.resolve({ state: 'acknowledged', sequence: String(prior.sequence) });
    const active = this.pending.get(key);
    if (active) {
      if (active.pid !== pid || active.owner !== owner)
        return Promise.resolve({ state: 'unavailable' });
      if (target.sequence > active.target.sequence) active.target = target;
      return active.promise;
    }
    if (this.pending.size >= 256) return Promise.resolve({ state: 'unavailable' });
    const entry: PendingReport = {
      target,
      pid,
      owner,
      promise: Promise.resolve({ state: 'unavailable' }),
    };
    const current = () =>
      !this.disposed &&
      this.generation === generation &&
      options.enabled() &&
      options.resolvePid() === pid &&
      ssoWorkState(options.nt, pid).owner === owner;
    entry.promise = (async () => {
      // 先进入微任务，确保 pending 在任何同步结束的路径前已登记。
      await Promise.resolve();
      while (current()) {
        const requested = entry.target;
        let state: ReadReportState = 'failed';
        for (let attempt = 0; attempt < 3 && current(); attempt++) {
          try {
            state = await queueSsoWork(options.nt, pid, async () => {
              if (!current() || !(await options.nt.hasSsoSession(pid)) || !current())
                return 'unavailable' as const;
              return ReportRead.invoke(options.nt, pid, requested);
            });
            break;
          } catch {
            if (attempt < 2 && current())
              await new Promise<void>((resolve) => setTimeout(resolve, attempt === 0 ? 150 : 450));
          }
        }
        if (!current()) return { state: 'unavailable' as const };
        if (state === 'acknowledged') {
          if (this.confirmed.size >= 512)
            this.confirmed.delete(this.confirmed.keys().next().value!);
          this.confirmed.set(key, { pid, owner, sequence: requested.sequence });
        }
        if (entry.target.sequence > requested.sequence) continue;
        return { state, sequence: String(requested.sequence) };
      }
      return { state: 'unavailable' as const };
    })().finally(() => {
      if (this.pending.get(key) === entry) this.pending.delete(key);
    });
    this.pending.set(key, entry);
    return entry.promise;
  }

  /**
   * Append one notify-highlight hit (e.g. 群提醒词 `2006`) to a conversation so
   * both WeQ and QQ show the badge. Idempotent per `(kind, msgSeq)`.
   */
  addHighlight(chatType: number, uid: string, highlight: UnreadHighlightInput): Promise<boolean> {
    return this.session.unreadInfo.addHighlight(chatType, uid, highlight);
  }
}
