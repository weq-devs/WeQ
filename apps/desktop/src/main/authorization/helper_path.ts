import { posix, win32 } from 'node:path';

export function authorizationHelperPath({
  bundled,
  packaged,
  override,
  platform,
}: {
  bundled: () => string;
  packaged: boolean;
  override?: string;
  platform: NodeJS.Platform;
}): string {
  if (packaged || !override?.trim()) return bundled();
  const path = override.trim();
  if (!(platform === 'win32' ? win32 : posix).isAbsolute(path))
    throw new Error('WEQ_AUTHORIZATION_HELPER_PATH 必须是本机助手的绝对路径');
  return path;
}
