import { randomUUID } from 'node:crypto';
import type { BadPageScanReport } from '../bad_pages';
import { DatabaseScanUnsupportedError, type DbRepairCheckupIntegrity } from './checkup';
import { DatabaseProgressTracker, type DatabaseWorkProgress } from './progress';
import type { DbRepairProgress, DbRepairRecord, DbRepairTarget } from './types';
import type {
  DatabaseMaintenanceReportHeader,
  DatabaseMaintenanceReports,
} from './maintenance_reports';
import { DbRepairError } from './service';
import {
  databaseCanCheckQuickRepair,
  databaseReadyForRepair,
  databaseNeedsPageLocation,
  databaseRepairRecommendation,
  type DatabasePageLocation,
  type DatabaseRepairMethod,
  summarizeDatabaseMaintenance,
  type DatabaseMaintenanceRow,
  type DatabaseMaintenanceScope,
  type DatabaseMaintenanceSnapshot,
  type DatabaseMaintenanceStatus,
  type DatabaseMaintenanceReport,
  type DatabaseMaintenanceOperation,
} from './maintenance_types';

export interface DatabaseMaintenanceLease {
  id?: string;
  release(): void | Promise<void>;
  acquireMore?(targets: DbRepairTarget[], signal: AbortSignal): Promise<void>;
  /** 锁内无法合并的 WAL 等逐库问题，不把主文件扫描冒充完整扫描。 */
  errors?: Record<string, string>;
  signal?: AbortSignal;
}
export interface DatabaseMaintenanceDeps {
  sourceIdentity?(target: DbRepairTarget): string;
  acquire(targets: DbRepairTarget[], signal: AbortSignal): Promise<DatabaseMaintenanceLease>;
  scan(
    target: DbRepairTarget,
    signal: AbortSignal,
    progress: (tick: DatabaseWorkProgress) => void,
  ): Promise<BadPageScanReport>;
  locate?(
    target: DbRepairTarget,
    scan: BadPageScanReport,
    signal: AbortSignal,
    progress: (tick: DatabaseWorkProgress) => void,
    quickOnly?: true,
  ): Promise<DatabasePageLocation>;
  deep(
    target: DbRepairTarget,
    signal: AbortSignal,
    progress: (tick: DatabaseWorkProgress) => void,
  ): Promise<DbRepairCheckupIntegrity>;
  repair(
    target: DbRepairTarget,
    scan: BadPageScanReport,
    signal: AbortSignal,
    progress: (tick: DbRepairProgress) => void,
    options: {
      backup?: boolean;
      strictPages?: boolean;
      allowLowSpace?: boolean;
      maintenanceId?: string;
      method?: DatabaseRepairMethod;
      quickBudgetBytes?: number;
    },
  ): Promise<DbRepairRecord>;
  reports(scope: DatabaseMaintenanceScope): DatabaseMaintenanceReports;
  changed?(snapshot: DatabaseMaintenanceStatus): void;
}
interface RepairBatchOptions {
  backup?: boolean;
  backups?: Record<string, boolean>;
  strictPages?: boolean;
  allowLowSpace?: boolean;
  methods?: Record<string, DatabaseRepairMethod>;
}
interface Session {
  snapshot: DatabaseMaintenanceSnapshot;
  targets: DbRepairTarget[];
  sourceIdentities: Map<string, string>;
  lease?: DatabaseMaintenanceLease;
  abort?: AbortController;
  pending?: Promise<DatabaseMaintenanceSnapshot>;
  scanQueue?: DbRepairTarget[][];
  lastSaved: number;
  lastPublished: number;
  publishTimer?: ReturnType<typeof setTimeout>;
  preparation?: DatabaseProgressTracker;
  finalizedReportId?: string;
  ending?: Promise<void>;
  unsavedReports: Map<string, DatabaseMaintenanceReport>;
}
const keyFor = (scope: DatabaseMaintenanceScope) =>
  JSON.stringify([scope.uin, scope.configId ?? null]);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const progressPublishIntervalMs = 1000;
const pendingRow = ({ dbName }: DbRepairTarget): DatabaseMaintenanceRow => ({
  dbName,
  scanStatus: 'pending',
  support: 'possible',
  issues: [],
});

/** 维护的生命周期属于宿主，不属于窗口；每次执行各自留一份不可覆盖的历史结果。 */
export class DatabaseMaintenance {
  private readonly sessions = new Map<string, Session>();
  private readonly reportWrites = new WeakMap<Session['unsavedReports'], Promise<void>>();
  constructor(private readonly deps: DatabaseMaintenanceDeps) {}

  leaseId(scope: DatabaseMaintenanceScope): string | undefined {
    const session = this.sessions.get(keyFor(scope));
    return session?.snapshot.locked && !session.lease?.signal?.aborted
      ? session.lease?.id
      : undefined;
  }

