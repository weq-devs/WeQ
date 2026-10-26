import { fork } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { manualRestartArgs } from './startup_window';

interface RestartApp {
  on(
    event: 'will-quit',
    listener: (event: { defaultPrevented?: boolean; preventDefault(): void }) => void,
  ): unknown;
  removeListener(
    event: 'will-quit',
    listener: (event: { defaultPrevented?: boolean; preventDefault(): void }) => void,
  ): unknown;
  quit(): void;
}

/** electron-vite 随原 Electron 退出；开发版必须重启整个工具链，而非沿用旧 URL。 */
export async function prepareDevelopmentRestart(
  app: RestartApp,
  options: { appPath: string; argv: readonly string[]; logPath: string; nodePath?: string },
): Promise<void> {
  if (!options.nodePath)
    throw new Error('开发版重启需要 pnpm 的 Node 路径，请通过 pnpm 启动 WeQ。');
  await access(options.nodePath);
  const worker = join(options.appPath, '../../scripts/restart-desktop-dev.mjs');
  await access(worker);
  const helper = fork(
    worker,
    [
      JSON.stringify({
        parentPid: process.pid,
        appPath: options.appPath,
        cli: join(options.appPath, 'node_modules/electron-vite/bin/electron-vite.js'),
        args: manualRestartArgs(options.argv).slice(1),
        logPath: options.logPath,
      }),
    ],
    {
      execPath: options.nodePath,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    const cleanup = () => {
      clearTimeout(timer);
      app.removeListener('will-quit', commit);
      helper.removeListener('error', fail);
      helper.removeListener('exit', exited);
      helper.removeListener('message', message);
    };
    const fail = (error: Error) => {
      cleanup();
      helper.kill();
      if (!ready) reject(error);
      else console.error('开发版重启失败', error);
    };
    const exited = () => fail(new Error('开发版重启助手提前退出'));
    let committing = false;
    const commit = (event: { defaultPrevented?: boolean; preventDefault(): void }) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (committing) return;
      committing = true;
      helper.send({ type: 'commit' }, (error) => {
        if (error) fail(error);
      });
    };
    const message = (value: unknown) => {
      const reply = value as { type?: string; message?: string } | null;
      if (reply?.type === 'ready' && !ready) {
        ready = true;
        app.on('will-quit', commit);
        resolve();
      } else if (reply?.type === 'committed' && committing) {
        cleanup();
        helper.disconnect();
        helper.unref();
        app.quit();
      } else if (reply?.type === 'error') fail(new Error(reply.message));
    };
    const timer = setTimeout(() => fail(new Error('开发版重启助手准备或退出超时')), 120_000);
    helper.once('error', fail);
    helper.once('exit', exited);
    helper.on('message', message);
  });
}
