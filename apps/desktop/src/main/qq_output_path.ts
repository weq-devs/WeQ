import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertQqDatabaseWriteAllowed, qqDatabaseReadOnly, withQqDatabaseWrite } from '@weq/db';
import type { Platform } from '@weq/platform';
import type { UserConfigService } from '@weq/service';
import type { QqCapabilityMode } from '@weq/service/qq-capability-mode';
import { getAppContext } from './context/app_context';

const registeredRoots = new WeakMap<Platform['native']['ntHelper'], string[]>();

function realLocation(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A dangling symlink is an unresolved destination, not a missing path.
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(realLocation(parent), basename(path));
  }
}

function contains(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
}

export function qqDataRoots(
  platform: Platform,
  config: Pick<UserConfigService, 'listAccountConfigs'>,
): string[] {
  const roots = new Set(platform.tencentFilesRoots());
  const nativeRoot = platform.qqDataRoot();
  if (nativeRoot) roots.add(nativeRoot);
  for (const account of config.listAccountConfigs()) {
    if (account.dataDir) roots.add(account.dataDir);
    const nativeAccount = platform.accountDir(account.uin);
    if (nativeAccount) roots.add(nativeAccount);
  }
  return [...roots].map((path) => resolve(path)).sort();
}

function isQqOutputPath(path: string): boolean {
  const { platform, bootstrap, account, resourcePlatform } = getAppContext();
  if (!platform || !bootstrap) return false;
  const roots = qqDataRoots(platform, bootstrap.userConfig);
  if (account && resourcePlatform) {
    const root = resourcePlatform.accountDir(account.context.uin);
    if (root) roots.push(root);
    if (account.msgDbPath) roots.push(dirname(account.msgDbPath));
  }
  const absolute = resolve(path);
  const real = realLocation(absolute);
  return roots.some((root) => {
    const absoluteRoot = resolve(root);
    if (contains(absoluteRoot, absolute)) return true;
    try {
      return contains(realLocation(absoluteRoot), real);
    } catch (error) {
      if (['EACCES', 'EPERM', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? ''))
        return false;
      throw error;
    }
  });
}

export function applyNativeQqReadOnly(
  platform: Platform,
  config: Pick<UserConfigService, 'listAccountConfigs'>,
  enabled: boolean,
  activeSource?: string,
): void {
  const nt = platform.native.ntHelper;
  if (!nt.configureQqReadOnlyRoots) {
    if (enabled) throw new Error('当前原生组件不支持保护 QQ 目录，请更新原生组件后使用只读模式。');
    return;
  }
  const roots = enabled
    ? [...(registeredRoots.get(nt) ?? []), ...qqDataRoots(platform, config)]
    : [];
  if (enabled && activeSource) roots.push(resolve(activeSource));
  const next = [...new Set(roots)].sort();
  if (!nt.configureQqReadOnlyRoots(next))
    throw new Error('正在读取 QQ 数据，请等当前查询完成后再切换。');
  registeredRoots.set(nt, next);
}

export function saveQqCapabilityPreference(mode: QqCapabilityMode): void {
  const { platform, bootstrap, account } = getAppContext();
  if (!platform || !bootstrap) throw new Error('原生组件尚未就绪');
  const config = bootstrap.userConfig;
  const current = config.getSetting('qqCapabilityMode');
  if (current === mode) return;
  const source = account?.msgDbPath ? dirname(account.msgDbPath) : undefined;
  const changesReadOnly = mode === 'read-only' || current === 'read-only';
  if (changesReadOnly) applyNativeQqReadOnly(platform, config, mode === 'read-only', source);
  try {
    config.setSettings({ qqCapabilityMode: mode });
  } catch (error) {
    if (changesReadOnly)
      applyNativeQqReadOnly(
        platform,
        config,
        config.getSetting('qqCapabilityMode') === 'read-only',
        source,
      );
    throw error;
  }
}

export function assertQqOutputPathAllowed(path: string): void {
  if (qqDatabaseReadOnly() && isQqOutputPath(path)) assertQqDatabaseWriteAllowed();
}

export function withQqOutputWrite<T>(path: string, write: () => Promise<T>): Promise<T> {
  return isQqOutputPath(path) ? withQqDatabaseWrite(write) : write();
}