  current(scope: DatabaseMaintenanceScope): DatabaseMaintenanceSnapshot | null {
    const session = this.sessions.get(keyFor(scope));
    const snapshot = session?.snapshot;
    return snapshot ? structuredClone(snapshot) : null;
  }
  status(scope: DatabaseMaintenanceScope): DatabaseMaintenanceStatus | null {
    const snapshot = this.sessions.get(keyFor(scope))?.snapshot;
    return snapshot ? structuredClone(summarizeDatabaseMaintenance(snapshot)) : null;
  }
  active(): DatabaseMaintenanceStatus[] {
    return [...this.sessions.values()]
      .filter((session) => session.snapshot.state !== 'ended')
      .map((session) => structuredClone(summarizeDatabaseMaintenance(session.snapshot)));
  }
  async reports(scope: DatabaseMaintenanceScope): Promise<DatabaseMaintenanceReportHeader[]> {
    const session = this.sessions.get(keyFor(scope));
    if (session) void this.flushReports(session);
    const saved = new Map(
      (await this.deps.reports(scope).list()).map((report) => [report.operation.id, report]),
    );
    for (const [id, { uin, configId, operation }] of this.sessions.get(keyFor(scope))
      ?.unsavedReports ?? [])
      saved.set(id, { uin, configId, operation });
    return [...saved.values()]
      .sort((a, b) => b.operation.startedAt - a.operation.startedAt)
      .map((report) => ({ ...report, operation: this.reportOperation(scope, report.operation) }));
  }

  async report(
    scope: DatabaseMaintenanceScope,
    id: string,
  ): Promise<DatabaseMaintenanceReport | null> {
    const session = this.sessions.get(keyFor(scope));
    const current = session?.snapshot;
    if (current?.operation?.id === id && current.operation.status === 'running')
      return structuredClone({ ...current, operation: current.operation });
    const pending = session?.unsavedReports.get(id);
    if (pending && session) void this.flushReports(session);
    const report = pending ? structuredClone(pending) : await this.deps.reports(scope).get(id);
    if (!report) return null;
    const operation = this.reportOperation(scope, report.operation);
    return operation.status === 'interrupted'
      ? { ...report, operation, state: 'ended', locked: false }
      : { ...report, operation };
  }

  private reportOperation(scope: DatabaseMaintenanceScope, saved: DatabaseMaintenanceOperation) {
    if (saved.status !== 'running') return saved;
    const active = this.sessions.get(keyFor(scope))?.snapshot.operation;
    return active?.id === saved.id
      ? { ...active }
      : {
          ...saved,
          status: 'interrupted' as const,
          finishedAt: saved.startedAt + saved.elapsedMs,
        };
  }

  async deleteReport(scope: DatabaseMaintenanceScope, id: string): Promise<boolean> {
    const session = this.sessions.get(keyFor(scope));
    const operation = session?.snapshot.operation;
    if (operation?.id === id && operation.status === 'running')
      throw new Error('这份报告仍在更新，请暂停体检或等待执行结束后再删除。');
    const queue = session?.unsavedReports;
    const pending = queue?.delete(id) ?? false;
    // 正在写的同一份报告先原子落盘，再删除，避免迟到的 rename 恢复已删除的报告。
    if (queue) await this.reportWrites.get(queue);
    return (await this.deps.reports(scope).remove(id)) || pending;
  }

  scan(
    scope: DatabaseMaintenanceScope,
    targets: DbRepairTarget[],
    kind: 'scan' | 'checkup',
    requestedNames?: string[],
  ): Promise<DatabaseMaintenanceSnapshot> {
    let session = this.sessions.get(keyFor(scope));
    if (session?.ending || session?.snapshot.state === 'ending')
      throw new Error('正在结束本次维护，请等待数据库解锁。');
    if (session?.pending) throw new Error('数据库维护任务正在执行，请先停止当前操作。');
    if (session?.lease?.signal?.aborted)
      throw new Error('持续维护锁已中断，请先结束维护并重新体检。');
    if (requestedNames && !session?.snapshot.locked)
      throw new Error('本轮维护已结束，请刷新后开始体检。');
    const existing = session?.targets ?? [];
    const added = requestedNames
      ? targets.filter(
          (target) =>
            requestedNames.includes(target.dbName) &&
            !existing.some((row) => row.dbName === target.dbName || row.dbPath === target.dbPath),
        )
      : [];
    if (added.length && !session?.lease?.acquireMore)
      throw new Error('本轮无法追加数据库，请刷新维护状态后重试。');
    const newTargets = requestedNames
      ? added
      : !session || session.snapshot.state === 'ended'
        ? targets
        : [];
    const paths = new Set(newTargets.map((target) => target.dbPath));
    if (
      [...this.sessions.values()].some(
        (other) =>
          other !== session &&
          other.snapshot.state !== 'ended' &&
          [...other.targets, ...(other.scanQueue?.flat() ?? [])].some((target) =>
            paths.has(target.dbPath),
          ),
      )
    )
      throw new Error(
        requestedNames ? '所选数据库正在另一个维护会话中使用。' : '此账号的数据源已经在维护中。',
      );
    if (!session || session.snapshot.state === 'ended') {
      if (!targets.length) throw new Error('没有可体检的数据库。');
      session = {
        snapshot: {
          ...scope,
          id: randomUUID(),
          state: 'locking',
          locked: false,
          databases: targets.map(pendingRow),
        },
        targets: [...targets],
        sourceIdentities: new Map(),
        lastSaved: 0,
        lastPublished: 0,
        unsavedReports: session?.unsavedReports ?? new Map(),
      };
      this.sessions.set(keyFor(scope), session);
    }
    const current = session;
    const selected = requestedNames
      ? [...current.targets, ...added].filter((target) => requestedNames.includes(target.dbName))
      : [...current.targets];
    if (!selected.length) throw new Error('请选择要体检的数据库。');
    current.scanQueue = [selected];
    this.begin(
      current,
      kind,
      selected.length,
      requestedNames ? selected.map((target) => target.dbName) : undefined,
    );
    current.pending = this.scanSession(current, kind, current.scanQueue).finally(() => {
      current.scanQueue = undefined;
      current.pending = undefined;
    });
    return current.pending;
  }

