import { join, resolve } from 'node:path';
import { UserConfigService } from './user_config';
import { WeqBackupService } from './backup_service';
import {
  hasPendingWeqBackupRestore,
  applyPendingWeqBackupRestore,
  readWeqRestoreStartupConfig,
  type WeqRestoreResult,
} from './backup_restore';
import { parseWeqBackupJson } from './backup_bundle';

interface FileStartupBase {
  root: string;
  cacheRoot: string;
  result: WeqRestoreResult | null;
}
export type WeqFileStartup = FileStartupBase &
  (
    | { ok: true; error: null; config: UserConfigService; backups: WeqBackupService }
    | { ok: false; error: string; config: null; backups: null }
  );

/** 必须先完成恢复再构造任何持有配置／JSON Store 内存态的服务。 */
export function bootstrapWeqBackupFiles(appRoot: string): WeqFileStartup {
  const root = resolve(appRoot);
  let cacheRoot = join(root, 'cache');
  let result: WeqRestoreResult | null = null;
  try {
    if (hasPendingWeqBackupRestore(root)) {
      const bytes = readWeqRestoreStartupConfig(root);
      if (bytes) {
        const raw = parseWeqBackupJson(bytes);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
          throw new Error('当前全局配置无法解析，未猜测缓存目录');
        const override = 'cacheDirOverride' in raw ? raw.cacheDirOverride : null;
        if (override !== null && override !== undefined && typeof override !== 'string')
          throw new Error('当前缓存目录配置无效');
        if (typeof override === 'string' && override.trim()) cacheRoot = resolve(override);
      }
      result = applyPendingWeqBackupRestore(root, cacheRoot);
      if (result?.needsRecovery) throw new Error(result.error || '备份回滚尚未完成');
    }
    const config = new UserConfigService({ appDataRoot: () => root });
    cacheRoot = resolve(config.cacheBaseDir());
    return {
      ok: true,
      error: null,
      root,
      cacheRoot,
      result,
      config,
      backups: new WeqBackupService(root, config),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error && error.message ? error.message : '备份恢复初始化失败',
      root,
      cacheRoot,
      result,
      config: null,
      backups: null,
    };
  }
}
