import type { BadPageScanReport } from '../bad_pages';
import type { DbRepairCheckupIntegrity } from './checkup';
import type { DatabaseTaskProgress } from './progress';
import type { DbRepairRecord } from './types';

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
  integrity?: DbRepairCheckupIntegrity;
  deepStatus?: 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  support: DatabaseRepairSupport;
  issues: DatabaseMaintenanceIssue[];
  progress?: DatabaseTaskProgress;
  scanProgress?: DatabaseTaskProgress;
  repair?: {
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting';
    record?: DbRepairRecord;
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
export function verifiedDatabaseScans(snapshot: DatabaseMaintenanceSnapshot): BadPageScanReport[] {
  if (!snapshot.configId || snapshot.operation?.kind !== 'checkup') return [];
  return snapshot.databases.flatMap(({ deepStatus, integrity, scan }) =>
    deepStatus === 'completed' &&
    integrity?.ran &&
    integrity.healthy &&
    integrity.complete !== false &&
    scan &&
    scan.badPages.length === 0
      ? [scan]
      : [],
  );
}

export function databaseReadyForRepair(row: DatabaseMaintenanceRow): boolean {
  return (
    row.scanStatus === 'completed' &&
    !!row.scan &&
    row.support !== 'unsupported' &&
    row.repair?.status !== 'completed'
  );
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
export function databaseMaintenanceRowAbnormal(row: DatabaseMaintenanceRow): boolean {
  return (
    row.issues.some((issue) => issue.diagnostic !== false) ||
    !!row.progress?.steps.some((step) => (step.badPages ?? 0) > 0 || step.outcome === 'abnormal')
  );
}
