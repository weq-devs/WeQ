import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configureQqDatabaseReadOnly, configureQqFileWriteRoots } from '@weq/db';
import { candidateQqDataRoots } from '@weq/platform';
import type { UserConfig } from '@weq/service';

function readConfig<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    // 正常的配置初始化负责报告无法读取的具体文件。
    return undefined;
  }
}

export function configureStartupQqFilePolicy(root: string): void {
  const config = readConfig<UserConfig>(join(root, 'config.json'));
  const accountsDir = join(root, 'config', 'accounts');
  const roots = candidateQqDataRoots(config?.tencentFilesRootOverride);
  try {
    for (const name of readdirSync(accountsDir)) {
      if (!name.endsWith('.json')) continue;
      const path = readConfig<{ dataDir?: string }>(join(accountsDir, name))?.dataDir;
      if (typeof path === 'string' && path) roots.push(path);
    }
  } catch {
    // 账号目录尚未初始化时仍保留平台已识别的 QQ 数据目录。
  }
  configureQqDatabaseReadOnly(() => config?.settings?.qqCapabilityMode === 'read-only');
  configureQqFileWriteRoots(() => roots);
}
