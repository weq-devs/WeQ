export const WEQ_BACKUP_SECTIONS = [
  'appearance',
  'preferences',
  'account',
  'models',
  'services',
  'database',
  'layout',
  'paths',
  'device',
  'drafts',
  'assistant',
  'clones',
] as const;
export type WeqBackupSection = (typeof WEQ_BACKUP_SECTIONS)[number];

export interface WeqSelectiveBackup {
  sections: WeqBackupSection[];
  accountConfigIds: string[];
  databaseConfigIds: string[];
  draftConfigIds: string[];
  cloneConfigIds: string[];
  includeApiKeys: boolean;
  includeServiceTokens: boolean;
}