  appendScan(
    scope: DatabaseMaintenanceScope,
    operationId: string,
    targets: DbRepairTarget[],
    names: string[],
  ): void {
    const session = this.sessions.get(keyFor(scope));
    const operation = session?.snapshot.operation;
    const queue = session?.scanQueue;
    if (
      !session ||
      !queue ||
      session.ending ||
      session.snapshot.maintenanceError ||
      session.abort?.signal.aborted ||
      operation?.id !== operationId ||
      operation.status !== 'running'
    )
      throw new Error('本次体检已停止或完成，请重新选择要体检的数据库。');

    const queued = queue.flat();
    const batch = [...session.targets, ...targets].filter(
      (target) =>
        names.includes(target.dbName) &&
        !queued.some((item) => item.dbName === target.dbName || item.dbPath === target.dbPath),
    );
    if (!batch.length) return;
    if (
      [...this.sessions.values()].some(
        (other) =>
          other !== session &&
          other.snapshot.state !== 'ended' &&
          [...other.targets, ...(other.scanQueue?.flat() ?? [])].some((target) =>
            batch.some((item) => item.dbPath === target.dbPath),
          ),
      )
    )
      throw new Error('所选数据库正在另一个维护会话中使用。');

    queue.push(batch);
    operation.databaseNames = [...queued, ...batch].map(({ dbName }) => dbName);
    operation.totalDatabases = operation.databaseNames.length;
    this.publishStatus(session);
  }

  private async scanSession(
    session: Session,
    kind: 'scan' | 'checkup',
    queue: DbRepairTarget[][],
  ): Promise<DatabaseMaintenanceSnapshot> {
    const snapshot = session.snapshot;
    const signal = session.abort!.signal;
    let executionFailure: string | undefined;
    try {
      if (!session.lease) {
        session.lease = await this.deps.acquire(session.targets, signal);
        snapshot.locked = true;
        const lease = session.lease;
        lease.signal?.addEventListener(
          'abort',
          () => {
            session.abort?.abort(lease.signal?.reason ?? new Error('持续维护锁已中断。'));
            if (!session.pending && !session.ending)
              void this.expireLease(session).catch((error: unknown) => {
                session.snapshot.maintenanceError = errorText(error);
                this.publishStatus(session);
              });
          },
          { once: true },
        );
        lease.signal?.throwIfAborted();
        this.publish(session);
      }
      // 体检期间可选择更多数据库。当前批次完成后为新增库加锁，再按当前类型检查。
      for (const batch of queue) {
        signal.throwIfAborted();
        const added = batch.filter((target) => !session.targets.includes(target));
        if (added.length) {
          if (!session.lease.acquireMore)
            throw new Error('本轮无法追加数据库，请刷新维护状态后重试。');
          await session.lease.acquireMore(added, signal);
          session.targets.push(...added);
          snapshot.databases.push(...added.map(pendingRow));
          this.publish(session, true);
        }
        executionFailure = await this.checkDatabases(session, kind, batch, signal);
        if (executionFailure) break;
      }
    } catch (error) {
      if (!signal.aborted) executionFailure = errorText(error);
    }
    const selected = queue.flat();
    const failures = snapshot.databases.some(
      (row) =>
        selected.some((target) => target.dbName === row.dbName) &&
        (row.scanStatus !== 'completed' || (kind === 'checkup' && row.deepStatus !== 'completed')),
    );
    const lost = session.lease?.signal?.aborted;
    if (lost) {
      executionFailure = '持续维护锁已中断，本次结果不能继续用于修复，请主动重新开始体检。';
      await session.lease!.release();
      session.lease = undefined;
      snapshot.locked = false;
    } else if (
      (snapshot.maintenanceError && executionFailure) ||
      (signal.aborted && !snapshot.databases.some((row) => row.scanStatus === 'completed'))
    ) {
      try {
        await session.lease?.release();
        session.lease = undefined;
        snapshot.locked = false;
      } catch (error) {
        snapshot.maintenanceError = `体检已暂停，但释放维护锁失败，请重试结束维护：${errorText(error)}`;
      }
    }
    this.finish(
      session,
      lost
        ? 'failed'
        : signal.aborted
          ? 'cancelled'
          : executionFailure
            ? 'failed'
            : failures
              ? 'partial'
              : 'completed',
      executionFailure,
    );
    snapshot.state = session.lease ? 'waiting' : 'ended';
    this.publish(session, true);
    await this.flushReports(session);
    return structuredClone(snapshot);
  }

