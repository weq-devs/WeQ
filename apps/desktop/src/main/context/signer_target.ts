import type { Platform } from '@weq/platform';

/** macOS 的安装版本可能落后于热更新；未确认目标 QQ 前不加载任何 wrapper。 */
export async function resolveSignerWrapper(
  platform: Platform,
  uin?: string,
): Promise<string | null> {
  if (platform.kind !== 'darwin') return platform.qqWrapperNodePath();
  if (!uin) return null;
  const pid = platform.resolveQqPidAsync
    ? await platform.resolveQqPidAsync(uin)
    : platform.resolveQqPid(uin);
  if (pid === null) return null;
  await platform.prepareQqRuntimeModules?.(pid);
  return platform.qqWrapperNodePath(pid);
}
