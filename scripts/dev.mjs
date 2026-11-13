import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireProcessLock,
  loadConfig,
  prepareDependencies,
  prepareBot,
  prepareElectron,
  prepareNetwork,
} from './dev-prepare.mjs';
import { assertNativeUnused, nativePlatform, prepareNative } from './dev-native.mjs';
import { runCommand, startupLog } from './dev-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function withDevelopmentLock(root, task) {
  const release = await acquireProcessLock(join(root, '.weq-dev/running'));
  try {
    return await task();
  } finally {
    await release();
  }
}

export async function startDevelopment({
  repo = root,
  args = [],
  env = process.env,
  log = startupLog,
  dependencies = prepareDependencies,
  electron = prepareElectron,
  native = prepareNative,
  network = prepareNetwork,
  bot = prepareBot,
  unused = assertNativeUnused,
  launch = async (args, environment, executable) => {
    const { launchDevElectron } = await import('./prepare-dev-electron.mjs');
    return launchDevElectron(['--', ...args], environment, executable);
  },
  run = runCommand,
} = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12))
    throw new Error('开发启动需要 Node.js >= 22.12.0');
  nativePlatform();
  const config = await loadConfig(repo, env);
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_OVERRIDE_DIST_PATH;
  const options = { env: childEnv, log, run };
  const started = performance.now();
  // 在依赖安装与任何替换前检查当前仓库，避免维护仍在使用的开发环境。
  await unused(repo, options);
  await dependencies(repo, options);
  const executable = await electron(repo, options);
  await native(repo, config.native, options);
  const helper = await network(repo, options);
  await bot(repo, options);
  childEnv.WEQ_NATIVE_DIR = join(repo, 'native');
  childEnv.NT_HELPER_DRESS_DIR = join(repo, 'resources/dress');
  childEnv.WEQ_REMOTE_HELPER = helper;
  childEnv.WEQ_DEV_STDOUT_TTY = process.stdout.isTTY ? '1' : '0';
  childEnv.WEQ_DEV_STDERR_TTY = process.stderr.isTTY ? '1' : '0';
  const platform = nativePlatform();
  childEnv.WEQ_AUTHORIZATION_HELPER_PATH ??= join(repo, platform.directory, platform.helper);
  if (args.includes('--prepare-only')) {
    log('开发环境准备完成（未启动应用）');
    return;
  }
  const launchArgs = args[0] === '--' ? args.slice(1) : [...args];
  if (
    config.userDataDir &&
    !launchArgs.some((arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='))
  )
    launchArgs.push(`--user-data-dir=${config.userDataDir}`);
  log(
    `依赖准备完成，开始开发构建（依赖、Electron、native、网络助手及机器人运行时已就绪；耗时 ${((performance.now() - started) / 1000).toFixed(1)}s）`,
  );
  // 继续使用现有宿主准备、内置 Web 构建、Vite 热更新及进程树清理。
  const status = await launch(launchArgs, childEnv, executable);
  if (status)
    throw Object.assign(new Error(`WeQ 开发进程已退出（${status}）`), { exitCode: status });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(
      '用法：pnpm dev [--prepare-only] [-- Electron 参数]\n自动补齐依赖、准备 native 与构建后启动。\n默认读取 weq.dev.json 和 weq.dev.local.json；native.mode 为 release 或 local。\n--prepare-only 只准备环境，不启动应用。',
    );
  } else {
    try {
      await withDevelopmentLock(root, () => startDevelopment({ args: process.argv.slice(2) }));
    } catch (error) {
      if (![130, 143].includes(error.exitCode)) startupLog(error.message, 'error');
      process.exitCode = error.exitCode ?? 1;
    }
  }
}
