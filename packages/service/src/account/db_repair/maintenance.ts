import { randomUUID } from 'node:crypto';
import type { BadPageScanReport } from '../bad_pages';
import { DatabaseScanUnsupportedError, type DbRepairCheckupIntegrity } from './checkup';
import { DatabaseProgressTracker, type DatabaseWorkProgress } from './progress';
import type { DbRepairProgress, DbRepairRecord, DbRepairTarget } from './types';
import type { DatabaseMaintenanceReports } from './maintenance_reports';
import { DbRepairError } from './service';
import {
  databaseReadyForRepair,
  type DatabaseMaintenanceRow,
  type DatabaseMaintenanceScope,
  type DatabaseMaintenanceSnapshot,
  type DatabaseMaintenanceReport,
} from './maintenance_types';

export interface DatabaseMaintenanceLease {
  id?: string;
  release(): void | Promise<void>;
  /** 锁内无法合并的 WAL 等逐库问题，不把主文件扫描冒充完整扫描。 */
  errors?: Record<string, string>;
  signal?: AbortSignal;
}
export interface DatabaseMaintenanceDeps {
  acquire(targets: DbRepairTarget[], signal: AbortSignal): Promise<DatabaseMaintenanceLease>;
  scan(
    target: DbRepairTarget,
    signal: AbortSignal,
    progress: (tick: DatabaseWorkProgress) => void,
  ): Promise<BadPageScanReport>;
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
    },
  ): Promise<DbRepairRecord>;
  reports(scope: DatabaseMaintenanceScope): DatabaseMaintenanceReports;
  changed?(snapshot: DatabaseMaintenanceSnapshot): void;
}
interface Session {
  snapshot: DatabaseMaintenanceSnapshot;
  targets: DbRepairTarget[];
  lease?: DatabaseMaintenanceLease;
  abort?: AbortController;
  pending?: Promise<DatabaseMaintenanceSnapshot>;
  lastSaved: number;
  preparation?: DatabaseProgressTracker;
  finalizedReportId?: string;
  ending?: Promise<void>;
  unsavedReports: Map<string, DatabaseMaintenanceReport>;
}
const keyFor = (scope: DatabaseMaintenanceScope) =>
  JSON.stringify([scope.uin, scope.configId ?? null]);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 维护的生命周期属于宿主，不属于窗口；每次执行各自留一份不可覆盖的历史结果。 */
