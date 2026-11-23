/** 数据库维护以账号与数据源为单位；独立窗口查看宿主持有的结果，不登记任务列表。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { observable } from '@trpc/server/observable';
import { z } from 'zod';
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
  type DatabaseMaintenanceScope,
  type DbRepairAccountInfo,
  type DbRepairCheckupIntegrity,
  type DbRepairDeps,
  type DbRepairRecord,
} from '@weq/service';
import {
  summarizeDatabaseMaintenance,
  type DatabaseMaintenanceStatus,
} from '@weq/service/db-checkup';
import { writeFileAtomic } from '@weq/service/atomic-write';
import type { RecoverReport } from '@weq/native';
import {
  clearVerifiedDbDamage,
  closeSalvageConnections,
  getAppContext,
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
const maintenanceLocks = new Map<string, DatabaseMaintenanceLock>();
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
  storageOptimized: () =>
    (requirePlatform().native.ntHelper.databaseRepairStorageVersion?.() ?? 0) >= 1,
  resolveAccount: resolveAccountInfo,
  probeLock: (path) => {
    try {
      const probe = requirePlatform().native.ntHelper.probeDbLock(path);
      const owned = new Set([...maintenanceLocks.values()].map((worker) => worker.pid));
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
    const ctx = getAppContext();
    const platform = ctx.platform;
    if (!platform) return;
    if (
      !keepReadOnly &&
      ctx.account?.context.uin === uin &&
      dirname(ctx.account.msgDbPath) === dirname(path)
    ) {
      closeSalvageConnections(ctx);
      void ctx.clearAccount();
      closedAccountDuringRun = true;
    }
    platform.native.ntHelper.closeSalvageDb(path);
    platform.native.ntHelper.closeDb(path);
    ctx.services?.unreadInfo.invalidate();
  },
  recover: async (options, progress, signal) => {
    if (!signal) throw new Error('修复必须由当前维护任务启动。');
    return (await runDatabaseMaintenanceWorker({ kind: 'repair', options }, signal, (tick) => {
      if ('phase' in tick) progress(tick);
    })) as RecoverReport;
  },
  protectProduct: async (id, path, product) => {
    const worker = maintenanceLocks.get(id);
    if (!worker) throw new Error('持续维护锁已经释放，不能替换数据库。');
    await worker.protect(path, product);
  },
  verify: async (path, key, algo) =>
    requirePlatform().native.ntHelper.checkDatabaseHealth(path, key, algo),
};
const service = new DbRepairService(deps);

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
  acquire: async (targets, signal) => {
    const nt = requirePlatform().native.ntHelper;
    if (
      !nt.beginDatabaseMaintenance ||
      !nt.endDatabaseMaintenance ||
      !nt.protectDatabaseMaintenanceProduct ||
      !nt.setDatabaseMaintenanceWriteBarrier
    )
      throw new Error('当前原生组件不支持持续维护锁，请更新原生组件后再开始扫描。');
    const releaseWrites = maintainDatabases(targets.map((target) => target.dbPath));
    const id = randomUUID();
    let worker: DatabaseMaintenanceLock | undefined;
    try {
      nt.setDatabaseMaintenanceWriteBarrier(
        id,
        targets.map((target) => target.dbPath),
        true,
      );
      for (const target of targets) nt.closeDb(target.dbPath);
      worker = new DatabaseMaintenanceLock();
      const locks = await worker.begin(id, targets, signal);
      maintenanceLocks.set(id, worker);
      const owned = worker;
      return {
        id,
        signal: worker.signal,
        errors: Object.fromEntries(
          locks.flatMap((lock) =>
            lock.error
              ? [[targets.find((target) => target.dbPath === lock.dbPath)!.dbName, lock.error]]
              : [],
          ),
        ),
        release: async () => {
          await owned.end();
          nt.setDatabaseMaintenanceWriteBarrier!(id, [], false);
          releaseWrites();
          maintenanceLocks.delete(id);
          service.endMaintenance(id);
        },
      };
    } catch (error) {
      await worker?.terminate();
      nt.setDatabaseMaintenanceWriteBarrier(id, [], false);
      releaseWrites();
      throw error;
    }
  },
  scan: async (target, signal, progress) =>
    (await runDatabaseMaintenanceWorker({ kind: 'scan', target }, signal, (tick) => {
      if ('step' in tick) progress(tick);
    })) as BadPageScanReport,
  deep: async (target, signal, progress) =>
    (await runDatabaseMaintenanceWorker({ kind: 'deep', target }, signal, (tick) => {
      if ('step' in tick) progress(tick);
    })) as DbRepairCheckupIntegrity,
  repair: (target, sourceScan, signal, progress, options) =>
    service.repair(
      { uin: target.uin, dbName: target.dbName, sourceScan, signal, ...options },
      progress,
    ),
  reports,
  changed: (snapshot) => {
    clearVerifiedDbDamage(snapshot);
    progressBus.emit('maintenance', snapshot);
  },
});
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
    .input(accountRef.extend({ kind: z.enum(['scan', 'checkup']) }))
    .mutation(async ({ input }) => {
      const info = service.accountInfo(input.uin);
      const targets = rowsFor(input.uin, info.dbDir)
        .filter((row) => row.exists)
        .map((row) => service.resolveTarget(input.uin, row.dbName));
      return summarizeDatabaseMaintenance(
        await databaseMaintenance.scan(input, targets, input.kind),
      );
    }),
  repairSelected: procedure
    .input(
      accountRef.extend({
        dbNames: z.array(z.string().min(1)).min(1),
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
    .input(targetRef.extend({ backup: z.boolean().optional() }))
    .query(({ input }) => {
      const { key: _key, ...budget } = service.preflight(
        input.uin,
        input.dbName,
        input.backup,
        databaseMaintenance.leaseId(input),
      );
      return budget;
    }),
  repairStorage: procedure
    .input(accountRef.extend({ dbNames: z.array(z.string()), backup: z.boolean() }))
    .query(({ input }) =>
      input.dbNames.map((name) => {
        const { cachePath, space } = service.preflight(
          input.uin,
          name,
          input.backup,
          databaseMaintenance.leaseId(input),
        );
        return { dbName: name, cachePath, space, phase: 'preparing' };
      }),
    ),
  detectLayout: procedure
    .input(targetRef)
    .query(({ input }) => service.probeLayout(input.uin, input.dbName)),
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