  private async checkDatabases(
    session: Session,
    kind: 'scan' | 'checkup',
    selected: DbRepairTarget[],
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const snapshot = session.snapshot;
    let executionFailure: string | undefined;
    snapshot.state = 'scanning';
    for (const target of selected) {
      signal.throwIfAborted();
      const row = snapshot.databases.find((item) => item.dbName === target.dbName)!;
      if (row.scanStatus === 'completed') {
        if (row.repair?.status !== 'completed' && !this.hasSameSource(session, target)) {
          executionFailure = '原库已发生变化。请结束维护并重新核对数据库。';
          snapshot.maintenanceError = executionFailure;
          break;
        }
        continue;
      }
      const tracker = this.tracker(session, row, 'scan');
      row.scanStatus = 'running';
      row.scanError = undefined;
      this.tick(session, row, tracker, 'scan', { step: 'opening', message: '读取源库信息' });
      try {
        const lockError = session.lease!.errors?.[target.dbName];
        if (lockError) throw new Error(lockError);
        const identity = this.deps.sourceIdentity?.(target);
        const scan = await this.deps.scan(target, signal, (tick) =>
          this.tick(session, row, tracker, 'scan', tick),
        );
        signal.throwIfAborted();
        if (identity !== this.deps.sourceIdentity?.(target))
          throw new Error('体检期间原库发生变化。');
        if (identity !== undefined) session.sourceIdentities.set(target.dbName, identity);
        row.scan = scan;
        row.scanStatus = 'completed';
        row.support = row.scan.plaintext
          ? 'unsupported'
          : row.scan.usedHmac && row.scan.badPages.length < row.scan.pageCount
            ? 'supported'
            : 'possible';
        row.issues = [];
        if (row.scan.sourceLayout === 'standard')
          row.issues.push({
            message: '发现旧版修复留下的标准页布局，本轮重建将迁回 QQ 页布局。',
            support: row.support,
          });
        if (row.scan.plaintext)
          row.issues.push({
            diagnostic: false,
            message: '此数据库为明文库，当前重建工具仅支持加密库。',
            support: 'unsupported',
          });
        if (row.scan.usedHmac && row.scan.badPages.length === row.scan.pageCount)
          row.issues.push({
            message:
              '全部页的签名都未通过；密钥或算法不匹配也会出现此结果，尚不能确认都是物理损坏。',
            support: 'possible',
          });
        if (row.scan.badPages.length)
          row.issues.push({
            message: `发现 ${row.scan.badPages.length.toLocaleString('zh-CN')} 个坏页。`,
            support: row.support,
          });
        if (row.scan.zeroPages.length)
          row.issues.push({
            diagnostic: false,
            message: `发现 ${row.scan.zeroPages.length} 个全零页，需结合结构检查判断影响。`,
            support: 'possible',
          });
        if (row.scan.trailingBytes)
          row.issues.push({
            message: `文件尾部有 ${row.scan.trailingBytes} 字节不足一页，重建不包含这部分字节。`,
            support: 'possible',
          });
        row.progress = tracker.finish('completed');
        row.scanProgress = row.progress;
      } catch (error) {
        row.scanStatus = signal.aborted ? 'pending' : 'failed';
        row.scanError = errorText(error);
        if (error instanceof DatabaseScanUnsupportedError) {
          row.support = 'unsupported';
          row.issues = [{ message: row.scanError, support: 'unsupported', diagnostic: false }];
        }
        row.progress = tracker.finish(signal.aborted ? 'cancelled' : 'failed');
        if (signal.aborted) throw error;
      }
      this.countCompleted(session);
      this.publish(session, true);
    }
    if (kind === 'checkup' && !executionFailure) {
      snapshot.state = 'checking';
      for (const target of selected) {
        signal.throwIfAborted();
        const row = snapshot.databases.find((item) => item.dbName === target.dbName)!;
        if (
          row.scanStatus !== 'completed' ||
          (row.deepStatus === 'completed' && !databaseNeedsPageLocation(row))
        )
          continue;
        row.integrity = undefined;
        row.issues = row.issues.filter((issue) => issue.stage !== 'deep');
        const tracker = this.tracker(session, row, 'checkup');
        row.deepStatus = 'running';
        this.tick(session, row, tracker, 'checkup', {
          step: 'integrity',
          message: '检查数据库整体结构',
        });
        try {
          if (row.scan && this.deps.locate && databaseNeedsPageLocation(row)) {
            const location = await this.deps.locate(target, row.scan, signal, (tick) =>
              this.tick(session, row, tracker, 'checkup', tick),
            );
            signal.throwIfAborted();
            row.scan.affected = location.affected;
            row.quickBudgetBytes = location.quickBudgetBytes;
            row.locationChecked = true;
            const located = row.scan.affected.reduce((sum, object) => sum + object.badPageCount, 0);
            this.tick(session, row, tracker, 'checkup', {
              step: 'mapping',
              message: `已定位 ${located} / ${row.scan.badPages.length} 个坏页`,
              status: 'completed',
              outcome: located < row.scan.badPages.length ? 'unverified' : 'abnormal',
            });
          }
          row.integrity = await this.deps.deep(
            row.scan?.plaintext ? { ...target, key: '' } : target,
            signal,
            (tick) => this.tick(session, row, tracker, 'checkup', tick),
          );
          signal.throwIfAborted();
          if (!this.hasSameSource(session, target)) {
            executionFailure = '补充检查期间原库发生变化，请重新核对数据库。';
            snapshot.maintenanceError = executionFailure;
            row.deepStatus = 'failed';
            break;
          }
          row.deepStatus = row.integrity.ran
            ? row.integrity.complete === false
              ? 'partial'
              : 'completed'
            : 'failed';
          if (row.integrity.ran && row.integrity.complete === false)
            row.issues.push({
              stage: 'deep',
              diagnostic: false,
              support: 'possible',
              message: `以下结构未完成核验，当前结果不能证明相关问题已修复：${row.integrity.unverifiedTables?.join('、') || 'QQ 专用虚拟表或整体结构检查'}`,
            });
          if (
            (row.integrity.ran && !row.integrity.healthy) ||
            (!row.integrity.ran && row.integrity.corrupt)
          )
            row.issues.push({
              stage: 'deep',
              message: `结构检查发现异常${row.integrity.ran && row.integrity.corruptedTables.length ? `：${row.integrity.corruptedTables.join('、')}` : ''}；重建可恢复仍能读取的数据。`,
              support: row.support === 'unsupported' ? 'unsupported' : 'possible',
            });
          row.progress = tracker.finish(row.deepStatus === 'failed' ? 'failed' : 'completed');
        } catch (error) {
          row.deepStatus = signal.aborted ? 'cancelled' : 'failed';
          row.integrity = { ran: false, error: errorText(error) };
          row.progress = tracker.finish(signal.aborted ? 'cancelled' : 'failed');
          if (signal.aborted) throw error;
        }
        this.countCompleted(session);
        this.publish(session, true);
      }
    }
    return executionFailure;
  }

