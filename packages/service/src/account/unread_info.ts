import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import { ReportRead, type ReadReportParams } from '@weq/protocol';
import { queueSsoWork, ssoWorkState } from './sso_lifecycle';
import type {
  UnreadHighlightInput,
  UnreadInfoResult,
  UnreadInfoTarget,
  UnreadInfoSnapshot,
} from '@weq/db';

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
  private disposed = false;
  private generation = 0;
  private readonly pending = new Map<string, PendingReport>();
  private readonly confirmed = new Map<
    string,
    { pid: number; owner: object | undefined; sequence: number }
  >();
  private lastReport: ReadReportStatus = { state: 'disabled' };

  constructor(
    private readonly session: AccountSession,
    private readonly report?: ReadReportOptions,
  ) {}

  getReadReportStatus(): ReadReportStatus {
    return this.report?.enabled() ? this.lastReport : { state: 'disabled' };
  }

  dispose(): void {
    this.disposed = true;
    this.cancelReports();
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

  getUnreadInfos(targets: UnreadInfoTarget[]): Promise<UnreadInfoSnapshot[]> {
    return this.session.unreadInfo.getUnreadInfos(targets);
  }

  /**
   * Mark a conversation read (raises the last-read seq, drops highlight groups).
   * `latestSeq` is optional — the DB layer falls back to the conversation's
   * recent-contact watermark when omitted.
   */
  markRead(chatType: number, uid: string, latestSeq?: string): Promise<boolean> {
    return this.session.unreadInfo.markRead(chatType, uid, latestSeq);
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
    if (this.disposed) return { changed: false, report: { state: 'unavailable' } };
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
