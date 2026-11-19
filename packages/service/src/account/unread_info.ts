import type { AccountSession } from '@weq/account';
import { classifyChatType } from '@weq/codec';
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
import { ImportantMessageStore } from './important_messages';

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
  change?: ManualReadChange;
  readSeq: string;
  throughSeq: string;
  database?: UnreadReadChange;
  version: number;
}

export class UnreadInfoService {
  private readonly local: LocalUnreadStore;
  private readonly important: ImportantMessageStore;
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
  private readonly writes = new Map<string, () => Promise<void>>();
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
  private localResetRevision = 0;

  constructor(
    private readonly session: AccountSession,
    private readonly report?: ReadReportOptions,
    private readonly localOptions?: { statePath: string; readOnly?: boolean },
    private readonly countSource?: UnreadCountSource,
  ) {
    this.local = new LocalUnreadStore(localOptions?.statePath, session.selfUid, (chatType) =>
      this.usesLocalReadState(chatType),
    );
    this.important = new ImportantMessageStore(
      localOptions?.statePath ? `${localOptions.statePath}.important.json` : undefined,
    );
    if (typeof session.unreadInfo.getAllUnreadInfos === 'function')
      void this.refreshSnapshots().catch(() => {});
  }

  private usesLocalReadState(chatType: number): boolean {
    // 数据线使用独立计数，QQ 已读位置写入不更新这些字段。
    return this.localOptions?.readOnly === true || classifyChatType(chatType) === 'dataline';
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
    await this.important.flush();
  }

  cancelReports(): void {
    this.generation++;
    this.confirmed.clear();
    this.pending.clear();
    this.lastReport = { state: 'disabled' };
  }

  /** 只清除 WeQ 覆盖值，不回退 QQ 小表或服务器已经确认的已读位置。 */
  async clearLocalReadRecords(): Promise<void> {
    if (this.disposed) throw new Error('账号已关闭');
    this.localResetRevision++;
    this.manualRevision++;
    this.cancelReports();
    this.readHistory.clear();
    this.writes.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    for (const [key, version] of this.targetVersions) this.targetVersions.set(key, version + 1);
    this.local.clear();
    const targets = [...this.snapshots.values()];
    this.project(targets);
    this.publish(targets);
    await this.local.flush();
    this.invalidate();
  }

  getUnreadInfo(chatType: number, uid: string): Promise<UnreadInfoResult | null> {
    return this.session.unreadInfo.getUnreadInfo(chatType, uid);
  }

  private async readSequence(chatType: number, uid: string, requested?: string) {
    if (this.disposed || (requested !== undefined && !/^\d{1,20}$/.test(requested)))
      return undefined;
    const target = { chatType, uid };
    let [snapshot] = await this.getUnreadInfos([target]);
    if (
      requested !== undefined &&
      snapshot?.latestSeq != null &&
      BigInt(requested) > BigInt(snapshot.latestSeq)
    ) {
      // 列表可能领先共享缓存；只补读小表，不用越界值推进已读或改读最新消息。
      try {
        [snapshot] = await this.readSnapshots([target]);
      } catch {
        return undefined;
      }
    }
    const sequence = requested ?? snapshot?.latestSeq;
    if (
      this.disposed ||
      !snapshot ||
      snapshot.readError ||
      snapshot.chatType !== chatType ||
      snapshot.uid !== uid ||
      snapshot.peer !== this.key(target) ||
      snapshot.latestSeq === null ||
      sequence == null ||
      !/^\d{1,20}$/.test(sequence) ||
      BigInt(sequence) <= 0n ||
      BigInt(sequence) > BigInt(snapshot.latestSeq)
    )
      return undefined;
    return sequence;
  }

  async listImportantMessages(input: Parameters<ImportantMessageStore['list']>[0]) {
    const [snapshot] = await this.getUnreadInfos([input]);
    if (snapshot?.readError) throw new Error('提醒状态读取失败，请重试');
    return this.important.list({ ...input, readSeq: snapshot?.readSeq });
  }

  async directoryUnreadCount(
    chatType: number,
    uid: string,
    latestSeq?: string,
  ): Promise<number | undefined> {
    const [snapshot] = await this.getUnreadInfos([{ chatType, uid }]);
    if (!snapshot || snapshot.readError) return undefined;
    return this.local.resolve({ ...snapshot, latestSeq: snapshot.latestSeq ?? latestSeq ?? null })
      .unreadCount;
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
          this.important.observe(row);
          const before = this.snapshots.get(row.peer);
          if (JSON.stringify(before) === JSON.stringify(row)) continue;
          changed.push(row);
          this.snapshots.set(row.peer, row);
          this.results.set(row.peer, this.local.resolve(row));
        }
        this.updatedAt = Date.now();
        this.publish(changed);
        void this.local.flush().catch((error) => console.error('[unread] 操作保存失败', error));
        void this.important
          .flush()
          .catch((error) => console.error('[unread] 重要消息保存失败', error));
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

