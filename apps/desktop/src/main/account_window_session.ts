import { constants, existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

const REBUILT_PROFILE_ENTRIES = new Set([
  'Cache',
  'Code Cache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  'Shared Dictionary',
  'blob_storage',
  'web-exports',
]);

/** macOS 的 Chromium 网络服务只给 sessionData 下的缓存目录授予写权限。 */
export async function prepareMacAccountWindowSession(
  sessionData: string,
  profile: string,
): Promise<string> {
  const [root, source] = await Promise.all([realpath(sessionData), realpath(profile)]);
  const offset = relative(root, source);
  if (!isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`)) return source;

  const directory = join(root, 'Partitions', 'weq-account-windows');
  const destination = join(directory, basename(dirname(profile)));
  if (existsSync(destination)) return destination;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(directory, '.profile-'));
  try {
    // 保留旧会话供原宿主继续使用，首次复制浏览器状态后由当前宿主独立使用。
    await cp(source, staging, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (path) => !REBUILT_PROFILE_ENTRIES.has(relative(source, path)),
    });
    await rename(staging, destination);
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
