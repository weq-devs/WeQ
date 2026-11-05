import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { Platform } from '@weq/platform';

/** 仅作「正在运行」的证据，不用进程数量代替账号在线数。复用 macOS 在线探测的精确主进程名。 */
export async function runningQqCount(kind: string): Promise<number | null> {
  if (kind !== 'darwin') return null;
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/pgrep',
      ['-x', 'QQ'],
      { encoding: 'utf8', timeout: 1000, maxBuffer: 16 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve(error.code === 1 && !stdout && !stderr ? 0 : null);
          return;
        }
        const pids = stdout.trim().split(/\s+/);
        resolve(
          pids.length && pids.every((pid) => /^[1-9]\d*$/.test(pid)) ? new Set(pids).size : null,
        );
      },
    );
  });
}

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
