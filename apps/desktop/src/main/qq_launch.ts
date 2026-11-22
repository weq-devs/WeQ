import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { posix, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Platform } from '@weq/platform';

let restarting = false;

export function qqRestartInProgress(): boolean {
  return restarting;
}

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

async function macQqProcesses(executables: ReadonlySet<string>) {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      '/bin/ps',
      ['-U', userInfo().username, '-o', 'pid=,comm='],
      { encoding: 'utf8', timeout: 1000, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
  return output.split('\n').flatMap((line) => {
    const match = /^\s*([1-9]\d*)\s+(.+)$/.exec(line);
    if (!match) return [];
    const executable = match[2]!.trimEnd();
    return executables.has(executable) ? [{ pid: Number(match[1]), executable }] : [];
  });
}

/** 结束宿主上可确认的 QQ 实例，等到旧进程退出后再打开原应用。 */
export async function restartQq(
  platform: Pick<Platform, 'kind' | 'qqExePath' | 'resolveQqPid'>,
  uin: string | null,
  debugExecutable?: string,
): Promise<void> {
  if (restarting) throw new Error('正在重新启动 QQ，请稍候。');
  restarting = true;
  try {
    let exe = platform.qqExePath();
    let pid: number | null | undefined;
    if (platform.kind === 'darwin') {
      const candidates = new Set([exe, debugExecutable].filter((path): path is string => !!path));
      const processes = await macQqProcesses(candidates);
      const accountPid = uin ? platform.resolveQqPid(uin) : null;
      const target = accountPid
        ? processes.find(({ pid }) => pid === accountPid)
        : processes.length === 1
          ? processes[0]
          : undefined;
      if (!target && processes.length > 1)
        throw new Error('检测到多个 QQ 实例，无法确认要重新启动哪一个。');
      pid = target ? target.pid : null;
      exe = target ? target.executable : null;
    } else {
      pid = uin ? platform.resolveQqPid(uin) : null;
    }

    if (!pid || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)
      throw new Error('没有找到可重新启动的 QQ 进程，请重新检查。');
    const launchTarget = requireQqExecutable(platform.kind, exe);
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }

    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        await launchQq({ kind: platform.kind, qqExePath: () => launchTarget });
        return;
      }
      await delay(200);
    }
    throw new Error('QQ 进程未退出，未重新打开 QQ。');
  } finally {
    restarting = false;
  }
}

function requireQqExecutable(kind: string, exe: string | null): string {
  const path = kind === 'win32' ? win32 : posix;
  if (!exe || !path.isAbsolute(exe) || !existsSync(exe))
    throw new Error('未检测到 QQ 安装，请先安装 QQ。');
  return exe;
}

/** 只启动检测到的 QQ 客户端；启动成功不代表账号已登录或在线凭据已就绪。 */
export async function launchQq(platform: Pick<Platform, 'kind' | 'qqExePath'>): Promise<void> {
  const exe = requireQqExecutable(platform.kind, platform.qqExePath());
  const path = platform.kind === 'win32' ? win32 : posix;

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
