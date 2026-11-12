import type { AccountSession } from '@weq/account';
import { recordMessageWork, withDatabasePriority } from '@weq/db';
import type { NtHelperBinding } from '@weq/native';
import { ReportRead, type ReadReportParams } from '@weq/protocol';
import { queueSsoWork, ssoWorkState } from './sso_lifecycle';
import { LocalUnreadStore, type ResolvedUnreadInfo } from './local_unread';
import type { NewMessages } from './nt_msg_hook';
import type {
  UnreadHighlightInput,
  UnreadInfoResult,
  UnreadInfoTarget,
  UnreadInfoSnapshot,
  UnreadReadChange,
} from '@weq/db';
import { randomUUID } from 'node:crypto';
import type { ManualReadChange } from './local_unread';
import type { UnreadCountSource } from './unread_count_source';

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
  version?: number;
}

export class UnreadInfoService {
  private readonly local: LocalUnreadStore;
  private disposed = false;
  private readonly reads = new AbortController();
  private readonly snapshots = new Map<string, UnreadInfoSnapshot>();
  private readonly results = new Map<string, ResolvedUnreadInfo>();
  private readonly targets = new Map<string, UnreadInfoTarget>();
  private loading?: Promise<void>;
  private updatedAt = 0;
  private dirty = true;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private changeTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private readonly writes = new Map<
    string,
    {
      target: UnreadInfoTarget;
      readSeq: string;
      throughSeq: string;
      unread: boolean;
      version: number;
      undo?: ManualReadEntry;
    }
  >();
  private readonly writeTasks = new Map<string, Promise<unknown>>();
  private readonly targetVersions = new Map<string, number>();
  private generation = 0;
  private readonly pending = new Map<string, PendingReport>();
  private readonly confirmed = new Map<
    string,
    { pid: number; owner: object | undefined; sequence: number }
  >();
  private lastReport: ReadReportStatus = { state: 'disabled' };
  private readonly readHistory = new Map<string, ManualReadEntry[]>();
  private readonly countListeners = new Set<(targets: UnreadInfoTarget[]) => void>();
  private manualRevision = 0;

  constructor(
    private readonly session: AccountSession,
    private readonly report?: ReadReportOptions,
    private readonly localOptions?: { statePath: string; readOnly?: boolean },
    private readonly countSource?: UnreadCountSource,
  ) {
    this.local = new LocalUnreadStore(localOptions?.statePath);
    if (typeof session.unreadInfo.getAllUnreadInfos === 'function')
      void this.refreshSnapshots().catch(() => {});
  }

  onCountsChanged(listener: (targets: UnreadInfoTarget[]) => void): () => void {
    this.countListeners.add(listener);
    if (!this.refreshTimer && !this.disposed) {
      this.refreshTimer = setInterval(() => {
        void this.refreshSnapshots().catch(() => {});
      }, 1500);
      this.refreshTimer.unref?.();
      this.invalidate();
    }
    return () => {
      this.countListeners.delete(listener);
      if (!this.countListeners.size) {
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        if (this.changeTimer) clearTimeout(this.changeTimer);
        this.refreshTimer = undefined;
        this.changeTimer = undefined;
      }
    };
  }

