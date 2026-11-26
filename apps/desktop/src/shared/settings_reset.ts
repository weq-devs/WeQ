export * from '@weq/service/settings-catalog/reset';

export interface LogPrunePreview {
  expiredFiles: number;
  capacityFiles: number;
  confirmation: string;
}

export function isLogPolicyResetItem(id: string): boolean {
  return id === 'logs:logRetentionDays' || id === 'logs:logCapacityMiB';
}
