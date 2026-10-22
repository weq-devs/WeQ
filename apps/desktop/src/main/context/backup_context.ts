import { weqAppDataRoot } from '@weq/platform';
import { bootstrapWeqBackupFiles, type WeqFileStartup } from '@weq/service';

let current: WeqFileStartup | undefined;
export function initBackupContext(root = weqAppDataRoot()): WeqFileStartup {
  current ??= bootstrapWeqBackupFiles(root);
  return current;
}
export function getBackupContext(): WeqFileStartup {
  if (!current) throw new Error('文件配置尚未初始化');
  return current;
}
export function resetBackupContextForRecovery(): string {
  if (!current || current.ok) throw new Error('当前不需要重试备份恢复');
  const root = current.root;
  current = undefined;
  return root;
}