  repair(
    scope: DatabaseMaintenanceScope,
    names: string[],
    options: RepairBatchOptions = {},
  ): Promise<DatabaseMaintenanceSnapshot> {
    const session = this.sessions.get(keyFor(scope));
    if (!session?.lease || session.snapshot.state === 'ended')
      throw new Error('请先开始体检并保留维护锁，再修复数据库。');
    if (session.ending || session.snapshot.state === 'ending')
      throw new Error('正在结束本次维护，不能开始修复。');
    if (session.lease.signal?.aborted)
      throw new Error('持续维护锁已中断，请先结束维护并重新体检。');
    if (session.pending) throw new Error('请先暂停当前体检，再修复已有结果的数据库。');
    const selected = [...new Set(names)];
    if (!selected.length) throw new Error('请勾选需要修复的数据库。');
    const methods = Object.create(null) as Record<string, DatabaseRepairMethod>;
    for (const name of selected) {
      const row = session.snapshot.databases.find((item) => item.dbName === name);
      if (row?.scanStatus !== 'completed' || !row.scan)
        throw new Error(`${name} 尚无完整的页检查结果，不能修复。`);
      if (!databaseReadyForRepair(row)) throw new Error(`${name} 当前不支持修复。`);
      const recommended = databaseRepairRecommendation(row);
      const method = options.methods?.[name] ?? recommended ?? 'deep';
      if (method === 'quick' && recommended !== 'quick' && !databaseCanCheckQuickRepair(row))
        throw new Error(`${name} 当前没有可用的快速修复方案。`);
      methods[name] = method;
    }
    this.begin(session, 'repair', selected.length);
    session.snapshot.operation!.databaseNames = selected;
    session.snapshot.state = 'repairing';
    for (const row of session.snapshot.databases) {
      if (row.repair?.status !== 'completed')
        row.repair = selected.includes(row.dbName) ? { status: 'pending' } : undefined;
    }
    const current = session;
    current.pending = this.repairSession(current, selected, { ...options, methods }).finally(() => {
      current.pending = undefined;
    });
    return current.pending;
  }

