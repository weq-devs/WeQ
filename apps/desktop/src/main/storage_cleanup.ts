import { app, dialog } from 'electron';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorageUsageItem } from '@weq/service';
import { readStorageCleanupResult } from '@weq/service/storage-cleanup';
import { resolveChildWorkerPath } from './worker_path';

const reportPath = () => join(app.getPath('userData'), 'storage-maintenance', 'last-result.json');
const lockPath = () => join(app.getPath('userData'), 'storage-maintenance', 'running.json');
let pending = false;

export const storageCleanupResult = () => readStorageCleanupResult(reportPath());

export function guardStorageCleanupStartup(): void {
  if (!existsSync(lockPath())) return;
  try {
    const { pid, worker } = JSON.parse(readFileSync(lockPath(), 'utf8')) as {
      pid: number;
      worker: string;
    };
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('清除助手状态无效');
    process.kill(pid, 0);
    if (process.platform !== 'win32' && worker) {
      const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        timeout: 2000,
      });
      if (!command.includes(worker)) {
        rmSync(lockPath(), { force: true });
        return;
      }
    }
    // 不启动窗口、账号或后台服务，避免重新打开正在清除的文件。
    dialog.showErrorBox('存储清除仍在进行', '请等待清除助手完成后再打开 WeQ。');
    app.exit(0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') rmSync(lockPath(), { force: true });
    else if ((error as NodeJS.ErrnoException).code === 'EPERM') app.exit(0);
    else {
      dialog.showErrorBox('无法核对清除状态', '清除状态暂时无法读取，请稍后重试。');
      app.exit(1);
    }
  }
}

/** 独立助手仅在 will-quit 确认退出且父进程消失之后才删除，不向渲染层接受路径。 */
export async function clearStorageAfterExit(targets: StorageUsageItem[]): Promise<void> {
  if (pending) throw new Error('已有退出后清除任务，请先完成当前任务');
  const worker = resolveChildWorkerPath(
    'storageCleanupWorker.mjs',
    dirname(fileURLToPath(import.meta.url)),
  );
  pending = true;
  let child: ChildProcess | undefined;
  try {
    await mkdir(dirname(reportPath()), { recursive: true });
    await writeFile(
      reportPath(),
      JSON.stringify({
        at: new Date().toISOString(),
        cleared: [],
        freedBytes: 0,
        failed: [
          { label: '上次退出后清除', error: '尚未收到完成回执；若应用未退出则未执行清除。' },
        ],
      }),
      { mode: 0o600 },
    );
    const helper = fork(worker, [], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execPath: process.execPath,
    });
    child = helper;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('清除助手启动超时，未退出应用')), 10_000);
      helper.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      helper.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('清除助手提前退出'));
      });
      helper.once('message', (message: { type: string }) => {
        clearTimeout(timer);
        if (message.type === 'ready') resolve();
        else reject(new Error('清除助手响应无效'));
      });
      helper.send({
        type: 'prepare',
        parentPid: process.pid,
        plan: {
          targets,
          protectedPaths: [app.getAppPath(), process.execPath, worker],
          reportPath: reportPath(),
          lockPath: lockPath(),
        },
      });
    });
    if (!child.connected || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('清除助手已退出，未退出应用');
    }
    const temporary = `${lockPath()}.tmp`;
    await writeFile(temporary, JSON.stringify({ pid: child.pid, worker }), { mode: 0o600 });
    await rename(temporary, lockPath());
  } catch (error) {
    pending = false;
    child?.kill();
    await rm(lockPath(), { force: true });
    throw error;
  }
  const helper = child;
  if (!helper) throw new Error('清除助手未启动');
  let committed = false;
  const commit = (event: Electron.Event) => {
    if (committed) return;
    event.preventDefault();
    helper.send({ type: 'commit' }, (error) => {
      if (error) {
        pending = false;
        app.removeListener('will-quit', commit);
        dialog.showErrorBox('未执行存储清除', '清除助手连接失败，应用没有退出，数据未清除。');
        return;
      }
      committed = true;
      if (helper.connected) helper.disconnect();
      helper.unref();
      app.quit();
    });
  };
  app.on('will-quit', commit);
  helper.once('exit', () => {
    pending = false;
    app.removeListener('will-quit', commit);
  });
  setTimeout(() => app.quit(), 200);
}
