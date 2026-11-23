import type { AccountSession } from '@weq/account';
import { classifyChatType, isDatalineSelfUid, isDatalineUid } from '@weq/codec';
import { MsgType } from '@weq/codec/proto/msg/40900';
import { measureMessageWork, withDatabasePriority, type DatabasePriority } from '@weq/db';
import type { NtHelperBinding } from '@weq/native';
import {
  ReportRead,
  readReportWatermark,
  type ReadReportParams,
  type ReadReportTarget,
} from '@weqbot/protocol';
import {
  messageReadCursor,
  messageReadPosition,
  newerReadPosition,
  validReadPosition,
} from '../common/client_preferences';
import { resolveC2cPartition } from './c2c_partition';
import { queueSsoWork, ssoWorkState } from './sso_lifecycle';
import { LocalUnreadStore, type ResolvedUnreadInfo, validDeviceReadPosition } from './local_unread';
import type { NewMessages } from './nt_msg_hook';
import type { DbChange } from './db_watch';
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
import type { RecallArchive } from './recall_archive';
import { sameUnreadSequences, sameUnreadSnapshot } from './unread_snapshot_equal';

export interface UnreadSequenceRange {
  peer: string;
  kind: 'c2c' | 'group';
  conv: string;
  after: bigint;
  through: bigint;
}

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
  onAcknowledged?(target: ReadReportParams): void;
}

interface PendingReport {
  target: ReadReportTarget;
  pid: number;
  owner: object | undefined;
  promise: Promise<ReadReportStatus>;
  valid?: () => boolean;
}

interface ManualReadEntry extends UnreadInfoTarget {
  change?: ManualReadChange;
  readSeq: string;
  throughSeq: string;
  devicePosition?: string;
  database?: UnreadReadChange;
  version: number;
}

const UNREAD_POLL_MS = 1500;
const WATCHED_UNREAD_RECONCILE_MS = 6000;
const FILE_SNAPSHOT_MIN_INTERVAL_MS = 750;
const CHANGE_COALESCE_MS = 50;

export class UnreadInfoService {
  private readonly local: LocalUnreadStore;
  private readonly important: ImportantMessageStore;
  private disposed = false;
  private readonly reads = new AbortController();
  private readonly snapshots = new Map<string, UnreadInfoSnapshot>();
  private readonly results = new Map<string, ResolvedUnreadInfo>();
  private readonly targets = new Map<string, UnreadInfoTarget>();
  private readonly confirmedSent = new Map<string, string[]>();
  private readonly archivedRecalls = new Map<string, string[]>();
  private readonly sequenceRefreshes = new Map<string, symbol>();
  private loading?: Promise<void>;
  private updatedAt = 0;
  private lastReadStartedAt = Number.NEGATIVE_INFINITY;
  private dirty = true;
  private immediateChange = true;
  private messageFileWatch?: symbol;
  private readonly observedFiles = new WeakSet<DbChange>();
  private refreshTimer?: ReturnType<typeof setInterval>;
  private changeTimer?: ReturnType<typeof setTimeout>;
  private changeDueAt = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private readonly writes = new Map<string, () => Promise<void>>();
  private readonly writeTasks = new Map<string, Promise<unknown>>();
  private readonly targetVersions = new Map<string, number>();
  private generation = 0;
  private readonly pending = new Map<string, PendingReport>();
  private readonly confirmed = new Map<
    string,
    { pid: number; owner: object | undefined; watermark: number }
  >();
  private lastReport: ReadReportStatus = { state: 'disabled' };
  private readonly readHistory = new Map<string, ManualReadEntry[]>();
  private readonly countListeners = new Set<(targets: UnreadInfoTarget[]) => void>();
  private manualRevision = 0;
  private localResetRevision = 0;