  private async repairSession(
    session: Session,
    selected: string[],
    options: RepairBatchOptions,
  ): Promise<DatabaseMaintenanceSnapshot> {
    const snapshot = session.snapshot;
    const signal = session.abort!.signal;
    let waiting = false;
    this.publish(session, true);
    try {
      for (const name of selected) {
        const row = snapshot.databases.find((item) => item.dbName === name)!;
        if (signal.aborted) {
          row.repair = { status: 'cancelled', error: '停止修复，未启动此数据库。' };
          continue;
        }
        const tracker = this.tracker(session, row, 'repair');
        const method = options.methods![name]!;
        row.repair = { status: 'running', method };
        const target = session.targets.find((item) => item.dbName === name)!;
        try {
          if (!this.hasSameSource(session, target))
            throw new DbRepairError('changed-during-repair', '原库与体检时不同，请重新核对原库。');
          if (method === 'quick' && !row.quickBudgetBytes)
            await this.checkQuickRepair(session, row, target, tracker, signal);
          const record = await this.deps.repair(
            target,
            row.scan!,
            signal,
            (tick) => {
              if (tick.storage) snapshot.storage = tick.storage;
              if (tick.phase === 'done') return;
              this.tick(
                session,
                row,
                tracker,
                tick.phase,
                tick.detail ?? { step: tick.phase, message: tick.message },
              );
            },
            {
              backup: options.backups?.[name] ?? (method === 'quick' ? false : options.backup),
              strictPages: method === 'deep' && options.strictPages,
              allowLowSpace: options.allowLowSpace,
              maintenanceId: session.lease!.id,
              method,
              quickBudgetBytes: method === 'quick' ? row.quickBudgetBytes : undefined,
            },
          );
          row.repair = { status: 'completed', record, method };
          row.progress = tracker.finish('completed');
        } catch (error) {
          if (
            !signal.aborted &&
            !session.lease?.signal?.aborted &&
            error instanceof DbRepairError &&
            error.sourceUnchanged &&
            this.hasSameSource(session, target)
          ) {
            waiting = true;
            const space =
              error.code === 'insufficient-space' ||
              error.code === 'space-margin' ||
              !!error.storage?.warning;
            const canDeep =
              method === 'quick' && !space && error.code !== 'blocked' && error.code !== 'busy';
            row.repair = {
              status: 'waiting',
              method,
              error: errorText(error),
              nextAction: space ? 'retry-space' : canDeep ? 'view-deep' : 'retry',
            };
            if (error.storage) snapshot.storage = error.storage;
            row.progress = tracker.finish(canDeep ? 'failed' : 'cancelled');
            for (const pending of snapshot.databases)
              if (pending.repair?.status === 'pending')
                pending.repair = {
                  status: 'waiting',
                  error: '等待处理当前问题后继续，尚未启动此数据库。',
                };
            this.countCompleted(session);
            break;
          }
          row.repair = {
            status: signal.aborted ? 'cancelled' : 'failed',
            method,
            error: errorText(error),
            nextAction: signal.aborted ? undefined : 'check-source',
          };
          row.progress = tracker.finish(signal.aborted ? 'cancelled' : 'failed');
          if (!signal.aborted && error instanceof DbRepairError) {
            for (const pending of snapshot.databases)
              if (pending.repair?.status === 'pending')
                pending.repair = { status: 'cancelled', error: '请先核对原库状态。' };
            this.countCompleted(session);
            break;
          }
        }
        this.countCompleted(session);
        this.publish(session, true);
      }
    } finally {
      const rows = snapshot.databases.filter((row) => row.repair);
      const lost = session.lease?.signal?.aborted;
      this.finish(
        session,
        lost
          ? 'failed'
          : signal.aborted
            ? 'cancelled'
            : waiting
              ? 'waiting'
              : rows.some((row) => row.repair?.status === 'failed')
                ? rows.some((row) => row.repair?.status === 'completed')
                  ? 'partial'
                  : 'failed'
                : 'completed',
        lost ? '持续维护锁进程意外退出，已停止后续修复；已经成功的库保持不变。' : undefined,
      );
      if (!waiting || signal.aborted || lost) {
        await session.lease!.release();
        session.lease = undefined;
        snapshot.locked = false;
      }
      snapshot.state = session.lease ? 'waiting' : 'ended';
      this.publish(session, true);
      await this.flushReports(session);
    }
    return structuredClone(snapshot);
  }

