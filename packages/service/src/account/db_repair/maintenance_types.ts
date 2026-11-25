import type { BadPageScanReport } from '../bad_pages';
import type { DbRepairCheckupIntegrity } from './checkup';
import type { DatabaseTaskProgress } from './progress';
import type { DbRepairRecord } from './types';

export const DEFAULT_DATABASE_CHECKUP_CONCURRENCY = 2;
export const MAX_DATABASE_CHECKUP_CONCURRENCY = 8;

export function normalizeDatabaseCheckupConcurrency(
  value: unknown,
  fallback = DEFAULT_DATABASE_CHECKUP_CONCURRENCY,
): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_DATABASE_CHECKUP_CONCURRENCY
    ? value
    : fallback;
}

export type DatabaseRepairMethod = 'quick' | 'deep';
export const DATABASE_REPAIR_BACKUP_MODES = ['off', 'deep', 'all'] as const;
export type DatabaseRepairBackupMode = (typeof DATABASE_REPAIR_BACKUP_MODES)[number];

export function isDatabaseRepairBackupMode(value: unknown): value is DatabaseRepairBackupMode {
  return DATABASE_REPAIR_BACKUP_MODES.some((mode) => mode === value);
}

export type DatabaseRepairNextAction = 'retry-space' | 'view-deep' | 'retry' | 'check-source';
export interface DatabasePageLocation {
  affected: BadPageScanReport['affected'];
  quickBudgetBytes?: number;
}

export type DatabaseRepairSupport = 'supported' | 'possible' | 'unsupported';
export interface DatabaseMaintenanceIssue {
  message: string;
  support: DatabaseRepairSupport;
  stage?: 'scan' | 'deep';
  diagnostic?: boolean;
}
export interface DatabaseMaintenanceScope {
  uin: string;
  configId?: string;
}
export interface DatabaseMaintenanceRow {
  dbName: string;
  scanStatus: 'pending' | 'running' | 'completed' | 'failed';
  scan?: BadPageScanReport;
  scanError?: string;
  locationChecked?: boolean;
  quickBudgetBytes?: number;
  integrity?: DbRepairCheckupIntegrity;
  deepStatus?: 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  support: DatabaseRepairSupport;
  issues: DatabaseMaintenanceIssue[];
  progress?: DatabaseTaskProgress;
  scanProgress?: DatabaseTaskProgress;
  repair?: {
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting';
    record?: DbRepairRecord;
    method?: DatabaseRepairMethod;
    nextAction?: DatabaseRepairNextAction;
    error?: string;
  };
}
export interface DatabaseMaintenanceOperation {
  id: string;
  kind: 'scan' | 'checkup' | 'repair';
  status: 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted' | 'waiting';
  startedAt: number;
  finishedAt?: number;
  elapsedMs: number;
  totalDatabases: number;
  databaseNames?: string[];
  /** 记录与起始类型不同的体检，其他库沿用起始类型。 */
  databaseScanKinds?: Record<string, 'scan' | 'checkup'>;
  currentScanKind?: 'scan' | 'checkup';
  completedDatabases: number;
  failedDatabases?: number;
  currentDb?: string;
  stopping?: boolean;
  error?: string;
}
export interface DatabaseMaintenanceSnapshot extends DatabaseMaintenanceScope {
  id: string;
  state: 'locking' | 'scanning' | 'checking' | 'waiting' | 'repairing' | 'ending' | 'ended';
  locked: boolean;
  databases: DatabaseMaintenanceRow[];
  operation?: DatabaseMaintenanceOperation;
  progress?: DatabaseTaskProgress;
  maintenanceError?: string;
  reportError?: string;
  storage?: import('./space').RepairStorageStatus;
}
export interface DatabaseMaintenanceReport extends DatabaseMaintenanceSnapshot {
  operation: DatabaseMaintenanceOperation;
}

/** 状态和进度只携带界面使用的页数；页号及重建明细留在完整报告中。 */
export interface DatabaseMaintenanceStatusRow
  extends Omit<DatabaseMaintenanceRow, 'scan' | 'repair'> {
  scan?: Pick<BadPageScanReport, 'dbPath' | 'pageCount' | 'plaintext' | 'usedHmac'> & {
    badPageCount: number;
    zeroPageCount: number;
    affected?: BadPageScanReport['affected'];
    quickRepairEligible?: boolean;
  };
  repair?: Omit<NonNullable<DatabaseMaintenanceRow['repair']>, 'record'> & {
    verification?: {
      healthy: boolean;
      complete?: boolean;
      badPageCount: number;
    };
  };
}
export interface DatabaseMaintenanceStatus extends Omit<DatabaseMaintenanceSnapshot, 'databases'> {
  databases: DatabaseMaintenanceStatusRow[];
}
export function summarizeDatabaseMaintenance(
  snapshot: DatabaseMaintenanceSnapshot,
): DatabaseMaintenanceStatus {
  return {
    ...snapshot,
    databases: snapshot.databases.map(({ scan, repair, ...row }) => {
      const verification = repair?.record?.verification;
      return {
        ...row,
        scan: scan && {
          dbPath: scan.dbPath,
          pageCount: scan.pageCount,
          plaintext: scan.plaintext,
          usedHmac: scan.usedHmac,
          badPageCount: scan.badPages.length,
          zeroPageCount: scan.zeroPages.length,
          affected: scan.affected,
          quickRepairEligible: quickRepairEligible(scan),
        },
        repair: repair && {
          status: repair.status,
          method: repair.method,
          nextAction: repair.nextAction,
          error: repair.error,
          verification: verification
            ? {
                healthy: verification.healthy,
                complete: verification.complete,
                badPageCount: verification.badPages.length,
              }
            : undefined,
        },
      };
    }),
  };
}

