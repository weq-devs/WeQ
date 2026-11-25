import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  acquireProcessLock,
  loadConfig,
  prepareDependencies,
  prepareBot,
  prepareElectron,
  prepareNetwork,
  ProcessLockBusy,
} from './dev-prepare.mjs';
import { assertNativeUnused, nativePlatform, prepareNative } from './dev-native.mjs';
import { runCommand, startupLog } from './dev-process.mjs';
import { openRunningDevelopmentWindow } from './dev-window.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
// 固定的 nil UUID 只用于开发入口，避免每次启动都创建一份 Electron 缓存。
const developmentPickerArg = '--weq-account-picker=00000000-0000-0000-0000-000000000000';

export async function runDevelopment({
  repo = root,
  args = [],
  log = startupLog,
  ...options
} = {}) {
  const lock = join(repo, '.weq-dev/running');
  const windowSession = args.includes('--prepare-only') ? null : randomUUID();
  const canOpenWindow = args.every((arg) => arg === '--' || arg === '--enable-dress-tools');
  const ownerDeadline = Date.now() + 2000;
  let release;
  while (!release) {
    try {
      release = await acquireProcessLock(lock, { windowSession });
    } catch (error) {
      if (!(error instanceof ProcessLockBusy) || !canOpenWindow) throw error;
      if (error.owner) return openRunningDevelopmentWindow(lock, error.owner, log);
      if (Date.now() >= ownerDeadline) throw error;
      // 目录已创建，另一进程可能仍在原子发布 owner.json。
      await pause(50);
    }
  }
  try {
    return await startDevelopment({
      ...options,
      repo,
      args,
      log,
      windowEndpoint: windowSession ? join(lock, `window-${windowSession}.json`) : undefined,
    });
  } finally {
    await release();
  }
}

export async function startDevelopment({
  repo = root,
  args = [],
  env = process.env,
  log = startupLog,
  windowEndpoint,
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
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('开发启动需要 Node.js >= 24');
  nativePlatform();
  const config = await loadConfig(repo, env);
  const childEnv = { ...env };
  delete childEnv.WEQ_DEV_WINDOW_ENDPOINT;
  delete childEnv.WEQ_DEV_RESTART;
  delete childEnv.WEQ_DEV_STARTUP_WARNING;
  childEnv.WEQ_DEV_STARTED_AT = String(Date.now());
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_OVERRIDE_DIST_PATH;
  const options = { env: childEnv, log, run };
  const started = performance.now();
  // 在依赖安装与任何替换前检查当前仓库，避免维护仍在使用的开发环境。
  await unused(repo, options);
  await dependencies(repo, options);
  const executable = await electron(repo, options);
  const nativeResult = await native(repo, config.native, options);
  if (nativeResult?.fallback) childEnv.WEQ_DEV_STARTUP_WARNING = '1';
  const helper = await network(repo, options);
  await bot(repo, options);
  childEnv.WEQ_NATIVE_DIR = join(repo, 'native');
  childEnv.NT_HELPER_DRESS_DIR = join(repo, 'resources/dress');
  childEnv.WEQ_REMOTE_HELPER = helper;
  childEnv.WEQ_DEV_STDOUT_TTY ??= process.stdout.isTTY ? '1' : '0';
  childEnv.WEQ_DEV_STDERR_TTY ??= process.stderr.isTTY ? '1' : '0';
  const platform = nativePlatform();
  childEnv.WEQ_AUTHORIZATION_HELPER_PATH ??= join(repo, platform.directory, platform.helper);
  if (args.includes('--prepare-only')) {
    log(
      `开发环境准备完成（未启动应用${nativeResult?.fallback ? '；使用旧 native，本次源码改动未生效' : ''}）`,
    );
    return;
  }
  const launchArgs = args[0] === '--' ? args.slice(1) : [...args];
  const hasProfile = launchArgs.some(
    (arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='),
  );
  if (!hasProfile) {
    if (config.userDataDir) launchArgs.push(`--user-data-dir=${config.userDataDir}`);
    else if (
      !launchArgs.some((arg) =>
        /^(--weq-account-(instance|picker)=|--weq-focus-account=)/.test(arg),
      )
    )
      launchArgs.push(developmentPickerArg);
  }
  log(
    `运行环境就绪${nativeResult?.fallback ? '（使用旧 native，本次源码改动未生效）' : ''}  耗时 ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
  // 继续使用现有宿主准备、内置 Web 构建、Vite 热更新及进程树清理。
  if (windowEndpoint) childEnv.WEQ_DEV_WINDOW_ENDPOINT = windowEndpoint;
  const status = await launch(launchArgs, childEnv, executable);
  if (!status || [130, 143].includes(status)) log('开发服务已停止');
  if (status)
    throw Object.assign(new Error(`WeQ 开发进程已退出（${status}）`), { exitCode: status });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(
      '用法：pnpm dev [--prepare-only] [-- Electron 参数]\n自动补齐依赖、准备 native 与构建后启动。\n默认读取 weq.dev.json 和 weq.dev.local.json；native.mode 为 release 或 local。\n--prepare-only 只准备环境，不启动应用。\n--enable-dress-tools 仅在开发运行环境启用装扮实验工具。',
    );
  } else {
    try {
      await runDevelopment({ args: process.argv.slice(2) });
    } catch (error) {
      if (![130, 143].includes(error.exitCode)) startupLog(error.message, 'error');
      process.exitCode = error.exitCode ?? 1;
    }
  }
}
