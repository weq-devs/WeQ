import { weqAppDataRoot } from '@weq/platform';
import {
  applyPendingWeqBackupRestore,
  bootstrapWeqBackupFiles,
  type WeqFileStartup,
} from '@weq/service';

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

/** 调用前必须排空业务请求并关闭持有账号配置的服务；全局配置实例原位重新读盘。 */
export function applyLiveBackupContext() {
  const files = getBackupContext();
  if (!files.ok) throw new Error(files.error);
  try {
    files.cacheRoot = files.config.cacheBaseDir();
    const result = applyPendingWeqBackupRestore(files.root, files.cacheRoot);
    if (!result) throw new Error('没有待应用的恢复任务');
    files.result = result;
    if (result.needsRecovery) {
      current = {
        ...files,
        ok: false,
        error: result.error || '恢复回滚尚未完成',
        config: null,
        backups: null,
      };
    }
    return result;
  } finally {
    files.config.reload();
  }
}