export function verifiedDatabaseScans(snapshot: DatabaseMaintenanceStatus) {
  if (!snapshot.configId || snapshot.operation?.kind !== 'checkup') return [];
  return snapshot.databases.flatMap(({ deepStatus, integrity, scan }) =>
    deepStatus === 'completed' &&
    integrity?.ran &&
    integrity.healthy &&
    integrity.complete !== false &&
    scan &&
    scan.badPageCount === 0
      ? [scan]
      : [],
  );
}

export function databaseReadyForRepair(
  row: Pick<
    DatabaseMaintenanceRow | DatabaseMaintenanceStatusRow,
    'scanStatus' | 'scan' | 'support' | 'repair' | 'locationChecked'
  >,
): boolean {
  return (
    row.scanStatus === 'completed' &&
    !!row.scan &&
    row.support !== 'unsupported' &&
    // 常规扫描已验证存在正常页时，深度修复可直接重建；快速修复仍须取得坏页证据。
    (row.support === 'supported' || !databaseNeedsPageLocation(row)) &&
    row.repair?.status !== 'completed'
  );
}
export function databaseRepairRecommendation(
  row: DatabaseMaintenanceStatusRow | DatabaseMaintenanceRow,
): DatabaseRepairMethod | undefined {
  if (!databaseReadyForRepair(row) || !databaseMaintenanceRowAbnormal(row)) return undefined;
  return row.quickBudgetBytes &&
    !databaseNeedsPageLocation(row) &&
    row.repair?.nextAction !== 'view-deep'
    ? 'quick'
    : 'deep';
}

function quickRepairEligible(scan: BadPageScanReport): boolean {
  return (
    scan.usedHmac &&
    !scan.plaintext &&
    scan.sourceLayout !== 'standard' &&
    !scan.trailingBytes &&
    scan.pageSize === 4096 &&
    scan.badPages.length > 0 &&
    scan.badPages.length <= 128 &&
    scan.badPages.length < scan.pageCount
  );
}

export function databaseCanCheckQuickRepair(
  row: DatabaseMaintenanceStatusRow | DatabaseMaintenanceRow,
): boolean {
  const { scan } = row;
  return (
    databaseReadyForRepair(row) &&
    row.repair?.nextAction !== 'view-deep' &&
    databaseNeedsPageLocation(row) &&
    !!scan &&
    ('badPages' in scan ? quickRepairEligible(scan) : scan.quickRepairEligible === true)
  );
}

export function databaseNeedsPageLocation(
  row: Pick<DatabaseMaintenanceRow | DatabaseMaintenanceStatusRow, 'scan' | 'locationChecked'>,
): boolean {
  const scan = row.scan;
  if (!scan || row.locationChecked) return false;
  const bad = 'badPages' in scan ? scan.badPages.length : scan.badPageCount;
  const located = scan.affected?.reduce((count, object) => count + object.badPageCount, 0) ?? 0;
  return located < bad;
}

export const databaseRepairSupportLabel: Record<DatabaseRepairSupport, string> = {
  supported: 'WeQ 支持修复',
  possible: '可能支持修复',
  unsupported: 'WeQ 不支持修复',
};
export const databaseMaintenanceKindLabel = {
  scan: '快速体检',
  checkup: '深度体检',
  repair: '数据库修复',
};
export function databaseMaintenanceOperationLabel(operation: DatabaseMaintenanceOperation): string {
  return operation.databaseScanKinds
    ? '快速及深度体检'
    : databaseMaintenanceKindLabel[operation.kind];
}
export const databaseMaintenanceStatusLabel: Record<
  DatabaseMaintenanceOperation['status'],
  string
> = {
  running: '执行中',
  completed: '执行完成',
  partial: '部分完成',
  failed: '执行失败',
  cancelled: '已停止',
  interrupted: '执行中断',
  waiting: '等待处理后继续',
};
export const databaseRepairStatusLabel = {
  pending: '待修复',
  running: '修复中',
  completed: '修复成功',
  failed: '修复失败',
  cancelled: '已停止',
  waiting: '等待重试',
};
export function databaseMaintenanceRowAbnormal(
  row: Pick<DatabaseMaintenanceRow, 'issues' | 'progress'>,
): boolean {
  return (
    row.issues.some((issue) => issue.diagnostic !== false) ||
    !!row.progress?.steps.some((step) => (step.badPages ?? 0) > 0 || step.outcome === 'abnormal')
  );
}