  /** 文件通知仅请求小表快照，不累加消息、不使历史区间失效。 */
  invalidate(): void {
    if (this.disposed) return;
    this.dirty = true;
    if (!this.countListeners.size || this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      void this.refreshSnapshots().catch(() => {});
    }, 50);
    this.changeTimer.unref?.();
  }

  async observeNewMessages(_change: NewMessages): Promise<void> {
    this.invalidate();
  }

  /** 诊断显式调用，不作为显示来源或启动前置。 */
  async compareQqCounts() {
    await this.refreshSnapshots();
    const sample = await this.countSource?.read();
    return sample?.rows.map((target) => {
      const row = this.snapshots.get(`${target.chatType}_${target.uid}`);
      return {
        ...target,
        databaseCount: row ? this.results.get(row.peer)?.unreadCount : undefined,
      };
    });
  }

  getReadReportStatus(): ReadReportStatus {
    return this.reportEnabled(false) || this.reportEnabled(true)
      ? this.lastReport
      : { state: 'disabled' };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.changeTimer) clearTimeout(this.changeTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.writes.clear();
    this.countSource?.clear();
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
    _watermarksOnly = false,
  ): Promise<ResolvedUnreadInfo[]> {
    if (this.disposed) return targets.map((target) => this.missing(target));
    for (const target of targets) this.targets.set(this.key(target), target);
    const missing = targets.some((target) => !this.snapshots.has(this.key(target)));
    if (
      missing ||
      (!this.countListeners.size && (this.dirty || Date.now() - this.updatedAt >= 1500))
    ) {
      try {
        await this.refreshSnapshots();
      } catch {
        // 暂时不可用保留已有结果，不用失败快照将角标清零。
      }
    }
    return targets.map((target) => {
      const row = this.results.get(this.key(target));
      return this.disposed || !row ? this.missing(target) : row;
    });
  }

  private key(target: UnreadInfoTarget): string {
    return `${target.chatType}_${target.uid}`;
  }
  private missing(target: UnreadInfoTarget): UnreadInfoSnapshot {
    return { ...target, peer: this.key(target), latestSeq: null, readError: true };
  }
  private publish(targets: UnreadInfoTarget[]): void {
    if (this.disposed || !targets.length) return;
    const changed = targets.map(({ chatType, uid }) => ({ chatType, uid }));
    for (const listener of this.countListeners) listener(changed);
  }

  private project(targets: UnreadInfoTarget[]): void {
    for (const target of targets) {
      const row = this.snapshots.get(this.key(target));
      if (row && !row.readError) this.results.set(row.peer, this.local.resolve(row));
    }
  }

  private async refreshSnapshots(): Promise<void> {
    if (this.disposed) return;
    if (this.loading) return this.loading;
    const revision = this.manualRevision;
    const began = performance.now();
    this.dirty = false;
    const reading = withDatabasePriority(
      'interactive',
      () => {
        this.reads.signal.throwIfAborted();
        return typeof this.session.unreadInfo.getAllUnreadInfos === 'function'
          ? this.session.unreadInfo.getAllUnreadInfos()
          : this.session.unreadInfo.getUnreadInfos([...this.targets.values()]);
      },
      this.reads.signal,
    );
    this.loading = (async () => {
      try {
        const rows = await reading;
        if (this.disposed) return;
        if (revision !== this.manualRevision) {
          this.invalidate();
          return;
        }
        const changed: UnreadInfoTarget[] = [];
        const present = new Set(rows.map((row) => row.peer));
        // 两张小表均无行也是有效快照；目录中缺行的目标不能让每次读取都重查全库。
        for (const [peer, target] of this.targets)
          if (!present.has(peer)) rows.push({ ...target, peer, latestSeq: null });
        for (const row of rows) {
          if (row.readError) continue;
          const before = this.snapshots.get(row.peer);
          if (JSON.stringify(before) === JSON.stringify(row)) continue;
          changed.push(row);
          this.snapshots.set(row.peer, row);
          this.results.set(row.peer, this.local.resolve(row));
        }
        this.updatedAt = Date.now();
        this.publish(changed);
        void this.local.flush().catch((error) => console.error('[unread] 操作保存失败', error));
      } catch (error) {
        this.dirty = true;
        throw error;
      } finally {
        recordMessageWork(this.session.msgDbPath, 'watermarks', performance.now() - began);
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  private async readSnapshots(targets: UnreadInfoTarget[]): Promise<UnreadInfoSnapshot[]> {
    for (const target of targets) this.targets.set(this.key(target), target);
    await this.refreshSnapshots();
    return targets.map((target) => this.snapshots.get(this.key(target)) ?? this.missing(target));
  }

  private bumpTarget(target: UnreadInfoTarget): number {
    const key = this.key(target),
      version = (this.targetVersions.get(key) ?? 0) + 1;
    this.targetVersions.set(key, version);
    this.writes.delete(key);
    return version;
  }

  private async writeTarget<T>(
    target: UnreadInfoTarget,
    version: number,
    run: () => Promise<T>,
  ): Promise<T | undefined> {
    const key = this.key(target);
    const previous = this.writeTasks.get(key);
    const task = (async () => {
      await previous?.catch(() => {});
      if (this.disposed || version !== this.targetVersions.get(key)) return undefined;
      return run();
    })();
    this.writeTasks.set(key, task);
    try {
      return await task;
    } finally {
      if (this.writeTasks.get(key) === task) this.writeTasks.delete(key);
    }
  }

  private queueWrite(
    target: UnreadInfoTarget,
    readSeq: string,
    throughSeq: string,
    unread: boolean,
    version = this.targetVersions.get(this.key(target)) ?? 0,
  ): void {
    if (this.localOptions?.readOnly || this.disposed) return;
    if (version !== this.targetVersions.get(this.key(target))) return;
    this.writes.set(this.key(target), { target, readSeq, throughSeq, unread, version });
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.retryWrites();
    }, 1000);
    this.retryTimer.unref?.();
  }
  private async retryWrites(): Promise<void> {
    for (const [key, entry] of this.writes) {
      if (this.disposed) return;
      try {
        if (entry.undo) {
          const row = entry.undo;
          const restored = await this.writeTarget(row, entry.version, () =>
            this.session.unreadInfo.undoReadState(row.database!),
          );
          if (restored) {
            this.local.restoreManualRead(row.chatType, row.uid, row.change);
            this.manualRevision++;
            this.project([row]);
            await this.local.flush();
            this.publish([row]);
          }
        } else
          await this.writeTarget(entry.target, entry.version, () =>
            this.session.unreadInfo.setReadState(
              entry.target.chatType,
              entry.target.uid,
              entry.readSeq,
              entry.throughSeq,
              entry.unread,
            ),
          );
        if (this.writes.get(key) === entry) this.writes.delete(key);
        this.invalidate();
      } catch {
        /* 下一轮合并重试，只保存每会话最新操作。 */
      }
    }
    if (this.writes.size && !this.disposed && !this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.retryWrites();
      }, 5000);
      this.retryTimer.unref?.();
    }
  }

  async markLocalRead(chatType: number, uid: string, latestSeq?: string): Promise<boolean> {
    const snapshot =
      latestSeq === undefined ? (await this.getUnreadInfos([{ chatType, uid }]))[0] : undefined;
    const sequence = latestSeq ?? snapshot?.latestSeq;
    if (this.disposed || sequence == null || snapshot?.readError) return false;
    const changed = this.local.markRead(chatType, uid, sequence);
    if (changed) {
      this.manualRevision++;
      this.bumpTarget({ chatType, uid });
      this.project([{ chatType, uid }]);
      this.publish([{ chatType, uid }]);
      await this.local.flush();
    }
    return changed;
  }

  async setReadState(targets: UnreadInfoTarget[], unread: boolean) {
    const unique = [...new Map(targets.map((target) => [this.key(target), target])).values()];
    const snapshots = await this.readSnapshots(unique);
    if (this.disposed || snapshots.some((row) => row.readError))
      throw new Error('未读状态读取失败，请稍后重试');
    this.manualRevision++;
    this.cancelReports();
    const changes: ManualReadEntry[] = snapshots.map((snapshot) => ({
      chatType: snapshot.chatType,
      uid: snapshot.uid,
      change: this.local.setManualRead(this.local.resolve(snapshot), unread),
      snapshot,
      version: this.bumpTarget(snapshot),
    }));
    this.project(unique);
    this.publish(unique);
    await this.local.flush();
    for (const row of changes) {
      if (this.disposed || this.localOptions?.readOnly) continue;
      try {
        row.database = await this.writeTarget(row, row.version!, () =>
          this.session.unreadInfo.setReadState(
            row.chatType,
            row.uid,
            row.change.applied.readSeq ?? '0',
            row.change.applied.latestSeq,
            unread,
          ),
        );
      } catch {
        this.queueWrite(
          row,
          row.change.applied.readSeq ?? '0',
          row.change.applied.latestSeq,
          unread,
          row.version,
        );
      }
    }
    if (this.readHistory.size >= 20) this.readHistory.delete(this.readHistory.keys().next().value!);
    const undoToken = randomUUID();
    this.readHistory.set(undoToken, changes);
    if (!unread) this.scheduleManualReports(changes);
    this.invalidate();
    return { undoToken, rows: snapshots.map((snapshot) => this.local.resolve(snapshot)) };
  }

  async undoReadState(undoToken: string) {
    const changes = this.readHistory.get(undoToken);
    if (!changes || this.disposed) throw new Error('撤销记录已失效');
    const snapshots = await this.readSnapshots(changes);
    this.manualRevision++;
    this.cancelReports();
    const restored: ManualReadEntry[] = [];
    for (const row of changes) {
      if (!this.local.hasManualRead(row.chatType, row.uid, row.change)) continue;
      const version = this.bumpTarget(row);
      if (row.database) {
        try {
          if (
            !(await this.writeTarget(row, version, () =>
              this.session.unreadInfo.undoReadState(row.database!),
            ))
          )
            continue;
        } catch {
          this.queueWrite(
            row,
            row.snapshot.msgSeq?.toString() ?? '0',
            row.change.applied.latestSeq,
            row.snapshot.markUnread ?? false,
            version,
          );
          const pending = this.writes.get(this.key(row));
          if (pending?.version === version) pending.undo = row;
          continue;
        }
      }
      if (this.local.restoreManualRead(row.chatType, row.uid, row.change)) restored.push(row);
    }
    await this.local.flush();
    this.readHistory.delete(undoToken);
    this.scheduleManualReports(restored, true);
    // 固定本次撤销的原始阅读字段；后来到达的最新位置仍来自当前小表。
    const byPeer = new Map(restored.map((row) => [this.key(row), row]));
    const rows = snapshots.map((snapshot) => {
      const prior = byPeer.get(snapshot.peer);
      if (!prior) return this.local.resolve(snapshot);
      const merged = {
        ...snapshot,
        msgSeq: prior.snapshot.msgSeq,
        localReadSeq: prior.snapshot.localReadSeq,
        markUnread: prior.snapshot.markUnread,
        highlights: [
          ...new Map(
            [...(prior.snapshot.highlights ?? []), ...(snapshot.highlights ?? [])].map((hit) => [
              hit.rawKind,
              hit,
            ]),
          ).values(),
        ],
      };
      this.snapshots.set(snapshot.peer, merged);
      const result = this.local.resolve(merged);
      this.results.set(snapshot.peer, result);
      return result;
    });
    this.publish(restored);
    this.invalidate();
    return { restored: restored.length, rows };
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
    const target = { chatType, uid };
    const saving = this.markLocalRead(chatType, uid, sequence);
    const version = this.targetVersions.get(this.key(target)) ?? 0;
    const local = await saving;
    if (this.disposed || this.localOptions?.readOnly) return local;
    try {
      const changed = await this.writeTarget(target, version, () =>
        this.session.unreadInfo.markRead(chatType, uid, sequence),
      );
      this.invalidate();
      return changed || local;
    } catch {
      this.queueWrite(target, sequence, sequence, false, version);
      return local;
    }
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
