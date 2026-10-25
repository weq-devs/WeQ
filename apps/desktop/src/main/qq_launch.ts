import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { Platform } from '@weq/platform';

/** 只启动检测到的 QQ 客户端；启动成功不代表账号已登录或在线凭据已就绪。 */
export async function launchQq(platform: Pick<Platform, 'kind' | 'qqExePath'>): Promise<void> {
  const exe = platform.qqExePath();
  const path = platform.kind === 'win32' ? win32 : posix;
  if (!exe || !path.isAbsolute(exe) || !existsSync(exe))
    throw new Error('未检测到 QQ 安装，请先安装 QQ。');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = path.dirname(path.dirname(path.dirname(exe)));
  if (
    platform.kind === 'darwin' &&
    path.extname(app) === '.app' &&
    path.basename(path.dirname(exe)) === 'MacOS' &&
    path.basename(path.dirname(path.dirname(exe))) === 'Contents'
  ) {
    // 通过系统打开应用，复用已运行实例并激活登录窗口。
    await new Promise<void>((resolve, reject) => {
      execFile('/usr/bin/open', ['-a', app], { timeout: 10_000, env }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(exe, [], {
      cwd: path.dirname(exe),
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
