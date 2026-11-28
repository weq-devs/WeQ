import { weqAppDataRoot } from '@weq/platform';
import {
  applyPendingWeqBackupRestore,
  bootstrapWeqBackupFiles,
  withSharedConfigLock,
  type WeqFileStartup,
} from '@weq/service';
import { configureStartupQqFilePolicy } from './startup_qq_file_policy';

let current: WeqFileStartup | undefined;
let sharedStorage = false;
export function initBackupContext(root = weqAppDataRoot(), shared = sharedStorage): WeqFileStartup {
  sharedStorage = shared;
  if (!current) {
    configureStartupQqFilePolicy(root);
    current = bootstrapWeqBackupFiles(root, shared);
  }
  return current;
}
export function getBackupContext(): WeqFileStartup {
  if (!current) throw new Error('文件配置尚未初始化');
  return current;
}
export function getInitializedAppDataRoot(): string | undefined {
  return current?.ok ? current.root : undefined;
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
    const restore = () => applyPendingWeqBackupRestore(files.root, files.cacheRoot);
    const result = sharedStorage ? withSharedConfigLock(files.root, restore) : restore();
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
