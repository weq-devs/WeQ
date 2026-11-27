import { dirname, resolve } from 'node:path';
import { assertQqDatabaseWritesIdle, qqFileWriteTouchesData } from '@weq/db';
import type { Platform } from '@weq/platform';
import type { UserConfigService } from '@weq/service';
import type { QqCapabilityMode } from '@weq/service/qq-capability-mode';
import { type AppContext, getAppContext } from './context/app_context';

const registeredRoots = new WeakMap<Platform['native']['ntHelper'], string[]>();

function qqDataRoots(
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

export function activeQqDataRoots(
  platform: Platform,
  config: Pick<UserConfigService, 'listAccountConfigs'>,
  context?: Pick<AppContext, 'account' | 'resourcePlatform'> | null,
): string[] {
  const roots = [
    ...qqDataRoots(platform, config),
    ...(registeredRoots.get(platform.native.ntHelper) ?? []),
  ];
  const account = context?.account;
  if (account) {
    const root = context.resourcePlatform?.accountDir(account.context.uin);
    if (root) roots.push(root);
    if (account.msgDbPath) roots.push(dirname(account.msgDbPath));
  }
  return roots;
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
  if (mode === 'read-only') {
    assertQqDatabaseWritesIdle();
    if (qqFileWriteTouchesData({ path: config.cacheBaseDir(), tree: true }))
      throw new Error('当前 WeQ 缓存与 QQ 数据目录重叠，请先在存储设置中更换缓存目录。');
  }
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