  private async refreshWrittenTargets(targets: (UnreadInfoTarget & { version: number })[]) {
    if (!targets.length || this.disposed) return;
    // 丢弃写入前已发出的全量读取，只回读本次写入的会话。
    this.manualRevision++;
    this.invalidate();
    const before = new Map(
      targets.map((target) => {
        const peer = this.key(target);
        return [peer, { version: target.version, snapshot: this.snapshots.get(peer) }];
      }),
    );
    try {
      const rows = await withDatabasePriority(
        'interactive',
        () => this.session.unreadInfo.getUnreadInfos(targets),
        this.reads.signal,
      );
      if (this.disposed) return;
      const changed = rows.filter((row) => {
        const previous = before.get(row.peer);
        return (
          !row.readError &&
          previous &&
          previous.version === this.targetVersions.get(row.peer) &&
          previous.snapshot === this.snapshots.get(row.peer)
        );
      });
      for (const row of changed) {
        this.important.observe(row);
        this.snapshots.set(row.peer, row);
      }
      this.project(changed);
      this.publish(changed);
    } catch {
      // 已确认的写入不重复执行；共享刷新会补上回读失败的结果。
      this.invalidate();
    }
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

  private queueWrite(target: UnreadInfoTarget, version: number, run: () => Promise<void>): void {
    if (this.localOptions?.readOnly || this.disposed) return;
    if (version !== this.targetVersions.get(this.key(target))) return;
    this.writes.set(this.key(target), run);
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
        await entry();
        if (this.writes.get(key) === entry) this.writes.delete(key);
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
    if (!this.usesLocalReadState(chatType)) return false;
    const resetRevision = this.localResetRevision;
    latestSeq = await this.readSequence(chatType, uid, latestSeq);
    if (latestSeq === undefined || resetRevision !== this.localResetRevision) return false;
    if (chatType === 2) await this.important.flush();
    if (this.disposed || resetRevision !== this.localResetRevision) return false;
    return this.saveLocalRead({ chatType, uid }, latestSeq);
  }

  private async saveLocalRead(target: UnreadInfoTarget, sequence: string): Promise<boolean> {
    const changed = this.local.markRead(target.chatType, target.uid, sequence);
    if (changed) {
      this.manualRevision++;
      this.project([target]);
      this.publish([target]);
      await this.local.flush();
    }
    return changed;
  }

  async setReadState(targets: UnreadInfoTarget[], unread: boolean) {
    const resetRevision = this.localResetRevision;
    const unique = [...new Map(targets.map((target) => [this.key(target), target])).values()];
    const snapshots = await this.readSnapshots(unique);
    if (this.disposed || snapshots.some((row) => row.readError))
      throw new Error('未读状态读取失败，请稍后重试');
    if (!unread && unique.some((target) => target.chatType === 2)) await this.important.flush();
    if (resetRevision !== this.localResetRevision) throw new Error('已读记录已清除，请重新操作');
    this.manualRevision++;
    this.cancelReports();
    const changes: ManualReadEntry[] = snapshots.map((raw) => {
      const snapshot = this.local.resolve(raw);
      const throughSeq = snapshot.latestSeq ?? snapshot.readSeq ?? '0';
      return {
        chatType: snapshot.chatType,
        uid: snapshot.uid,
        change: this.usesLocalReadState(snapshot.chatType)
          ? this.local.setManualRead(snapshot, unread)
          : undefined,
        readSeq: unread ? (snapshot.readSeq ?? '0') : throughSeq,
        throughSeq,
        version: this.bumpTarget(snapshot),
      };
    });
    const local = changes.filter((row) => row.change);
    this.project(local);
    this.publish(local);
    await this.local.flush();
    for (const row of changes) {
      if (this.disposed || this.localOptions?.readOnly || resetRevision !== this.localResetRevision)
        continue;
      const write = () =>
        this.writeTarget(row, row.version, () =>
          this.session.unreadInfo.setReadState(
            row.chatType,
            row.uid,
            row.readSeq,
            row.throughSeq,
            unread,
          ),
        );
      try {
        row.database = await write();
      } catch {
        if (row.change)
          this.queueWrite(row, row.version, async () => {
            row.database = await write();
            if (row.database) await this.refreshWrittenTargets([row]);
          });
      }
    }
    await this.refreshWrittenTargets(changes.filter((row) => row.database));
    if (this.disposed || resetRevision !== this.localResetRevision)
      throw new Error('会话阅读状态已切换，请重新操作');
    const applied = changes.filter((row) => row.change || row.database);
    if (!applied.length) throw new Error('QQ 数据库未能保存标记，请稍后重试');
    if (this.readHistory.size >= 20) this.readHistory.delete(this.readHistory.keys().next().value!);
    const undoToken = randomUUID();
    this.readHistory.set(undoToken, applied);
    if (!unread) this.scheduleManualReports(applied);
    return { undoToken, failed: changes.length - applied.length, rows: this.resultRows(unique) };
  }

  private resultRows(targets: UnreadInfoTarget[]): ResolvedUnreadInfo[] {
    return targets.map((target) => this.results.get(this.key(target)) ?? this.missing(target));
  }

  private isCurrentManualChange(row: ManualReadEntry): boolean {
    return row.change
      ? this.local.hasManualRead(row.chatType, row.uid, row.change)
      : this.targetVersions.get(this.key(row)) === row.version;
  }

  private restoreLocalRead(row: ManualReadEntry) {
    if (!row.change || !this.local.restoreManualRead(row.chatType, row.uid, row.change)) return;
    this.manualRevision++;
    this.project([row]);
    this.publish([row]);
  }

  async undoReadState(undoToken: string) {
    const resetRevision = this.localResetRevision;
    const changes = this.readHistory.get(undoToken);
    if (!changes || this.disposed) throw new Error('撤销记录已失效');
    await this.readSnapshots(changes);
    if (resetRevision !== this.localResetRevision) throw new Error('撤销记录已失效');
    this.manualRevision++;
    this.cancelReports();
    const restored: ManualReadEntry[] = [];
    const written: (UnreadInfoTarget & { version: number })[] = [];
    let pending = 0;
    for (const row of changes) {
      if (!this.isCurrentManualChange(row)) continue;
      const version = this.bumpTarget(row);
      const database = row.database;
      if (database) {
        const undo = () =>
          this.writeTarget(row, version, () => this.session.unreadInfo.undoReadState(database));
        try {
          if (!(await undo())) continue;
          written.push({ chatType: row.chatType, uid: row.uid, version });
        } catch {
          this.queueWrite(row, version, async () => {
            if (!(await undo()) || this.targetVersions.get(this.key(row)) !== version) return;
            this.restoreLocalRead(row);
            await this.local.flush();
            await this.refreshWrittenTargets([{ ...row, version }]);
          });
          pending++;
          continue;
        }
      }
      if (resetRevision !== this.localResetRevision) throw new Error('撤销记录已失效');
      if (this.targetVersions.get(this.key(row)) !== version) continue;
      this.restoreLocalRead(row);
      restored.push(row);
    }
    await this.local.flush();
    await this.refreshWrittenTargets(written);
    this.readHistory.delete(undoToken);
    this.scheduleManualReports(restored, true);
    return { restored: restored.length, pending, rows: this.resultRows(changes) };
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
        if (!undo && !this.isCurrentManualChange(row)) continue;
        const sequence = undo ? row.database?.beforeReadSeq : row.throughSeq;
        if (sequence === undefined || (undo && BigInt(sequence) <= BigInt(row.readSeq))) continue;
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
    const resetRevision = this.localResetRevision;
    const sequence = await this.readSequence(chatType, uid, latestSeq);
    if (sequence === undefined || resetRevision !== this.localResetRevision) return false;
    const target = { chatType, uid };
    // 清除未读状态前先落盘提醒，写入失败时保留 QQ 原始提醒供重试。
    if (chatType === 2) await this.important.flush();
    if (this.disposed || resetRevision !== this.localResetRevision) return false;
    const version = this.bumpTarget(target);
    const local = this.usesLocalReadState(chatType) && (await this.saveLocalRead(target, sequence));
    if (this.localOptions?.readOnly) return local;
    const written = { ...target, version };
    try {
      const changed = await this.writeTarget(target, version, () =>
        this.session.unreadInfo.markRead(chatType, uid, sequence),
      );
      const cached = this.results.get(this.key(target));
      const through = BigInt(sequence);
      // QQ 可能已经更新过该行；即使无需写入，也要校准仍挂着旧提醒的缓存。
      const stale =
        cached &&
        (cached.markUnread ||
          (cached.unreadCount && BigInt(cached.readSeq ?? '0') < through) ||
          cached.highlights?.some((hit) => BigInt(hit.msgSeq) <= through));
      if (changed || (changed === false && stale)) await this.refreshWrittenTargets([written]);
      else if (changed === false) this.invalidate();
      return changed === true || local;
    } catch {
      this.queueWrite(target, version, async () => {
        const changed = await this.writeTarget(target, version, () =>
          this.session.unreadInfo.setReadState(chatType, uid, sequence, sequence, false),
        );
        if (changed) await this.refreshWrittenTargets([written]);
      });
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
    const sequence = await this.readSequence(chatType, uid, latestSeq);
    if (sequence === undefined || this.generation !== generation)
      return { changed: false, report: { state: 'skipped' } };
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
    if (seq > 0xffffffffn) return finish({ state: 'skipped' });
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
