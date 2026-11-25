import type { WeqRestoreChoice, WeqDefaultsChoice } from '@weq/service';
import type { WeqBackupSection, WeqSelectiveBackup } from '@weq/service/backup-client';
import { client } from '../../trpc/client';
import '../../styles/backup.css';
export const backupApi = {
  inventory: () => client.bootstrap.backupInventory.query(),
  export: (input: Parameters<typeof client.bootstrap.backupExport.mutate>[0]) =>
    client.bootstrap.backupExport.mutate(input),
  pick: () => client.bootstrap.backupPick.mutate(),
  begin: (name: string, bytes: number) =>
    client.bootstrap.backupBeginUpload.mutate({ name, bytes }),
  chunk: (id: string, offset: number, data: string) =>
    client.bootstrap.backupUploadChunk.mutate({ id, offset, data }),
  finish: (id: string) => client.bootstrap.backupFinishUpload.mutate({ id }),
  prepare: (sourceId: string, choice: WeqRestoreChoice) =>
    client.bootstrap.backupPrepare.mutate({ sourceId, ...choice }),
  stage: (previewId: string) => client.bootstrap.backupStage.mutate({ previewId }),
  defaultsInfo: () => client.bootstrap.backupDefaultsInfo.query(),
  defaults: (clientId: string, choice: WeqDefaultsChoice = {}, pruneConfirmation?: string) =>
    client.bootstrap.backupDefaults.mutate({ clientId, ...choice, pruneConfirmation }),
  dispose: (id: string) => client.bootstrap.backupDiscardPreview.mutate({ id }),
  cancel: () => client.bootstrap.backupCancel.mutate(),
  apply: () => client.bootstrap.backupApply.mutate(),
  reveal: (id: string) => client.bootstrap.backupRevealExport.mutate({ id }),
  claim: (id: string, clientId: string) =>
    client.bootstrap.backupClaimClient.mutate({ id, clientId }),
  skip: (id: string) => client.bootstrap.backupSkipClient.mutate({ id }),
};

export type BackupInventory = Awaited<ReturnType<typeof backupApi.inventory>>;

export const BACKUP_SECTION_LABELS: Record<WeqBackupSection, string> = {
  appearance: '外观与显示',
  preferences: '日常功能偏好',
  account: '账号与会话偏好',
  models: 'API 模型与语音服务',
  services: 'WeQ 服务与外部连接',
  database: 'QQ 数据库接入配置',
  layout: '当前设备的界面布局',
  paths: '自定义目录',
  device: '启动、应用锁与诊断偏好',
  drafts: '未发送草稿',
  assistant: 'WeQ 助手会话与报告',
  clones: '克隆体与对话',
};

export function createBackupSelection(inventory: BackupInventory): WeqSelectiveBackup {
  const active = inventory.accounts.find(({ configId }) => configId === inventory.activeConfigId);
  return {
    sections: ['appearance', 'preferences', ...(active ? ['account' as const] : [])],
    accountConfigIds: active ? [active.configId] : [],
    databaseConfigIds: [],
    draftConfigIds: [],
    cloneConfigIds: [],
    includeApiKeys: false,
    includeServiceTokens: false,
  };
}

export function canExportBackup(selection: WeqSelectiveBackup) {
  const { sections } = selection;
  return (
    sections.length > 0 &&
    (!sections.includes('account') || selection.accountConfigIds.length > 0) &&
    (!sections.includes('database') || selection.databaseConfigIds.length > 0) &&
    (!sections.includes('drafts') || selection.draftConfigIds.length > 0) &&
    (!(sections.includes('assistant') || sections.includes('clones')) ||
      selection.cloneConfigIds.length > 0)
  );
}

export function selectedBackupSecrets(selection: WeqSelectiveBackup): string[] {
  return [
    selection.sections.includes('database') && selection.databaseConfigIds.length
      ? '数据库密钥'
      : '',
    selection.sections.includes('models') && selection.includeApiKeys ? 'API Key' : '',
    selection.sections.includes('services') && selection.includeServiceTokens ? '服务令牌' : '',
  ].filter(Boolean);
}
