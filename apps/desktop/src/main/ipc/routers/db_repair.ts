/** 数据库维护以账号与数据源为单位；独立窗口查看宿主持有的结果，不登记任务列表。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { observable } from '@trpc/server/observable';
import { z } from 'zod/v3';
import { maintainDatabases } from '@weq/db';
import {
  ACCOUNT_HEALTH_DATABASES,
  DatabaseMaintenance,
  DatabaseMaintenanceReports,
  DbRepairError,
  DbRepairService,
  DbRepairHistory,
  dbRepairPaths,
  dbRepairRoot,
  getHost,
  getLogger,
  renderDatabaseMaintenanceReport,
  renderDbRepairReportMarkdown,
  resolveAccountDbDir,
  type BadPageScanReport,
  type DatabasePageLocation,
  type DatabaseMaintenanceScope,
  type DbRepairAccountInfo,
  type DbRepairCheckupIntegrity,
  type DbRepairDeps,
  type DbRepairRecord,
} from '@weq/service';
import {
  summarizeDatabaseMaintenance,
  databaseRepairRecommendation,
  type DatabaseMaintenanceStatus,
} from '@weq/service/db-checkup';
import { writeFileAtomic } from '@weq/service/atomic-write';
import type { RecoverReport } from '@weq/native';
import {
  clearVerifiedDbDamage,
  closeSalvageConnections,
  getAppContext,
  visitOpenAccounts,
  requireBootstrap,
  requirePlatform,
} from '../../context/app_context';
import { procedure as baseProcedure, router } from '../trpc';
import { runDatabaseMaintenanceWorker } from '../../db_maintenance_worker_client';
import { DatabaseMaintenanceLock } from '../../db_maintenance_lock';

const logger = getLogger().child({ scope: 'db-repair' });
const repairSource = new AsyncLocalStorage<string | undefined>();
const procedure = baseProcedure.use(({ rawInput: input, next }) => {
  const configId =
    input && typeof input === 'object' && 'configId' in input && typeof input.configId === 'string'
      ? input.configId
      : undefined;
  return repairSource.run(configId, next);
});
const accountRef = z.object({ uin: z.string().min(1), configId: z.string().min(1).optional() });
const targetRef = accountRef.extend({ dbName: z.string().min(1) });
const recordRef = accountRef.extend({ recordId: z.string().min(1) });
const reportRef = accountRef.extend({ reportId: z.string().min(1) });
const progressBus = new EventEmitter();
const maintenanceLocks = new Map<string, Map<string, DatabaseMaintenanceLock>>();
let closedAccountDuringRun = false;

function configuredDbDir(dataDir: string): string | undefined {
  const paths = [dataDir, join(dataDir, 'nt_db')];
  const primary = paths.find((path) => {
    try {
      return statSync(join(path, 'nt_msg.db')).isFile();
    } catch {
      return false;
    }
  });
  if (primary) return primary;
  return paths.reverse().find((path) => {
    try {
      return readdirSync(path).some(
        (name) => name.endsWith('.db') && statSync(join(path, name)).isFile(),
      );
    } catch {
      return false;
    }
  });
}

function resolveAccountInfo(uin: string): DbRepairAccountInfo | null {
  const platform = requirePlatform();
  const configId = repairSource.getStore();
  const candidates: DbRepairAccountInfo[] = [];
  for (const config of requireBootstrap().userConfig.listAccountConfigs()) {
    if (config.uin !== uin || (configId && config.configId !== configId)) continue;
    const dataDir = config.dataDir ?? null;
    const dbDir = dataDir ? configuredDbDir(dataDir) : resolveAccountDbDir(platform, uin, null);
    if (dbDir) candidates.push({ dataDir, dbDir, dbKey: config.dbKey, algos: config.algos });
  }
  return (
    candidates.find((candidate) => existsSync(join(candidate.dbDir, 'nt_msg.db'))) ??
    candidates[0] ??
    null
  );
}
const deps: DbRepairDeps = {
  cacheDir: (...segments) => requireBootstrap().userConfig.cacheDir(join(...segments)),
  scratchDir: () => requireBootstrap().userConfig.getDbRepairCacheDir(),
  storageStreaming: () => !!requirePlatform().native.ntHelper.recoverDatabaseStreaming,
  storageOptimized: () =>
    (requirePlatform().native.ntHelper.databaseRepairStorageVersion?.() ?? 0) >= 1,
  resolveAccount: resolveAccountInfo,
  probeLock: (path) => {
    try {
      const probe = requirePlatform().native.ntHelper.probeDbLock(path);
      const owned = new Set(
        [...maintenanceLocks.values()].flatMap((workers) =>
          [...workers.values()].map((worker) => worker.pid),
        ),
      );
      return { ...probe, holders: probe.holders.filter((holder) => !owned.has(holder.pid)) };
    } catch {
      return { success: false, holders: [] };
    }
  },
  qqPid: (uin) => {
    try {
      return requirePlatform().resolveQqPid(uin);
    } catch {
      return null;
    }
  },
  selfPid: () => process.pid,
  releaseHandles: (uin, path, keepReadOnly) => {
    const platform = getAppContext().platform;
    if (!platform) return;
    visitOpenAccounts((ctx) => {
      if (ctx.account?.context.uin !== uin || dirname(ctx.account.msgDbPath) !== dirname(path))
        return;
      if (!keepReadOnly) {
        closeSalvageConnections(ctx);
        void ctx.clearAccount();
        closedAccountDuringRun = true;
      }
      ctx.services?.unreadInfo.invalidate();
    });
    platform.native.ntHelper.closeSalvageDb(path);
    platform.native.ntHelper.closeDb(path);
  },
  recover: async (options, progress, signal, method, streaming, references) => {
    if (!signal) throw new Error('修复必须由当前维护任务启动。');
    return (await runDatabaseMaintenanceWorker(
      { kind: 'repair', options, method, streaming, references },
      signal,
      (tick) => {
        if ('phase' in tick) progress(tick);
      },
    )) as RecoverReport;
  },
  cloneBackup: async (source, target, signal) => {
    await runDatabaseMaintenanceWorker({ kind: 'clone-backup', source, target }, signal);
  },
  protectProduct: async (id, path, product) => {
    const worker = maintenanceLocks.get(id)?.get(path);
    if (!worker) throw new Error('持续维护锁已经释放，不能替换数据库。');
    await worker.protect(path, product);
  },
  verify: async (path, key, algo) =>
    requirePlatform().native.ntHelper.checkDatabaseHealth(path, key, algo),
};
const service = new DbRepairService(deps);

function backupReferencesFor(dbPath: string, uin: string): string[] {
  const history = service.history(uin);
  return [
    ...new Set(
      history
        .list()
        .flatMap((record) =>
          record.dbPath === dbPath && record.backupPath && history.backupExists(record)
            ? [record.backupPath]
            : [],
        ),
    ),
  ].slice(0, 3);
}

function historyRoot(scope: DatabaseMaintenanceScope) {
  const boot = requireBootstrap();
  const config = boot.userConfig
    .listAccountConfigs()
    .find(
      (item) => item.uin === scope.uin && (!scope.configId || item.configId === scope.configId),
    );
  if (scope.configId && !config) {
    if (
      !/^\d+(?:_[0-9a-f]{8})?$/.test(scope.configId) ||
      scope.configId.split('_')[0] !== scope.uin
    )
      throw new Error('此数据源配置已经不存在，不能退回其他来源。');
    return boot.userConfig.cacheDir(join('db_repair', scope.configId));
  }
  // 历史报告不依赖源库仍存在，也不跟随备份与修复工作区位置移动或清理。
  return dbRepairRoot(
    (...parts) => boot.userConfig.cacheDir(join(...parts)),
    scope.uin,
    config?.dataDir ?? null,
  );
}
function reports(scope: DatabaseMaintenanceScope) {
  return new DatabaseMaintenanceReports(join(historyRoot(scope), 'maintenance-reports'));
}
function historicalRecords(scope: DatabaseMaintenanceScope) {
  return new DbRepairHistory(dbRepairPaths(historyRoot(scope)));
}

export const databaseMaintenance = new DatabaseMaintenance({
  sourceIdentity: ({ dbPath }) => {
    const db = statSync(dbPath, { bigint: true });
    const sidecar = (suffix: string) => {
      try {
        return statSync(`${dbPath}${suffix}`, { bigint: true }).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0n;
        throw error;
      }
    };
    const wal = sidecar('-wal');
    return [
      db.dev,
      db.ino,
      db.size,
      db.mtimeNs,
      db.ctimeNs,
      wal > 32n ? wal : 0n,
      sidecar('-journal'),
    ].join(':');
  },
  acquire: async (targets, signal) => {
    const nt = requirePlatform().native.ntHelper;
    if (
      !nt.beginDatabaseMaintenance ||
      !nt.endDatabaseMaintenance ||
      !nt.protectDatabaseMaintenanceProduct ||
      !nt.setDatabaseMaintenanceWriteBarrier
    )
      throw new Error('当前原生组件不支持持续维护锁，请更新原生组件后再开始体检。');
    const id = randomUUID();
    const setWriteBarrier = nt.setDatabaseMaintenanceWriteBarrier.bind(nt);
    const workers = new Map<string, DatabaseMaintenanceLock>();
    const releases = new Set<() => Promise<void>>();
    const errors: Record<string, string> = Object.create(null);
    const lost = new AbortController();
    // 每批库有自己的原生持锁进程，替换产物时仍使用原库实际对应的锁。
    const acquireMore = async (batch: typeof targets, signal: AbortSignal) => {
      const batchId = randomUUID();
      const paths = batch.map((target) => target.dbPath);
      const releaseWrites = maintainDatabases(paths);
      let worker: DatabaseMaintenanceLock | undefined;
      try {
        setWriteBarrier(batchId, paths, true);
        for (const path of paths) nt.closeDb(path);
        worker = new DatabaseMaintenanceLock();
        const locks = await worker.begin(batchId, batch, signal);
        worker.signal.throwIfAborted();
        const owned = worker;
        owned.signal.addEventListener('abort', () => lost.abort(owned.signal.reason), {
          once: true,
        });
        for (const { dbPath, dbName } of batch) {
          workers.set(dbPath, owned);
          const error = locks.find((lock) => lock.dbPath === dbPath)?.error;
          if (error) errors[dbName] = error;
        }
        const release = async () => {
          await owned.end();
          setWriteBarrier(batchId, [], false);
          releaseWrites();
          for (const path of paths) workers.delete(path);
          releases.delete(release);
        };
        releases.add(release);
      } catch (error) {
        await worker?.terminate();
        setWriteBarrier(batchId, [], false);
        releaseWrites();
        throw error;
      }
    };
    await acquireMore(targets, signal);
    maintenanceLocks.set(id, workers);
    return {
      id,
      signal: lost.signal,
      errors,
      acquireMore,
      release: async () => {
        const results = await Promise.allSettled([...releases].map((release) => release()));
        const failure = results.find((result) => result.status === 'rejected');
        if (failure) {
          lost.abort(failure.reason);
          throw failure.reason;
        }
        maintenanceLocks.delete(id);
        service.endMaintenance(id);
      },
    };
  },
  scan: async (target, signal, progress) =>
    (await runDatabaseMaintenanceWorker({ kind: 'scan', target }, signal, (tick) => {
      if ('step' in tick) progress(tick);
    })) as BadPageScanReport,
  locate: async (target, scan, signal, progress, quickOnly) =>
    (await runDatabaseMaintenanceWorker(
      {
        kind: 'locate',
        target,
        scan,
        references: backupReferencesFor(target.dbPath, target.uin),
        quickOnly,
      },
      signal,
      (tick) => {
        if ('step' in tick) progress(tick);
      },
    )) as DatabasePageLocation,
  deep: async (target, signal, progress) =>
    (await runDatabaseMaintenanceWorker({ kind: 'deep', target }, signal, (tick) => {
      if ('step' in tick) progress(tick);
    })) as DbRepairCheckupIntegrity,
  repair: (target, sourceScan, signal, progress, options) =>
    service.repair(
      {
        uin: target.uin,
        dbName: target.dbName,
        sourceScan,
        signal,
        ...options,
        references:
          options.method === 'quick' ? backupReferencesFor(target.dbPath, target.uin) : undefined,
      },
      progress,
    ),
  reports,
  changed: (snapshot) => {
    clearVerifiedDbDamage(snapshot);
    progressBus.emit('maintenance', snapshot);
  },
});
function quickBudgetFor(scope: DatabaseMaintenanceScope, name: string) {
  const row = databaseMaintenance.status(scope)?.databases.find((row) => row.dbName === name);
  if (row && databaseRepairRecommendation(row) === 'quick') return row.quickBudgetBytes;
  throw new Error('此数据库当前没有可用的快速修复方案。');
}
export const isDbRepairBusy = () => service.isBusy() || databaseMaintenance.active().length > 0;

export interface DbRepairRecordSummary {
  id: string;
  at: string;
  dbName: string;
  state: DbRepairRecord['state'];
  kind?: DbRepairRecord['kind'];
  badPages: number[];
  durationMs: number;
  beforeBytes: number;
  afterBytes: number | null;
  strictPages: boolean;
  sourceLayout?: 'qq' | 'standard';
  targetLayout?: 'qq' | 'standard';
  error?: string;
  reportPath: string | null;
  canRestore: boolean;
  purgedAt?: string;
}
function summarize(record: DbRepairRecord): DbRepairRecordSummary {
  return {
    id: record.id,
    at: record.at,
    dbName: record.dbName,
    state: record.state,
    kind: record.kind,
    badPages: record.badPages,
    durationMs: record.durationMs,
    beforeBytes: record.beforeBytes,
    afterBytes: record.afterBytes,
    strictPages: record.strictPages,
    sourceLayout: record.sourceLayout,
    targetLayout: record.targetLayout,
    error: record.error,
    reportPath: record.reportPath,
    canRestore: !!record.backupPath && !record.purgedAt,
    purgedAt: record.purgedAt,
  };
}
function rowsFor(uin: string, dbDir: string) {
  const latest = new Map<string, DbRepairRecord>();
  for (const record of service.listRecords(uin))
    if (!latest.has(record.dbName)) latest.set(record.dbName, record);
  const names = new Set<string>(ACCOUNT_HEALTH_DATABASES);
  for (const name of readdirSync(dbDir)) if (name.endsWith('.db')) names.add(name);
  return [...names].map((dbName) => {
    const dbPath = join(dbDir, dbName);
    let bytes: number | null = null;
    try {
      if (statSync(dbPath).isFile()) bytes = statSync(dbPath).size;
    } catch {
      /* 缺少可选库。 */
    }
    const record = latest.get(dbName);
    return {
      dbName,
      dbPath,
      exists: bytes !== null,
      bytes,
      lastRecord: record ? summarize(record) : null,
    };
  });
}
function assertIdle() {
  if (isDbRepairBusy()) throw new Error('数据库正在维护中，请先结束维护。');
}
function assertCacheIdle() {
  if (
    service.isBusy() ||
    databaseMaintenance.active().some((snapshot) => snapshot.state === 'repairing')
  )
    throw new Error('备份与修复工作区正在使用中，暂不能更改位置。');
}
async function savedReport(scope: DatabaseMaintenanceScope, id: string) {
  const report = await databaseMaintenance.report(scope, id);
  if (!report) throw new Error('找不到这份数据库维护报告。');
  return report;
}