  private async checkQuickRepair(
    session: Session,
    row: DatabaseMaintenanceRow,
    target: DbRepairTarget,
    tracker: DatabaseProgressTracker,
    signal: AbortSignal,
  ) {
    const step = 'quick-repair-check';
    this.tick(session, row, tracker, 'preparing', { step, message: '核验坏页与同卷克隆能力' });
    let checkError: string | undefined;
    const result = await this.deps
      .locate?.(target, row.scan!, signal, () => {}, true)
      .catch((error: unknown) => {
        checkError = errorText(error);
        return undefined;
      });
    signal.throwIfAborted();
    if (!this.hasSameSource(session, target))
      throw new DbRepairError('changed-during-repair', '核验期间原库发生变化，请重新核对原库。');
    if (!result?.quickBudgetBytes) {
      const error = new DbRepairError(
        'recover-failed',
        checkError
          ? `快速修复条件核验失败：${checkError}`
          : '未能确认所有坏页都可修复且原库所在卷支持克隆。可以查看深度修复方案。',
      );
      error.sourceUnchanged = true;
      this.tick(session, row, tracker, 'preparing', {
        step,
        message: '快速修复条件未满足',
        status: 'failed',
        detail: error.message,
      });
      throw error;
    }
    row.scan!.affected = result.affected;
    row.locationChecked = true;
    row.quickBudgetBytes = result.quickBudgetBytes;
    this.tick(session, row, tracker, 'preparing', {
      step,
      message: '已核验坏页与同卷克隆能力',
      status: 'completed',
    });
  }

  private hasSameSource(session: Session, target: DbRepairTarget): boolean {
    try {
      return session.sourceIdentities.get(target.dbName) === this.deps.sourceIdentity?.(target);
    } catch {
      return false;
    }
  }