  constructor(
    private readonly session: AccountSession,
    private readonly report?: ReadReportOptions,
    private readonly localOptions?: {
      statePath: string;
      readOnly?: boolean;
      unreadSentSequences?: (ranges: UnreadSequenceRange[]) => Promise<Map<string, string[]>>;
      recallArchive?: Pick<RecallArchive, 'unreadRecalledSequences'>;
    },
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
        if (
          this.messageFileWatch &&
          (this.changeTimer ||
            (!this.dirty && Date.now() - this.updatedAt < WATCHED_UNREAD_RECONCILE_MS))
        )
          return;
        void this.refreshSnapshots('background').catch(() => {});
      }, UNREAD_POLL_MS);
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

  /** 同一文件已有独立事件与轮询时，未读订阅只保留低频全量对账。 */
  attachMessageFileWatch(): () => void {
    const watch = Symbol();
    this.messageFileWatch = watch;
    return () => {
      if (this.messageFileWatch !== watch) return;
      this.messageFileWatch = undefined;
      this.invalidate();
    };
  }

  /** 本地写入后的校准优先于后台文件事件。 */
  invalidate(): void {
    if (this.disposed) return;
    this.dirty = true;
    this.immediateChange = true;
    this.scheduleSnapshot();
  }

  /** 同一次库文件变化和它衍生的消息通知共用一个刷新。 */
  invalidateMessageFile(change: DbChange): void {
    if (this.disposed || this.observedFiles.has(change)) return;
    this.observedFiles.add(change);
    this.dirty = true;
    this.scheduleSnapshot();
  }

  private scheduleSnapshot(): void {
    if (this.disposed || !this.dirty || !this.countListeners.size || this.loading) return;
    const now = performance.now();
    const due = this.immediateChange
      ? now + CHANGE_COALESCE_MS
      : Math.max(now + CHANGE_COALESCE_MS, this.lastReadStartedAt + FILE_SNAPSHOT_MIN_INTERVAL_MS);
    if (this.changeTimer && this.changeDueAt <= due) return;
    clearTimeout(this.changeTimer);
    this.changeDueAt = due;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      if (this.dirty)
        void this.refreshSnapshots(this.immediateChange ? 'interactive' : 'background').catch(
          () => {},
        );
    }, due - now);
    this.changeTimer.unref?.();
  }

  async observeNewMessages(change: NewMessages): Promise<void> {
    this.invalidateMessageFile(change.file);
  }

  /** 发送缓存写入后，即使 QQ 小表未变也重算对应会话。 */
  invalidateSent(kind: 'c2c' | 'group', uid: string): void {
    if (this.localOptions?.unreadSentSequences) this.invalidateSequences(kind, uid);
  }

  /** 代理可能保留 QQ 原文，只更新独立留存库。 */
  invalidateRecall(kind: 'c2c' | 'group', uid: string): void {
    if (this.localOptions?.recallArchive) this.invalidateSequences(kind, uid);
  }

  private invalidateSequences(kind: 'c2c' | 'group', uid: string): void {
    if (this.disposed) return;
    this.sequenceRefreshes.set(this.key({ chatType: kind === 'group' ? 2 : 1, uid }), Symbol());
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
    await this.project(targets);
    this.publish(targets);
    await this.local.flush();
    this.invalidate();
  }

  getUnreadInfo(chatType: number, uid: string): Promise<UnreadInfoResult | null> {
    return this.session.unreadInfo.getUnreadInfo(chatType, uid);
  }

  /** 视口可能从引用、搜索或提醒跳到后面，只确认从现有水位起连续看到的消息。 */
  async visibleReadSequence(chatType: number, uid: string, visibleSeqs: readonly string[]) {
    if (chatType !== 1 && chatType !== 2) return undefined;
    const [snapshot] = await this.getUnreadInfos([{ chatType, uid }]);
    if (!snapshot?.readSeq || !snapshot.latestSeq || snapshot.readError) return undefined;
    const floor = BigInt(snapshot.readSeq);
    const latest = BigInt(snapshot.latestSeq);
    if (floor <= 0n) return undefined;
    const visible = new Set(visibleSeqs);
    if (floor >= latest) {
      // 同一水位的手动未读可在重新看到最新消息时取消。
      return snapshot.unreadCount && visible.has(snapshot.latestSeq)
        ? snapshot.latestSeq
        : undefined;
    }
    const excluded = new Set([...(snapshot.decreasedSeqs ?? []), ...(snapshot.recalledSeqs ?? [])]);
    let through: string | undefined;
    for (let seq = floor + 1n; seq <= latest; seq++) {
      const position = seq.toString();
      if (visible.has(position)) through = position;
      else if (!excluded.has(position)) break;
    }
    return through;
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
    return this.resolve({ ...snapshot, latestSeq: snapshot.latestSeq ?? latestSeq ?? null })
      .unreadCount;
  }

  async getDeviceReadSnapshot(target: UnreadInfoTarget): Promise<ResolvedUnreadInfo> {
    if (
      this.disposed ||
      classifyChatType(target.chatType) !== 'dataline' ||
      !isDatalineUid(target.uid)
    )
      return this.missing(target);
    const [snapshot] = await withDatabasePriority(
      'interactive',
      () => this.session.unreadInfo.getUnreadInfos([target]),
      this.reads.signal,
    );
    if (!snapshot || this.disposed) return this.missing(target);
    return snapshot;
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
      (!this.countListeners.size && (this.dirty || Date.now() - this.updatedAt >= UNREAD_POLL_MS))
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

  private async project(targets: UnreadInfoTarget[]): Promise<void> {
    const revision = this.manualRevision;
    await Promise.all(
      targets.map(async (target) => {
        const row = this.snapshots.get(this.key(target));
        if (!row || row.readError) return;
        try {
          const count = this.isDeviceSnapshot(row) ? await this.countDeviceUnread(row) : undefined;
          if (
            !this.disposed &&
            revision === this.manualRevision &&
            this.snapshots.get(row.peer) === row
          )
            this.results.set(row.peer, this.resolve(row, count));
        } catch {
          this.invalidate();
        }
      }),
    );
  }

  private isDeviceSnapshot(row: UnreadInfoSnapshot): boolean {
    return (
      classifyChatType(row.chatType) === 'dataline' &&
      isDatalineUid(row.uid) &&
      !isDatalineSelfUid(row.uid)
    );
  }

  private async countDeviceUnread(
    row: UnreadInfoSnapshot,
    priority: DatabasePriority = 'interactive',
  ): Promise<number> {
    const through = row.deviceLatest;
    if (!through) return 0;
    const after = this.local.deviceReadFloor(row);
    if (!newerReadPosition(through, after)) return 0;
    return withDatabasePriority(
      priority,
      () => this.session.unreadInfo.countDeviceIncoming(row, after, through),
      this.reads.signal,
    );
  }

  private resolve(row: UnreadInfoSnapshot, deviceCount?: number): ResolvedUnreadInfo {
    const archived = this.archivedRecalls.get(row.peer);
    const snapshot = archived
      ? { ...row, recalledSeqs: [...new Set([...(row.recalledSeqs ?? []), ...archived])] }
      : row;
    return this.local.resolve(snapshot, this.confirmedSent.get(row.peer), deviceCount);
  }

  private async applySnapshots(
    rows: UnreadInfoSnapshot[],
    accepts: (row: UnreadInfoSnapshot) => boolean,
    priority: DatabasePriority = 'interactive',
  ): Promise<void> {
    const versions = new Map(rows.map(({ peer }) => [peer, this.sequenceRefreshes.get(peer)]));
    const ranges: UnreadSequenceRange[] = [];
    const readSent = this.localOptions?.unreadSentSequences;
    const archive = this.localOptions?.recallArchive;
    if (readSent || archive) {
      for (const { chatType, uid, peer, msgSeq, localReadSeq, latestSeq } of rows) {
        if ((chatType !== 1 && chatType !== 2) || latestSeq === null) continue;
        const serverRead = BigInt(msgSeq ?? 0);
        const localRead = BigInt(localReadSeq ?? '0');
        const after = serverRead > localRead ? serverRead : localRead;
        const through = BigInt(latestSeq);
        if (after > 0n && through > after)
          ranges.push({ peer, kind: chatType === 1 ? 'c2c' : 'group', conv: uid, after, through });
      }
    }
    const empty = new Map<string, string[]>();
    const [sent, recalled] = ranges.length
      ? await withDatabasePriority(
          priority,
          () =>
            Promise.all([
              readSent ? readSent(ranges).catch(() => undefined) : empty,
              archive ? archive.unreadRecalledSequences(ranges).catch(() => undefined) : empty,
            ]),
          this.reads.signal,
        )
      : [empty, empty];
    const counts = await Promise.all(
      rows.map((row) =>
        this.isDeviceSnapshot(row)
          ? this.countDeviceUnread(row, priority).catch(() => null)
          : undefined,
      ),
    );
    if (this.disposed) return;
    const pending = new Set(sent && recalled ? [] : ranges.map(({ peer }) => peer));
    const changed: UnreadInfoTarget[] = [];
    for (const [index, row] of rows.entries()) {
      if (!accepts(row) || versions.get(row.peer) !== this.sequenceRefreshes.get(row.peer))
        continue;
      const count = counts[index];
      if (count === null) continue;
      const retry = pending.has(row.peer);
      if (retry) this.sequenceRefreshes.set(row.peer, Symbol());
      else this.sequenceRefreshes.delete(row.peer);
      if (sent || !retry) {
        const sequences = sent?.get(row.peer);
        if (sequences?.length) this.confirmedSent.set(row.peer, sequences);
        else this.confirmedSent.delete(row.peer);
      }
      if (recalled || !retry) {
        const sequences = recalled?.get(row.peer);
        if (sequences?.length) this.archivedRecalls.set(row.peer, sequences);
        else this.archivedRecalls.delete(row.peer);
      }
      const previous = this.results.get(row.peer);
      const result = this.resolve(row, count);
      if (
        previous?.unreadCount === result.unreadCount &&
        previous?.readSeq === result.readSeq &&
        sameUnreadSequences(previous?.recalledSeqs, result.recalledSeqs) &&
        sameUnreadSnapshot(this.snapshots.get(row.peer), row)
      )
        continue;
      this.important.observe(row);
      this.snapshots.set(row.peer, row);
      this.results.set(row.peer, result);
      changed.push(row);
    }
    this.publish(changed);
  }

  private async refreshSnapshots(priority: DatabasePriority = 'interactive'): Promise<void> {
    if (this.disposed) return;
    if (this.loading) return this.loading;
    const revision = this.manualRevision;
    const began = performance.now();
    clearTimeout(this.changeTimer);
    this.changeTimer = undefined;
    this.lastReadStartedAt = began;
    this.dirty = false;
    this.immediateChange = false;
    this.loading = measureMessageWork(this.session.msgDbPath, 'watermarks', async () => {
      let failed = false;
      try {
        const rows = await withDatabasePriority(
          priority,
          async () => {
            this.reads.signal.throwIfAborted();
            return typeof this.session.unreadInfo.getAllUnreadInfos === 'function'
              ? this.session.unreadInfo.getAllUnreadInfos()
              : this.session.unreadInfo.getUnreadInfos([...this.targets.values()]);
          },
          this.reads.signal,
        );
        if (this.disposed) return;
        if (revision !== this.manualRevision) {
          this.invalidate();
          return;
        }
        await measureMessageWork(this.session.msgDbPath, 'unreadSnapshotApply', async () => {
          const present = new Set(rows.map((row) => row.peer));
          // 两张小表均无行也是有效快照；目录中缺行的目标不能让每次读取都重查全库。
          for (const [peer, target] of this.targets)
            if (!present.has(peer)) rows.push({ ...target, peer, latestSeq: null });
          await this.applySnapshots(
            rows.filter(
              (row) =>
                !row.readError &&
                (this.sequenceRefreshes.has(row.peer) ||
                  this.isDeviceSnapshot(row) ||
                  !sameUnreadSnapshot(this.snapshots.get(row.peer), row)),
            ),
            () => revision === this.manualRevision,
            priority,
          );
        });
        if (revision !== this.manualRevision) {
          this.invalidate();
          return;
        }
        this.updatedAt = Date.now();
        void this.local.flush().catch((error) => console.error('[unread] 操作保存失败', error));
        void this.important
          .flush()
          .catch((error) => console.error('[unread] 重要消息保存失败', error));
      } catch (error) {
        failed = true;
        this.dirty = true;
        throw error;
      } finally {
        this.loading = undefined;
        if (!failed) this.scheduleSnapshot();
      }
    });
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
      await this.applySnapshots(
        rows.filter((row) => !row.readError),
        (row) => {
          const previous = before.get(row.peer);
          return (
            previous !== undefined &&
            previous.version === this.targetVersions.get(row.peer) &&
            previous.snapshot === this.snapshots.get(row.peer)
          );
        },
      );
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

  async markLocalRead(
    chatType: number,
    uid: string,
    latestSeq?: string,
    devicePosition?: string,
  ): Promise<boolean> {
    if (devicePosition !== undefined)
      return (await this.markDeviceConversationRead(chatType, uid, devicePosition)).changed;
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
      await this.project([target]);
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
      const snapshot = this.resolve(raw);
      const throughSeq = snapshot.latestSeq ?? snapshot.readSeq ?? '0';
      return {
        chatType: snapshot.chatType,
        uid: snapshot.uid,
        change: this.usesLocalReadState(snapshot.chatType)
          ? this.local.setManualRead(snapshot, unread)
          : undefined,
        readSeq: unread ? (snapshot.readSeq ?? '0') : throughSeq,
        throughSeq,
        devicePosition: snapshot.deviceLatest,
        version: this.bumpTarget(snapshot),
      };
    });
    const local = changes.filter((row) => row.change);
    await this.project(local);
    this.publish(local);
    await this.local.flush();
    for (const row of changes) {
      if (
        this.disposed ||
        this.localOptions?.readOnly ||
        resetRevision !== this.localResetRevision ||
        (classifyChatType(row.chatType) === 'dataline' && isDatalineUid(row.uid))
      )
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

  private async restoreLocalRead(row: ManualReadEntry) {
    if (!row.change || !this.local.restoreManualRead(row.chatType, row.uid, row.change)) return;
    this.manualRevision++;
    await this.project([row]);
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
            await this.restoreLocalRead(row);
            await this.local.flush();
            await this.refreshWrittenTargets([{ ...row, version }]);
          });
          pending++;
          continue;
        }
      }
      if (resetRevision !== this.localResetRevision) throw new Error('撤销记录已失效');
      if (this.targetVersions.get(this.key(row)) !== version) continue;
      await this.restoreLocalRead(row);
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
        if (row.devicePosition) {
          if (!undo) await this.reportDeviceRead(row.chatType, row.uid, row.devicePosition, true);
          continue;
        }
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
    options?: { manual?: boolean; write?: false; devicePosition?: string },
  ): Promise<{ changed: boolean; report: ReadReportStatus }> {
    if (classifyChatType(chatType) === 'dataline' && isDatalineUid(uid)) {
      if (options?.write !== false && options?.devicePosition)
        return this.markDeviceConversationRead(chatType, uid, options.devicePosition);
      const changed =
        options?.write !== false && (await this.markLocalRead(chatType, uid, latestSeq));
      return { changed, report: { state: 'skipped' } };
    }
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
      const complete = (status: ReadReportStatus) => {
        if (status.state === 'acknowledged' && !this.disposed && this.generation === generation)
          this.report?.onAcknowledged?.(target);
        return finish(status);
      };
      if (manual) return complete(await report);
      void report.then(complete, () => {
        finish({ state: 'failed', sequence });
      });
      return result;
    } catch {
      return finish({ state: 'failed', sequence });
    }
  }

  private async markDeviceConversationRead(
    chatType: number,
    uid: string,
    position: string,
  ): Promise<{ changed: boolean; report: ReadReportStatus }> {
    const skipped = { changed: false, report: { state: 'skipped' as const } };
    if (
      !isDatalineUid(uid) ||
      classifyChatType(chatType) !== 'dataline' ||
      !validDeviceReadPosition(position)
    )
      return skipped;
    const resetRevision = this.localResetRevision;
    const generation = this.generation;
    const target = { chatType, uid };
    let snapshot = (await this.getUnreadInfos([target]))[0];
    if (!snapshot?.deviceLatest || newerReadPosition(position, snapshot.deviceLatest))
      snapshot = await this.getDeviceReadSnapshot(target);
    if (
      snapshot?.readError ||
      !snapshot?.deviceLatest ||
      newerReadPosition(position, snapshot.deviceLatest)
    )
      return skipped;
    if (position !== snapshot.deviceLatest) {
      const cursor = messageReadCursor(position);
      const rows = await this.session.datalineMsgs.calendarMessage({ uid }, cursor.msgId);
      if (
        !rows.some(
          (row) =>
            row.sendTime === cursor.sendTime &&
            row.senderUid === uid &&
            !isDatalineSelfUid(row.senderUid) &&
            row.msgType !== BigInt(MsgType.GRAY_TIP),
        )
      )
        return skipped;
    }
    if (
      this.disposed ||
      resetRevision !== this.localResetRevision ||
      generation !== this.generation
    )
      return skipped;
    const changed = this.local.markDeviceRead(snapshot, position);
    if (changed) {
      this.manualRevision++;
      await this.project([target]);
      this.publish([target]);
      await this.local.flush();
    }
    if (this.localOptions?.readOnly) return { changed, report: { state: 'unavailable' } };
    if (!this.reportEnabled(false)) return { changed, report: { state: 'disabled' } };
    if (!this.local.isDeviceReadCurrent(chatType, uid, position))
      return { changed, report: { state: 'skipped' } };
    void this.reportDeviceRead(chatType, uid, position, false);
    return { changed, report: { state: 'pending', sequence: '0' } };
  }

  private async reportDeviceRead(
    chatType: number,
    uid: string,
    position: string,
    manual: boolean,
  ): Promise<void> {
    const targetUid = this.session.selfUid;
    if (this.localOptions?.readOnly || !targetUid || !validDeviceReadPosition(position)) return;
    const timestamp = Number(messageReadCursor(position).sendTime);
    if (timestamp > 0xffffffff) return;
    const current = () => !this.disposed && this.local.isDeviceReadCurrent(chatType, uid, position);
    if (!current()) return;
    const status = await this.reportTarget(
      `dataline:${manual ? 'manual:' : ''}${chatType}_${uid}`,
      { kind: 'dataline', targetUid, sequence: 0, timestamp },
      manual,
      current,
    );
    // 已取得上报回包样本，运行中 QQ 消费的推送尚未确认。
    if (current()) this.lastReport = status;
  }

  /** 公众号零序号阅读使用实际消息时间，上报确认后通知本机代理。 */
  async reportOfficialRead(
    uid: string,
    position: string,
    valid: () => boolean,
    manual = false,
  ): Promise<ReadReportStatus> {
    if (this.localOptions?.readOnly || this.disposed || !valid()) return { state: 'unavailable' };
    if (!this.reportEnabled(manual)) return { state: 'disabled' };
    if (
      !/^u_[A-Za-z0-9_-]+$/.test(uid) ||
      !validReadPosition(position) ||
      !position.startsWith('0:')
    )
      return { state: 'skipped' };
    const cursor = messageReadCursor(position);
    const timestamp = Number(cursor.sendTime);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > 0xffffffff)
      return { state: 'skipped' };
    const generation = this.generation;
    const pid = this.report!.resolvePid();
    if (pid === null) return { state: 'unavailable' };
    const owner = ssoWorkState(this.report!.nt, pid).owner;
    try {
      const rows = await this.session.c2cMsgs.calendarMessage(
        await resolveC2cPartition(this.session.uidMap, uid),
        cursor.msgId,
      );
      if (!rows.some((row) => messageReadPosition(row) === position)) return { state: 'skipped' };
      const current = () =>
        valid() &&
        this.generation === generation &&
        this.report!.resolvePid() === pid &&
        ssoWorkState(this.report!.nt, pid).owner === owner;
      if (!current()) return { state: 'unavailable' };
      const target = { kind: 'official', targetUid: uid, sequence: 0, timestamp } as const;
      const status = await this.reportTarget(
        `${manual ? 'manual:' : ''}103_${uid}`,
        target,
        manual,
        current,
      );
      if (!this.disposed && current()) {
        this.lastReport = status;
        if (status.state === 'acknowledged') this.report?.onAcknowledged?.(target);
      }
      return status;
    } catch {
      return { state: 'failed' };
    }
  }

  private reportTarget(
    key: string,
    target: ReadReportTarget,
    manual = false,
    valid?: () => boolean,
  ): Promise<ReadReportStatus> {
    const options = this.report!;
    const pid = options.resolvePid();
    if (pid === null || this.disposed || !this.reportEnabled(manual) || valid?.() === false)
      return Promise.resolve({ state: 'unavailable' });
    const owner = ssoWorkState(options.nt, pid).owner;
    const generation = this.generation;
    const prior = this.confirmed.get(key);
    if (
      prior?.pid === pid &&
      prior.owner === owner &&
      prior.watermark >= readReportWatermark(target)
    )
      return Promise.resolve({
        state: 'acknowledged',
        sequence: String(target.sequence === 0 ? 0 : prior.watermark),
      });
    const active = this.pending.get(key);
    if (active) {
      if (active.pid !== pid || active.owner !== owner)
        return Promise.resolve({ state: 'unavailable' });
      if (readReportWatermark(target) >= readReportWatermark(active.target)) {
        active.target = target;
        active.valid = valid;
      }
      return active.promise;
    }
    if (this.pending.size >= 256) return Promise.resolve({ state: 'unavailable' });
    const entry: PendingReport = {
      target,
      pid,
      owner,
      valid,
      promise: Promise.resolve({ state: 'unavailable' }),
    };
    const current = () =>
      !this.disposed &&
      this.generation === generation &&
      this.reportEnabled(manual) &&
      entry.valid?.() !== false &&
      options.resolvePid() === pid &&
      ssoWorkState(options.nt, pid).owner === owner;
    entry.promise = (async () => {
      // 先进入微任务，确保 pending 在任何同步结束的路径前已登记。
      await Promise.resolve();
      while (current()) {
        const requested = entry.target;
        const requestedValid = entry.valid;
        let state: ReadReportState = 'failed';
        for (let attempt = 0; attempt < 3 && current(); attempt++) {
          try {
            state = await queueSsoWork(options.nt, pid, async () => {
              if (
                !current() ||
                requestedValid?.() === false ||
                !(await options.nt.hasSsoSession(pid)) ||
                !current() ||
                requestedValid?.() === false
              )
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
          this.confirmed.set(key, { pid, owner, watermark: readReportWatermark(requested) });
        }
        if (readReportWatermark(entry.target) > readReportWatermark(requested)) continue;
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