export class DatabaseMaintenance {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly deps: DatabaseMaintenanceDeps) {}

  leaseId(scope: DatabaseMaintenanceScope): string | undefined {
    const session = this.sessions.get(keyFor(scope));
    return session?.snapshot.locked && !session.lease?.signal?.aborted
      ? session.lease?.id
      : undefined;
  }

  current(scope: DatabaseMaintenanceScope): DatabaseMaintenanceSnapshot | null {
    const session = this.sessions.get(keyFor(scope));
    if (session?.unsavedReports.size) this.flushReports(session);
    const snapshot = session?.snapshot;
    return snapshot ? structuredClone(snapshot) : null;
  }
  active(): DatabaseMaintenanceSnapshot[] {
    return [...this.sessions.values()]
      .filter((session) => session.snapshot.state !== 'ended')
      .map((session) => structuredClone(session.snapshot));
  }
  reports(scope: DatabaseMaintenanceScope): DatabaseMaintenanceReport[] {
    const session = this.sessions.get(keyFor(scope));
    if (session) this.flushReports(session);
    const saved = new Map(
      this.deps
        .reports(scope)
        .list()
        .map((report) => [report.operation.id, report]),
    );
    for (const [id, report] of session?.unsavedReports ?? []) saved.set(id, report);
    return [...saved.values()]
      .sort((a, b) => b.operation.startedAt - a.operation.startedAt)
      .map((report) => {
        const active = this.sessions.get(keyFor(scope));
        if (
          report.operation.status === 'running' &&
          (active?.snapshot.operation?.id !== report.operation.id ||
            active?.snapshot.operation?.status !== 'running')
        ) {
          return {
            ...report,
            locked: false,
            state: 'ended',
            operation: {
              ...report.operation,
              status: 'interrupted',
              finishedAt: report.operation.startedAt + report.operation.elapsedMs,
            },
          };
        }
        return report;
      });
  }

  deleteReport(scope: DatabaseMaintenanceScope, id: string): boolean {
    const operation = this.sessions.get(keyFor(scope))?.snapshot.operation;
    if (operation?.id === id && operation.status === 'running')
      throw new Error('这份报告仍在更新，请暂停扫描或等待执行结束后再删除。');
    const pending = this.sessions.get(keyFor(scope))?.unsavedReports.delete(id) ?? false;
    return this.deps.reports(scope).remove(id) || pending;
  }

  scan(
    scope: DatabaseMaintenanceScope,
    targets: DbRepairTarget[],
    kind: 'scan' | 'checkup',
  ): Promise<DatabaseMaintenanceSnapshot> {
    let session = this.sessions.get(keyFor(scope));
    if (session?.ending || session?.snapshot.state === 'ending')
      throw new Error('正在结束本次维护，请等待数据库解锁。');
    if (session?.pending) throw new Error('数据库维护任务正在执行，请先停止当前操作。');
    if (!session || session.snapshot.state === 'ended') {
      if (!targets.length) throw new Error('没有可扫描的数据库。');
      const paths = new Set(targets.map((target) => target.dbPath));
      if (
        [...this.sessions.values()].some(
          (other) =>
            other.snapshot.state !== 'ended' &&
            other.targets.some((target) => paths.has(target.dbPath)),
        )
      )
        throw new Error('此账号的数据源已经在维护中。');
      session = {
        snapshot: {
          ...scope,
          id: randomUUID(),
          state: 'locking',
          locked: false,
          databases: targets.map((target) => ({
            dbName: target.dbName,
            scanStatus: 'pending',
            support: 'possible',
            issues: [],
          })),
        },
        targets,
        lastSaved: 0,
        unsavedReports: session?.unsavedReports ?? new Map(),
      };
      this.sessions.set(keyFor(scope), session);
    }
    const current = session;
    this.begin(current, kind, current.targets.length);
    current.pending = this.scanSession(current, kind).finally(() => {
      current.pending = undefined;
    });
    return current.pending;
  }

  private async scanSession(
    session: Session,
    kind: 'scan' | 'checkup',
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
                this.deps.changed?.(structuredClone(session.snapshot));
              });
          },
          { once: true },
        );
        lease.signal?.throwIfAborted();
        this.publish(session);
      }
      snapshot.state = 'scanning';
      for (const target of session.targets) {
        signal.throwIfAborted();
        const row = snapshot.databases.find((item) => item.dbName === target.dbName)!;
        if (row.scanStatus === 'completed') continue;
        const tracker = this.tracker(session, row, 'scan');
        row.scanStatus = 'running';
        row.scanError = undefined;
        this.tick(session, row, tracker, 'scan', { step: 'opening', message: '读取源库扫描信息' });
        try {
          const lockError = session.lease.errors?.[target.dbName];
          if (lockError) throw new Error(lockError);
          row.scan = await this.deps.scan(target, signal, (tick) =>
            this.tick(session, row, tracker, 'scan', tick),
          );
          signal.throwIfAborted();
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
              message: `发现 ${row.scan.badPages.length} 个页签名异常；可重建可读取的内容，坏页内容无法保证完整。`,
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
      if (kind === 'checkup') {
        snapshot.state = 'checking';
        for (const target of session.targets) {
          signal.throwIfAborted();
          const row = snapshot.databases.find((item) => item.dbName === target.dbName)!;
          if (row.scanStatus !== 'completed' || row.deepStatus === 'completed') continue;
          row.integrity = undefined;
          row.issues = row.issues.filter((issue) => issue.stage !== 'deep');
          const tracker = this.tracker(session, row, 'checkup');
          row.deepStatus = 'running';
          this.tick(session, row, tracker, 'checkup', {
            step: 'integrity',
            message: '检查数据库整体结构',
          });
          try {
            row.integrity = await this.deps.deep(
              row.scan?.plaintext ? { ...target, key: '' } : target,
              signal,
              (tick) => this.tick(session, row, tracker, 'checkup', tick),
            );
            signal.throwIfAborted();
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
    } catch (error) {
      if (!signal.aborted) executionFailure = errorText(error);
    }
    const failures = snapshot.databases.some(
      (row) =>
        row.scanStatus !== 'completed' || (kind === 'checkup' && row.deepStatus !== 'completed'),
    );
    const lost = session.lease?.signal?.aborted;
    if (lost) {
      executionFailure = '持续维护锁已中断，本次结果不能继续用于修复，请主动重新开始扫描。';
      await session.lease!.release();
      session.lease = undefined;
      snapshot.locked = false;
    } else if (
      signal.aborted &&
      !snapshot.databases.some((row) => row.scanStatus === 'completed')
    ) {
      try {
        await session.lease?.release();
        session.lease = undefined;
        snapshot.locked = false;
      } catch (error) {
        snapshot.maintenanceError = `扫描已停止，但释放维护锁失败，请重试结束维护：${errorText(error)}`;
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
    return structuredClone(snapshot);
  }

  repair(
    scope: DatabaseMaintenanceScope,
    names: string[],
    options: { backup?: boolean; strictPages?: boolean; allowLowSpace?: boolean } = {},
  ): Promise<DatabaseMaintenanceSnapshot> {
    const session = this.sessions.get(keyFor(scope));
    if (!session?.lease || session.snapshot.state === 'ended')
      throw new Error('请先开始扫描并保留维护锁，再修复数据库。');
    if (session.ending || session.snapshot.state === 'ending')
      throw new Error('正在结束本次维护，不能开始修复。');
    if (session.lease.signal?.aborted)
      throw new Error('持续维护锁已中断，请先结束维护并重新扫描。');
    if (session.pending) throw new Error('请先停止当前扫描或体检，保留扫描结果后再修复。');
    const selected = [...new Set(names)];
    if (!selected.length) throw new Error('请勾选需要修复的数据库。');
    for (const name of selected) {
      const row = session.snapshot.databases.find((item) => item.dbName === name);
      if (row?.scanStatus !== 'completed' || !row.scan)
        throw new Error(`${name} 尚无完整扫描结果，不能修复。`);
      if (!databaseReadyForRepair(row)) throw new Error(`${name} 当前不支持修复。`);
    }
    this.begin(session, 'repair', selected.length);
    session.snapshot.operation!.databaseNames = selected;
    session.snapshot.state = 'repairing';
    for (const row of session.snapshot.databases) {
      if (row.repair?.status !== 'completed')
        row.repair = selected.includes(row.dbName) ? { status: 'pending' } : undefined;
    }
    const current = session;
    current.pending = this.repairSession(current, selected, options).finally(() => {
      current.pending = undefined;
    });
    return current.pending;
  }

  private async repairSession(
    session: Session,
    selected: string[],
    options: { backup?: boolean; strictPages?: boolean; allowLowSpace?: boolean },
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
        row.repair = { status: 'running' };
        try {
          const target = session.targets.find((item) => item.dbName === name)!;
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
            { ...options, maintenanceId: session.lease!.id },
          );
          row.repair = { status: 'completed', record };
          row.progress = tracker.finish('completed');
        } catch (error) {
          if (
            !signal.aborted &&
            !session.lease?.signal?.aborted &&
            error instanceof DbRepairError &&
            error.sourceUnchanged
          ) {
            waiting = true;
            row.repair = { status: 'waiting', error: errorText(error) };
            if (error.storage) snapshot.storage = error.storage;
            row.progress = tracker.finish('cancelled');
            for (const pending of snapshot.databases)
              if (pending.repair?.status === 'pending')
                pending.repair = {
                  status: 'waiting',
                  error: '等待处理当前问题后继续，尚未启动此数据库。',
                };
            this.countCompleted(session);
            break;
          }
          row.repair = { status: signal.aborted ? 'cancelled' : 'failed', error: errorText(error) };
          row.progress = tracker.finish(signal.aborted ? 'cancelled' : 'failed');
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
    }
    return structuredClone(snapshot);
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
  }
  private async expireLease(session: Session): Promise<void> {
    await session.lease?.release();
    session.lease = undefined;
    session.snapshot.locked = false;
    session.snapshot.state = 'ended';
    session.snapshot.maintenanceError =
      '持续维护锁已中断，本次结果不能继续用于修复，请主动重新开始扫描。';
    this.publish(session);
  }
  private begin(session: Session, kind: 'scan' | 'checkup' | 'repair', total: number) {
    session.abort = new AbortController();
    session.snapshot.storage = undefined;
    session.snapshot.operation = {
      id: randomUUID(),
      kind,
      status: 'running',
      startedAt: Date.now(),
      elapsedMs: 0,
      totalDatabases: total,
      completedDatabases: 0,
    };
    session.preparation = new DatabaseProgressTracker(kind, '账号数据库');
    session.snapshot.progress = session.preparation.update('preparing', {
      step: kind === 'repair' ? 'preparing' : 'lock',
      message:
        kind === 'repair'
          ? '准备修复所选数据库'
          : session.lease
            ? '复用账号维护锁和已有扫描结果'
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
    this.publish(session);
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
      session.unsavedReports.set(
        op.id,
        structuredClone(session.snapshot) as DatabaseMaintenanceReport,
      );
      this.flushReports(session);
      session.lastSaved = Date.now();
      if (op.status !== 'running') session.finalizedReportId = op.id;
    }
    this.deps.changed?.(structuredClone(session.snapshot));
  }
  private flushReports(session: Session) {
    try {
      for (const [id, report] of session.unsavedReports) {
        this.deps.reports(session.snapshot).save(report);
        session.unsavedReports.delete(id);
      }
      session.snapshot.reportError = undefined;
    } catch (error) {
      session.snapshot.reportError = `历史报告尚未写入磁盘，当前结果仍保留在本次维护中：${errorText(error)}`;
    }
  }
}
