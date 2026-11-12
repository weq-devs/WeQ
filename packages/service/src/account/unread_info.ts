import type { AccountSession } from '@weq/account';
import { databaseRequestSignal, recordMessageWork, withDatabasePriority } from '@weq/db';
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
  UnreadReadChange,
} from '@weq/db';
import { randomUUID } from 'node:crypto';
import type { ManualReadChange } from './local_unread';
import { datalineDevice, isDatalineUid, classifyChatType } from '@weq/codec';
import { SendType } from '@weq/codec/proto/msg/40900';
import { UnreadCountCache, type UnreadCountSource } from './unread_count_source';

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
  manualEnabled?(): boolean;
  /** 只返回已存在的在线会话，不读内存、不提权，不为自动上报启动登录。 */
  resolvePid(): number | null;
}

interface PendingReport {
  target: ReadReportParams;
  pid: number;
  owner: object | undefined;
  promise: Promise<ReadReportStatus>;
}

interface ManualReadEntry extends UnreadInfoTarget {
  change: ManualReadChange;
  snapshot: UnreadInfoSnapshot;
  database?: UnreadReadChange;
}

export class UnreadInfoService {
  private readonly local: LocalUnreadStore;
  private readonly openedAt = Date.now() / 1000;
  private disposed = false;
  private readonly reads = new AbortController();
  private readonly badgeReads = new Map<string, Promise<UnreadInfoSnapshot[]>>();
  private generation = 0;
  private readonly pending = new Map<string, PendingReport>();
  private readonly confirmed = new Map<
    string,
    { pid: number; owner: object | undefined; sequence: number }
  >();
  private lastReport: ReadReportStatus = { state: 'disabled' };
  private readonly readHistory = new Map<string, ManualReadEntry[]>();
  private readonly counts?: UnreadCountCache;
  private readonly countOnlySnapshots = new WeakSet<UnreadInfoSnapshot>();
  private readonly countListeners = new Set<(targets: UnreadInfoTarget[]) => void>();
  private manualRevision = 0;

  constructor(
    private readonly session: AccountSession,
    private readonly report?: ReadReportOptions,
    private readonly localOptions?: { statePath: string; readOnly?: boolean },
    countSource?: UnreadCountSource,
  ) {
    this.local = new LocalUnreadStore(localOptions?.statePath);
    if (countSource && !localOptions?.readOnly)
      this.counts = new UnreadCountCache(
        countSource,
        (targets) => this.readSnapshots(targets, undefined, true, true),
        (targets) => {
          for (const listener of this.countListeners) listener(targets);
        },
      );
  }

  onCountsChanged(listener: (targets: UnreadInfoTarget[]) => void): () => void {
    this.countListeners.add(listener);
    return () => this.countListeners.delete(listener);
  }

  /** 仅接数据库实时差分；漫游缓存事件不走这里，旧消息导入不增加未读。 */
  async observeNewMessages(change: NewMessages): Promise<void> {
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
    for (const msg of change.dataline ?? []) {
      const device = datalineDevice(msg.senderUid);
      if (
        live(msg.sendTime) &&
        isDatalineUid(msg.targetUid) &&
        classifyChatType(msg.chatType) === 'dataline' &&
        (device === 'phone' || device === 'pad') &&
        (msg.sendType === BigInt(SendType.RECEIVED) ||
          msg.sendType === BigInt(SendType.OTHER_CLIENT))
      )
        this.local.recordLive(msg.chatType, msg.targetUid, String(msg.msgSeq));
    }
    await this.local.flush();
  }

