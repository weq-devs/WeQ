import { homedir } from 'node:os';
import { join } from 'node:path';

/** 文件型配置与完整 Platform 共用目录，不依赖 Native 绑定加载。 */
export function weqAppDataRoot(
  platform: string = process.platform,
  home = homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'weq');
  if (platform === 'linux') return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'weq');
  if (platform === 'win32') {
    if (!env.APPDATA)
      throw new Error('%APPDATA% not set — cannot derive weq user data root on win32');
    return join(env.APPDATA, 'weq');
  }
  throw new Error(`无法确定此平台的 WeQ 数据目录：${platform}`);
}