  async stop(scope: DatabaseMaintenanceScope): Promise<DatabaseMaintenanceSnapshot | null> {
    const session = this.sessions.get(keyFor(scope));
    if (!session) return null;
    if (session.pending) {
      session.snapshot.operation!.stopping = true;
      session.abort!.abort(new DOMException('已停止数据库维护操作。', 'AbortError'));
      this.publish(session, true);
      await session.pending;
    }
    return this.current(scope);
  }
  async end(scope: DatabaseMaintenanceScope): Promise<void> {
    const session = this.sessions.get(keyFor(scope));
    if (!session || session.snapshot.state === 'ended') return;
    if (session.ending) return session.ending;
    if (session.snapshot.state === 'repairing') throw new Error('修复已经开始，请使用停止修复。');
    session.snapshot.state = 'ending';
    const pending = this.endSession(session);
    session.ending = pending;
    this.publish(session);
    return pending;
  }
  private async endSession(session: Session): Promise<void> {
    let failure: unknown;
    try {
      await this.stop(session.snapshot);
    } catch (error) {
      failure = error;
    }
    try {
      await session.lease?.release();
      session.lease = undefined;
      session.snapshot.locked = false;
    } catch (error) {
      failure ??= error;
    } finally {
      session.ending = undefined;
      session.snapshot.state = session.lease ? 'waiting' : 'ended';
      this.publish(session);
    }
    if (failure) throw failure;
  }
  async shutdown(): Promise<void> {
    for (const snapshot of this.active()) {
      await this.stop(snapshot);
      await this.end(snapshot);
    }
    await Promise.all([...this.sessions.values()].map((session) => this.flushReports(session)));
  }
  private async expireLease(session: Session): Promise<void> {
    await session.lease?.release();
    session.lease = undefined;
    session.snapshot.locked = false;
    session.snapshot.state = 'ended';
    session.snapshot.maintenanceError =
      '持续维护锁已中断，本次结果不能继续用于修复，请主动重新开始体检。';
    this.publish(session);
  }
  private begin(
    session: Session,
    kind: 'scan' | 'checkup' | 'repair',
    total: number,
    databaseNames?: string[],
  ) {
    session.abort = new AbortController();
    session.snapshot.storage = undefined;
    session.snapshot.operation = {
      id: randomUUID(),
      kind,
      status: 'running',
      startedAt: Date.now(),
      elapsedMs: 0,
      totalDatabases: total,
      ...(databaseNames ? { databaseNames } : {}),
      completedDatabases: 0,
    };
    session.preparation = new DatabaseProgressTracker(kind, '账号数据库');
    session.snapshot.progress = session.preparation.update('preparing', {
      step: kind === 'repair' ? 'preparing' : 'lock',
      message:
        kind === 'repair'
          ? '准备修复所选数据库'
          : session.lease
            ? '复用账号维护锁和已有体检结果'
            : '锁定账号全部目标数据库',
    });
    this.publish(session, true);
  }
  private tracker(
    session: Session,
    row: DatabaseMaintenanceRow,
    kind: 'scan' | 'checkup' | 'repair',
  ) {
    session.snapshot.operation!.currentDb = row.dbName;
    return new DatabaseProgressTracker(
      kind,
      row.dbName,
      Date.now,
      kind === 'checkup' ? row.scanProgress : undefined,
    );
  }
  private tick(
    session: Session,
    row: DatabaseMaintenanceRow,
    tracker: DatabaseProgressTracker,
    phase: string,
    tick: DatabaseWorkProgress,
  ) {
    row.progress = tracker.update(phase, tick);
    session.snapshot.progress = row.progress;
    // 进度管道只更新内存；广播限频并只发送摘要。
    if (session.publishTimer !== undefined) return;
    session.publishTimer = setTimeout(
      () => {
        session.publishTimer = undefined;
        this.publish(session);
      },
      Math.max(0, progressPublishIntervalMs - (Date.now() - session.lastPublished)),
    );
    session.publishTimer.unref();
  }
  private countCompleted(session: Session) {
    const op = session.snapshot.operation!;
    const rows = session.snapshot.databases.filter(
      (row) => !op.databaseNames || op.databaseNames.includes(row.dbName),
    );
    op.completedDatabases = rows.filter((row) =>
      op.kind === 'repair'
        ? row.repair?.status === 'completed'
        : op.kind === 'checkup'
          ? row.deepStatus === 'completed'
          : row.scanStatus === 'completed',
    ).length;
    op.failedDatabases = rows.filter((row) =>
      op.kind === 'repair'
        ? row.repair?.status === 'failed'
        : op.kind === 'checkup'
          ? row.deepStatus === 'failed' ||
            row.deepStatus === 'partial' ||
            row.scanStatus === 'failed'
          : row.scanStatus === 'failed',
    ).length;
  }
  private finish(
    session: Session,
    status: DatabaseMaintenanceReport['operation']['status'],
    error?: string,
  ) {
    const op = session.snapshot.operation!;
    op.status = status;
    op.finishedAt = Date.now();
    op.elapsedMs = Math.max(0, op.finishedAt - op.startedAt);
    op.currentDb = undefined;
    op.stopping = false;
    op.error = error;
    this.countCompleted(session);
  }
  private publish(session: Session, force = false) {
    clearTimeout(session.publishTimer);
    session.publishTimer = undefined;
    session.lastPublished = Date.now();
    if (session.ending) session.snapshot.state = 'ending';
    const op = session.snapshot.operation;
    const row = op?.currentDb
      ? session.snapshot.databases.find((item) => item.dbName === op.currentDb)
      : undefined;
    if (row?.progress) session.snapshot.progress = row.progress;
    if (op && op.status !== 'running' && session.snapshot.progress?.status === 'running')
      session.snapshot.progress =
        session.preparation?.finish(
          op.status === 'cancelled'
            ? 'cancelled'
            : op.status === 'completed'
              ? 'completed'
              : 'failed',
        ) ?? session.snapshot.progress;
    if (op?.status === 'running') op.elapsedMs = Math.max(0, Date.now() - op.startedAt);
    if (
      op &&
      (op.kind === 'repair' ||
        session.snapshot.databases.some((item) => item.scanStatus === 'completed') ||
        (op.status !== 'running' && op.status !== 'cancelled')) &&
      session.finalizedReportId !== op.id &&
      (force || Date.now() - session.lastSaved >= 2000)
    ) {
      const { operation: _operation, databases, ...state } = session.snapshot;
      session.unsavedReports.set(op.id, {
        ...structuredClone(state),
        operation: structuredClone(op),
        databases: databases.map(({ scan, integrity, repair, ...row }) => ({
          ...structuredClone(row),
          // 扫描与校验结果完成后整项赋值，保留其引用，避免发布时复制页号。
          scan,
          integrity,
          repair: repair && { ...repair },
        })),
      });
      void this.flushReports(session);
      session.lastSaved = Date.now();
      if (op.status !== 'running') session.finalizedReportId = op.id;
    }
    this.publishStatus(session);
  }
  private publishStatus(session: Session) {
    this.deps.changed?.(structuredClone(summarizeDatabaseMaintenance(session.snapshot)));
  }
  private flushReports(session: Session): Promise<void> {
    const queue = session.unsavedReports;
    const writing = this.reportWrites.get(queue);
    if (writing) return writing;
    if (!queue.size) return Promise.resolve();
    const pending = this.writeReports(session).finally(() => this.reportWrites.delete(queue));
    this.reportWrites.set(queue, pending);
    return pending;
  }
  private async writeReports(session: Session) {
    const queue = session.unsavedReports;
    let warning: string | undefined;
    try {
      const reports = this.deps.reports(session.snapshot);
      while (queue.size) {
        const [id, report] = queue.entries().next().value!;
        await reports.save(report);
        if (queue.get(id) === report) queue.delete(id);
      }
    } catch (error) {
      warning = `历史报告尚未写入磁盘，当前结果仍保留在本次维护中：${errorText(error)}`;
    }
    const current = this.sessions.get(keyFor(session.snapshot)) ?? session;
    if (current.snapshot.reportError !== warning) {
      current.snapshot.reportError = warning;
      this.publishStatus(current);
    }
  }
}
