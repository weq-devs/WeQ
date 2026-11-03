import { spawn } from 'node:child_process';
import { posix, win32 } from 'node:path';
import { manualRestartArgs } from './startup_window';

export interface StorageCleanupRestart {
  execPath: string;
  args: string[];
  cwd: string;
}

export function createStorageCleanupRestart(options: {
  platform: NodeJS.Platform;
  packaged: boolean;
  execPath: string;
  argv: readonly string[];
  appPath: string;
  appImage?: string;
  rendererUrl?: string;
  nodePath?: string;
}): StorageCleanupRestart {
  const paths = options.platform === 'win32' ? win32 : posix;
  const args = manualRestartArgs(options.argv);
  if (!options.packaged && options.rendererUrl) {
    if (!options.nodePath)
      throw new Error('开发版清除并重启需要 pnpm 的 Node 路径，请通过 pnpm 启动 WeQ。');
    return {
      execPath: options.nodePath,
      args: [
        paths.join(options.appPath, 'node_modules/electron-vite/bin/electron-vite.js'),
        'dev',
        '--',
        ...args.slice(1),
      ],
      cwd: options.appPath,
    };
  }
  // AppImage 的内部可执行文件位于临时挂载点，原进程退出后必须启动原镜像。
  const execPath =
    options.platform === 'linux' && options.appImage ? options.appImage : options.execPath;
  return { execPath, args, cwd: paths.dirname(execPath) };
}

export async function restartAfterStorageCleanup(plan: StorageCleanupRestart): Promise<void> {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  delete env.ELECTRON_CLI_ARGS;
  delete env.ELECTRON_ENTRY;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.execPath, plan.args, {
      cwd: plan.cwd,
      env,
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