  getReadReportStatus(): ReadReportStatus {
    return this.reportEnabled(false) || this.reportEnabled(true)
      ? this.lastReport
      : { state: 'disabled' };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.counts?.dispose();
    this.countListeners.clear();
    this.reads.abort();
    this.cancelReports();
    this.readHistory.clear();
    await this.local.flush();
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

  async getUnreadInfos(
    targets: UnreadInfoTarget[],
    watermarksOnly = false,
  ): Promise<ResolvedUnreadInfo[]> {
    if (this.disposed)
      return targets.map(({ chatType, uid }) => ({
        chatType,
        uid,
        peer: `${chatType}_${uid}`,
        latestSeq: null,
        readError: true,
      }));
    const began = performance.now();
    const manualRevision = this.manualRevision;
    if (targets.length) this.counts?.start();
    const readSeqs = new Map<string, string>();
    for (const target of targets) {
      const floor = this.local.countFloor(target.chatType, target.uid);
      if (floor !== undefined) readSeqs.set(`${target.chatType}_${target.uid}`, floor);
    }
    const key = JSON.stringify([manualRevision, watermarksOnly, targets, [...readSeqs]]);
    // 带独立取消信号的调用不共享在途任务，避免一个调用取消其他页面的统计。
    const share = databaseRequestSignal() === undefined;
    let reading = share ? this.badgeReads.get(key) : undefined;
    if (!reading) {
      reading = this.readBadgeSnapshots(targets, readSeqs, watermarksOnly).finally(() => {
        if (share) this.badgeReads.delete(key);
      });
      if (share) this.badgeReads.set(key, reading);
    }
    const snapshots = await reading;
    recordMessageWork(this.session.msgDbPath, 'watermarks', performance.now() - began);
    if (this.disposed || manualRevision !== this.manualRevision)
      return snapshots.map((row) => ({ ...row, readError: true }));
    const rows = snapshots.map((row): ResolvedUnreadInfo => {
      const count = this.local.canUseCount(row) ? this.counts?.get(row) : undefined;
      if (count !== undefined) return this.local.resolve(row, count);
      // 统计期间来源失效或发生本地操作，轻量行不能冒充已完成精确统计。
      if (this.countOnlySnapshots.has(row)) return { ...row, readError: true };
      const currentFloor = this.local.countFloor(row.chatType, row.uid) ?? '0';
      const scannedFrom = readSeqs.get(row.peer);
      // 撤销手动阅读可能降低下限；此前跳过的区间不能冒充已完成统计。
      if (scannedFrom !== undefined && BigInt(scannedFrom) > BigInt(currentFloor))
        return { ...row, readError: true };
      if (
        watermarksOnly &&
        !row.readError &&
        row.msgSeq !== undefined &&
        row.latestSeq !== null &&
        /^\d+$/.test(row.latestSeq) &&
        BigInt(row.latestSeq) > BigInt(row.msgSeq) &&
        BigInt(row.latestSeq) > BigInt(currentFloor) &&
        classifyChatType(row.chatType) !== 'dataline'
      )
        return { ...row, countPending: true };
      return this.local.resolve(row);
    });
    const saving = performance.now();
    await this.local.flush();
    recordMessageWork(this.session.msgDbPath, 'unreadPersistence', performance.now() - saving);
    if (this.disposed || manualRevision !== this.manualRevision)
      return rows.map((row) => ({ ...row, readError: true }));
    return rows;
  }

  private async readBadgeSnapshots(
    targets: UnreadInfoTarget[],
    readSeqs: ReadonlyMap<string, string>,
    watermarksOnly: boolean,
  ): Promise<UnreadInfoSnapshot[]> {
    if (watermarksOnly || !this.counts?.ready)
      return this.readSnapshots(targets, readSeqs, watermarksOnly);
    const light = await this.readSnapshots(targets, undefined, true);
    if (this.disposed) return light;
    const fallback = light.filter(
      (row) => !this.local.canUseCount(row) || this.counts?.get(row) === undefined,
    );
    const exact = fallback.length ? await this.readSnapshots(fallback, readSeqs) : [];
    const byPeer = new Map(exact.map((row) => [row.peer, row]));
    return light.map((row) => {
      const full = byPeer.get(row.peer);
      if (full) return full;
      this.countOnlySnapshots.add(row);
      return row;
    });
  }

  private readSnapshots(
    targets: UnreadInfoTarget[],
    readSeqs?: ReadonlyMap<string, string>,
    watermarksOnly = false,
    background = false,
  ): Promise<UnreadInfoSnapshot[]> {
    const inherited = background ? undefined : databaseRequestSignal();
    const signal = inherited ? AbortSignal.any([inherited, this.reads.signal]) : this.reads.signal;
    return withDatabasePriority(
      watermarksOnly && !background ? 'interactive' : 'background',
      () => {
        signal.throwIfAborted();
        if (watermarksOnly) return this.session.unreadInfo.getUnreadInfos(targets);
        const self = {
          selfUid: this.session.selfUid,
          selfUin: this.session.context.uin,
        };
        return this.session.unreadInfo.getUnreadInfos(
          targets,
          self,
          readSeqs?.size ? readSeqs : undefined,
          { reuseOutgoing: true },
        );
      },
      signal,
    );
  }

  async markLocalRead(chatType: number, uid: string, latestSeq?: string): Promise<boolean> {
    const snapshot =
      latestSeq === undefined ? (await this.getUnreadInfos([{ chatType, uid }]))[0] : undefined;
    if (this.disposed || snapshot?.readError) return false;
    const sequence = latestSeq ?? snapshot?.latestSeq;
    if (sequence === undefined || sequence === null) return false;
    const changed = this.local.markRead(chatType, uid, sequence);
    await this.local.flush();
    return changed;
  }

  /** 可写目录同步修改 QQ 库；手动上报由独立开关控制，默认关闭。 */
  async setReadState(targets: UnreadInfoTarget[], unread: boolean) {
    const unique = [
      ...new Map(targets.map((target) => [`${target.chatType}_${target.uid}`, target])).values(),
    ];
    const snapshots: UnreadInfoSnapshot[] = [];
    for (let index = 0; index < unique.length; index += 256)
      snapshots.push(...(await this.readSnapshots(unique.slice(index, index + 256))));
    if (
      this.disposed ||
      snapshots.length !== unique.length ||
      snapshots.some((row) => row.readError)
    )
      throw new Error('未读状态读取失败，请稍后重试');
    this.manualRevision++;
    const changes: ManualReadEntry[] = snapshots.map((snapshot) => ({
      chatType: snapshot.chatType,
      uid: snapshot.uid,
      change: this.local.setManualRead(this.local.resolve(snapshot), unread),
      snapshot,
    }));
    this.cancelReports();
    try {
      if (!this.localOptions?.readOnly) {
        for (const row of changes) {
          if (this.disposed) throw new Error('账号已关闭');
          row.database = await this.session.unreadInfo.setReadState(
            row.chatType,
            row.uid,
            row.change.applied.readSeq ?? '0',
            row.change.applied.latestSeq,
            unread,
          );
        }
      }
      await this.local.flush();
    } catch (error) {
      let rollbackFailed = false;
      for (const row of [...changes].reverse()) {
        try {
          if (row.database && !(await this.session.unreadInfo.undoReadState(row.database)))
            rollbackFailed = true;
        } catch {
          rollbackFailed = true;
        }
        this.local.restoreManualRead(row.chatType, row.uid, row.change);
      }
      if (rollbackFailed)
        throw new Error('批量标记失败，部分会话因并发变化未回滚，请刷新后查看实际状态', {
          cause: error,
        });
      throw error;
    }
    if (this.readHistory.size >= 20) this.readHistory.delete(this.readHistory.keys().next().value!);
    const undoToken = randomUUID();
    this.readHistory.set(undoToken, changes);
    if (!unread) this.scheduleManualReports(changes);
    return { undoToken, rows: snapshots.map((snapshot) => this.local.resolve(snapshot)) };
  }

  async undoReadState(undoToken: string) {
    const changes = this.readHistory.get(undoToken);
    if (!changes || this.disposed) throw new Error('撤销记录已失效');
    // 先取快照；读取失败不消耗撤销机会，也不留下部分恢复。
    const snapshots: UnreadInfoSnapshot[] = [];
    for (let index = 0; index < changes.length; index += 256)
      snapshots.push(...(await this.readSnapshots(changes.slice(index, index + 256))));
    if (
      this.disposed ||
      snapshots.length !== changes.length ||
      snapshots.some((row) => row.readError)
    )
      throw new Error('未读状态读取失败，请稍后重试');
    this.cancelReports();
    const restored: typeof changes = [];
    this.manualRevision++;
    const rowsByPeer = new Map(snapshots.map((row) => [`${row.chatType}_${row.uid}`, row]));
    for (const row of changes) {
      if (!this.local.hasManualRead(row.chatType, row.uid, row.change)) continue;
      if (this.disposed) throw new Error('账号已关闭');
      if (row.database && !(await this.session.unreadInfo.undoReadState(row.database))) continue;
      if (this.local.restoreManualRead(row.chatType, row.uid, row.change)) {
        restored.push(row);
        const key = `${row.chatType}_${row.uid}`;
        const current = rowsByPeer.get(key)!;
        rowsByPeer.set(key, {
          ...current,
          msgSeq: row.database
            ? row.database.beforeReadSeq === undefined
              ? undefined
              : Number(row.database.beforeReadSeq)
            : row.snapshot.msgSeq,
          highlights: [
            ...new Map(
              [
                ...(row.snapshot.highlights ?? []),
                ...(current.highlights ?? []).filter(
                  (hit) => BigInt(hit.msgSeq) > BigInt(row.change.applied.latestSeq),
                ),
              ].map((hit) => [hit.rawKind, hit]),
            ).values(),
          ],
        });
      }
    }
    try {
      await this.local.flush();
    } catch (error) {
      if (restored.some((row) => row.database)) {
        this.readHistory.delete(undoToken);
        throw new Error('撤销已写入数据库，但本地阅读状态保存失败，请刷新后查看实际状态', {
          cause: error,
        });
      }
      for (const row of restored)
        this.local.restoreManualRead(row.chatType, row.uid, row.change, true);
      throw error;
    }
    this.readHistory.delete(undoToken);
    this.scheduleManualReports(restored, true);
    return {
      restored: restored.length,
      rows: [...rowsByPeer.values()].map((snapshot) => this.local.resolve(snapshot)),
    };
  }

  private reportEnabled(manual: boolean): boolean {
    return manual ? this.report?.manualEnabled?.() === true : this.report?.enabled() === true;
  }

  private scheduleManualReports(changes: ManualReadEntry[], undo = false): void {
    if (this.localOptions?.readOnly || !this.reportEnabled(true)) return;
    const generation = this.generation;
    void (async () => {
      for (const row of changes) {
        if (this.disposed || this.generation !== generation || !this.reportEnabled(true)) return;
        if (!undo && !this.local.hasManualRead(row.chatType, row.uid, row.change)) continue;
        const sequence = undo
          ? row.database
            ? row.database.beforeReadSeq
            : row.snapshot.msgSeq?.toString()
          : row.change.applied.latestSeq;
        if (
          sequence === undefined ||
          (undo && BigInt(sequence) <= BigInt(row.change.applied.readSeq ?? '0'))
        )
          continue;
        await this.markReadAndReport(row.chatType, row.uid, sequence, {
          manual: true,
          write: false,
        });
      }
    })().catch(() => {
      if (!this.disposed && this.generation === generation) this.lastReport = { state: 'failed' };
    });
  }

  /**
   * Mark a conversation read (raises the last-read seq, drops highlight groups).
   * `latestSeq` is optional — the DB layer falls back to the conversation's
   * recent-contact watermark when omitted.
   */
  async markRead(chatType: number, uid: string, latestSeq?: string): Promise<boolean> {
    const snapshot =
      latestSeq === undefined ? (await this.getUnreadInfos([{ chatType, uid }]))[0] : undefined;
    const sequence = latestSeq ?? snapshot?.latestSeq;
    if (this.disposed || snapshot?.readError || sequence === undefined || sequence === null)
      return false;
    const local = await this.markLocalRead(chatType, uid, sequence);
    if (this.disposed || this.localOptions?.readOnly) return local;
    const changed = await this.session.unreadInfo.markRead(chatType, uid, sequence);
    return changed || local;
  }

  async markReadAndReport(
    chatType: number,
    uid: string,
    latestSeq?: string,
    options?: { manual: boolean; write: false },
  ): Promise<{ changed: boolean; report: ReadReportStatus }> {
    const generation = this.generation;
    const manual = options?.manual === true;
    const enabledAtStart = this.reportEnabled(manual);
    const initialPid = enabledAtStart ? this.report!.resolvePid() : null;
    const initialOwner =
      initialPid === null ? undefined : ssoWorkState(this.report!.nt, initialPid).owner;
    const snapshot = (await this.getUnreadInfos([{ chatType, uid }]))[0];
    if (this.disposed || snapshot?.readError)
      return { changed: false, report: { state: 'unavailable' } };
    const sequence = latestSeq ?? snapshot?.latestSeq ?? '0';
    const changed = options?.write === false ? false : await this.markRead(chatType, uid, sequence);
    const finish = (status: ReadReportStatus) => {
      if (!this.disposed && this.generation === generation) this.lastReport = status;
      return { changed, report: status };
    };
    if (!enabledAtStart || !this.reportEnabled(manual)) return finish({ state: 'disabled' });
    if (
      this.disposed ||
      this.generation !== generation ||
      initialPid === null ||
      this.report!.resolvePid() !== initialPid ||
      ssoWorkState(this.report!.nt, initialPid).owner !== initialOwner
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
        !this.reportEnabled(manual) ||
        this.report!.resolvePid() !== initialPid ||
        ssoWorkState(this.report!.nt, initialPid).owner !== initialOwner
      )
        return finish({ state: 'unavailable' });
      const result = finish({ state: 'pending', sequence });
      const report = this.reportTarget(
        `${manual ? 'manual:' : ''}${chatType}_${uid}`,
        target,
        manual,
      );
      if (manual) return finish(await report);
      void report.then(
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

  private reportTarget(
    key: string,
    target: ReadReportParams,
    manual = false,
  ): Promise<ReadReportStatus> {
    const options = this.report!;
    const pid = options.resolvePid();
    if (pid === null || this.disposed || !this.reportEnabled(manual))
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
      this.reportEnabled(manual) &&
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