export const dbRepairRouter = router({
  status: procedure.input(accountRef).query(({ input }) => {
    let info: DbRepairAccountInfo | null = null;
    let error: string | null = null;
    try {
      info = service.accountInfo(input.uin);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    return {
      uin: input.uin,
      dataDir: info?.dataDir ?? null,
      dbDir: info?.dbDir ?? '',
      keyPresent: !!info?.dbKey,
      qqPid: deps.qqPid?.(input.uin) ?? null,
      busy: service.isBusy(),
      databases: info ? rowsFor(input.uin, info.dbDir) : [],
      error,
    };
  }),
  maintenance: procedure.input(accountRef).query(({ input }) => databaseMaintenance.status(input)),
  scanAccount: procedure
    .input(
      accountRef.extend({
        kind: z.enum(['scan', 'checkup']),
        dbNames: z.array(z.string().min(1)).min(1).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const info = service.accountInfo(input.uin);
      const current = databaseMaintenance.status(input);
      const names = current?.locked
        ? (input.dbNames ?? []).filter(
            (name) => !current.databases.some((row) => row.dbName === name),
          )
        : (input.dbNames ??
          rowsFor(input.uin, info.dbDir)
            .filter((row) => row.exists)
            .map((row) => row.dbName));
      const targets = [...new Set(names)].map((name) => service.resolveTarget(input.uin, name));
      return summarizeDatabaseMaintenance(
        await databaseMaintenance.scan(
          input,
          targets,
          input.kind,
          current?.locked ? input.dbNames : undefined,
        ),
      );
    }),
  appendScan: procedure
    .input(
      accountRef.extend({
        operationId: z.string().min(1),
        dbNames: z.array(z.string().min(1)).min(1),
      }),
    )
    .mutation(({ input }) => {
      const current = databaseMaintenance.status(input);
      const targets = [...new Set(input.dbNames)]
        .filter((name) => !current?.databases.some((row) => row.dbName === name))
        .map((name) => service.resolveTarget(input.uin, name));
      databaseMaintenance.appendScan(input, input.operationId, targets, input.dbNames);
    }),
  repairSelected: procedure
    .input(
      accountRef.extend({
        dbNames: z.array(z.string().min(1)).min(1),
        methods: z.record(z.enum(['quick', 'deep'])).optional(),
        backups: z.record(z.boolean()).optional(),
        backup: z.boolean().optional(),
        strictPages: z.boolean().optional(),
        allowLowSpace: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      closedAccountDuringRun = false;
      try {
        return {
          snapshot: summarizeDatabaseMaintenance(
            await databaseMaintenance.repair(input, input.dbNames, input),
          ),
          closedAccount: closedAccountDuringRun,
        };
      } finally {
        closedAccountDuringRun = false;
      }
    }),
  stopMaintenance: procedure.input(accountRef).mutation(async ({ input }) => {
    const snapshot = await databaseMaintenance.stop(input);
    return snapshot ? summarizeDatabaseMaintenance(snapshot) : null;
  }),
  endMaintenance: procedure.input(accountRef).mutation(async ({ input }) => {
    await databaseMaintenance.end(input);
    return true;
  }),
  reports: procedure.input(accountRef).query(async ({ input }) =>
    (await databaseMaintenance.reports(input)).map((report) => ({
      id: report.operation.id,
      operation: report.operation,
      uin: report.uin,
    })),
  ),
  report: procedure.input(reportRef).query(({ input }) => savedReport(input, input.reportId)),
  reportStatus: procedure.input(reportRef).query(async ({ input }) => {
    const current = databaseMaintenance.status(input);
    if (current?.operation?.id === input.reportId) return current;
    return summarizeDatabaseMaintenance(await savedReport(input, input.reportId));
  }),
  deleteReport: procedure.input(reportRef).mutation(async ({ input }) => ({
    removed: await databaseMaintenance.deleteReport(input, input.reportId),
  })),
  exportMaintenanceReport: procedure
    .input(reportRef.extend({ format: z.enum(['html', 'md', 'json']) }))
    .mutation(async ({ input }) => {
      const report = await savedReport(input, input.reportId);
      const target = await getHost().pickSaveTarget({
        defaultName: `database-${report.operation.kind}-${report.operation.id}.${input.format}`,
        extension: input.format,
        locationKey: 'database-maintenance-report',
      });
      if (!target) return null;
      await writeFileAtomic(target.path, renderDatabaseMaintenanceReport(report, input.format));
      return target;
    }),
  onMaintenance: procedure.subscription(() =>
    observable<DatabaseMaintenanceStatus>((emit) => {
      const listener = (snapshot: DatabaseMaintenanceStatus) => emit.next(snapshot);
      progressBus.on('maintenance', listener);
      return () => {
        progressBus.off('maintenance', listener);
      };
    }),
  ),
  preflight: procedure
    .input(
      targetRef.extend({
        backup: z.boolean().optional(),
        method: z.enum(['quick', 'deep']).optional(),
      }),
    )
    .query(({ input }) => {
      const { key: _key, ...budget } = service.preflight(
        input.uin,
        input.dbName,
        input.backup,
        databaseMaintenance.leaseId(input),
        input.method === 'quick' ? quickBudgetFor(input, input.dbName) : undefined,
      );
      return budget;
    }),
  repairStorage: procedure
    .input(
      accountRef.extend({
        dbNames: z.array(z.string()),
        backup: z.boolean().optional(),
        backups: z.record(z.boolean()).optional(),
        methods: z.record(z.enum(['quick', 'deep'])).optional(),
      }),
    )
    .query(({ input }) =>
      input.dbNames.map((name) => {
        const { cachePath, space } = service.preflight(
          input.uin,
          name,
          input.backups?.[name] ?? (input.methods?.[name] === 'quick' ? false : input.backup),
          databaseMaintenance.leaseId(input),
          input.methods?.[name] === 'quick' ? quickBudgetFor(input, name) : undefined,
        );
        return { dbName: name, cachePath, space, phase: 'preparing' };
      }),
    ),
  detectLayout: procedure.input(targetRef).query(async ({ input }) => {
    const { dbPath } = service.resolveDatabasePath(input.uin, input.dbName);
    const result = await runDatabaseMaintenanceWorker({ kind: 'layout', dbPath }, undefined);
    if (!('needsMigration' in result)) throw new Error('源库布局检测结果无效。');
    return result;
  }),
  cacheLocation: procedure.query(() => ({
    override: requireBootstrap().userConfig.getDbRepairCacheDir(),
  })),
  pickCacheLocation: procedure.mutation(async () => {
    assertCacheIdle();
    const picked = await getHost().pickDirectory({ title: '选择备份与修复工作区位置' });
    assertCacheIdle();
    if (picked) requireBootstrap().userConfig.setDbRepairCacheDir(picked);
    return { override: requireBootstrap().userConfig.getDbRepairCacheDir() };
  }),
  resetCacheLocation: procedure.mutation(() => {
    assertCacheIdle();
    requireBootstrap().userConfig.setDbRepairCacheDir(null);
    return { override: null };
  }),
  history: procedure
    .input(accountRef)
    .query(({ input }) => historicalRecords(input).list().map(summarize)),
  legacyReport: procedure
    .input(recordRef)
    .query(({ input }) => historicalRecords(input).find(input.recordId) ?? null),
  restorePreview: procedure
    .input(recordRef)
    .query(({ input }) => service.restorePreview(input.uin, input.recordId)),
  backup: procedure
    .input(targetRef)
    .mutation(({ input }) => service.backup(input.uin, input.dbName)),
  restore: procedure
    .input(recordRef.extend({ force: z.boolean().optional() }))
    .mutation(({ input }) => {
      assertIdle();
      closedAccountDuringRun = false;
      try {
        return {
          ok: true as const,
          record: service.restore(input.uin, input.recordId, { force: input.force }),
          closedAccount: closedAccountDuringRun,
        };
      } catch (error) {
        logger.warn('database restore failed', { error: String(error) });
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
          code: error instanceof DbRepairError ? error.code : 'recover-failed',
          closedAccount: closedAccountDuringRun,
        };
      } finally {
        closedAccountDuringRun = false;
      }
    }),
  deleteBackup: procedure.input(recordRef).mutation(({ input }) => {
    assertIdle();
    return service.deleteBackup(input.uin, input.recordId);
  }),
  deleteRecord: procedure.input(recordRef).mutation(({ input }) => {
    assertIdle();
    return service.deleteRecord(input.uin, input.recordId);
  }),
  revealReport: procedure.input(recordRef).mutation(async ({ input }) => {
    const record = historicalRecords(input).find(input.recordId);
    if (!record?.reportPath) throw new Error('这条记录没有报告文件。');
    await getHost().revealInFolder(record.reportPath);
    return true;
  }),
  revealBackup: procedure.input(recordRef).mutation(async ({ input }) => {
    const history = historicalRecords(input);
    const record = history.find(input.recordId);
    if (!record?.backupPath || !history.backupExists(record))
      throw new Error('这条记录的备份已经不在了。');
    await getHost().revealInFolder(record.backupPath);
    return true;
  }),
  exportLegacyReport: procedure
    .input(recordRef.extend({ format: z.enum(['html', 'md', 'json']) }))
    .mutation(async ({ input }) => {
      const record = historicalRecords(input).find(input.recordId);
      if (!record) throw new Error('找不到这份历史修复报告。');
      const target = await getHost().pickSaveTarget({
        defaultName: `repair-${record.id}.${input.format}`,
        extension: input.format,
      });
      if (!target) return null;
      const markdown = renderDbRepairReportMarkdown(record);
      const text =
        input.format === 'json'
          ? JSON.stringify(record, null, 2)
          : input.format === 'md'
            ? markdown
            : `<!doctype html><meta charset="utf-8"><title>数据库修复报告</title><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.7 system-ui">${markdown.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
      await writeFileAtomic(target.path, text);
      return target;
    }),
});
