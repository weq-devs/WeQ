import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pnpmCommand, runCommand, startupLog } from './dev-process.mjs';

export const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};
export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}
export async function readCache(path) {
  try {
    return await readJson(path, null);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const incoming = `${path}.${process.pid}.incoming`;
  try {
    await writeFile(incoming, `${JSON.stringify(value, null, 2)}\n`);
    await rename(incoming, path);
  } finally {
    await rm(incoming, { force: true });
  }
}
export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function acquireProcessLock(lock) {
  await mkdir(dirname(lock), { recursive: true });
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readCache(join(lock, 'owner.json'));
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0)
      throw new Error(`启动或构建锁尚未就绪，请稍后重试；若已无对应进程，请检查 ${lock}`);
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      await rm(lock, { recursive: true });
      return acquireProcessLock(lock);
    }
    throw new Error(`此启动或构建流程已在运行（PID ${owner.pid}）：${lock}`);
  }
  try {
    await writeJson(join(lock, 'owner.json'), { pid: process.pid });
  } catch (error) {
    await rm(lock, { recursive: true, force: true });
    throw error;
  }
  return () => rm(lock, { recursive: true, force: true });
}

export async function loadConfig(root, env = process.env) {
  const shared = await readJson(join(root, 'weq.dev.json'), {});
  const local = await readJson(join(root, 'weq.dev.local.json'), {});
  for (const config of [shared, local]) {
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new Error('开发配置必须是 JSON 对象');
    for (const key of Object.keys(config))
      if (!['native', 'userDataDir'].includes(key)) throw new Error(`未知开发配置项：${key}`);
    if (
      config.native !== undefined &&
      (!config.native || typeof config.native !== 'object' || Array.isArray(config.native))
    )
      throw new Error('native 配置必须是对象');
    for (const key of Object.keys(config.native ?? {}))
      if (!['mode', 'source', 'jobs'].includes(key)) throw new Error(`未知 native 配置项：${key}`);
  }
  const config = {
    userDataDir: '.dev-profile',
    ...shared,
    ...local,
    native: { mode: 'release', jobs: 2, ...shared.native, ...local.native },
  };
  config.native.mode = env.WEQ_NATIVE_MODE ?? config.native.mode;
  config.native.source = env.WEQ_NATIVE_SOURCE ?? config.native.source;
  if (!['release', 'local'].includes(config.native.mode))
    throw new Error('native.mode 只能是 release 或 local');
  if (
    !Number.isSafeInteger(config.native.jobs) ||
    config.native.jobs < 1 ||
    config.native.jobs > 64
  )
    throw new Error('native.jobs 必须是 1–64 的整数');
  if (config.native.mode === 'local') {
    if (typeof config.native.source !== 'string' || !config.native.source.trim())
      throw new Error('local 模式必须设置 native.source 或 WEQ_NATIVE_SOURCE');
    config.native.source = resolve(root, config.native.source);
  }
  if (config.userDataDir !== null) {
    if (typeof config.userDataDir !== 'string' || !config.userDataDir.trim())
      throw new Error('userDataDir 必须是路径字符串或 null');
    config.userDataDir = resolve(root, config.userDataDir);
  }
  return config;
}

async function workspaceManifests(root) {
  const files = ['package.json'];
  // 对应 pnpm-workspace.yaml 的 apps/*、packages/* 和 docs，不依赖尚未安装的 YAML 库。
  for (const parent of ['apps', 'packages']) {
    for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
      if (entry.isDirectory() && (await exists(join(root, parent, entry.name, 'package.json'))))
        files.push(`${parent}/${entry.name}/package.json`);
    }
  }
  if (await exists(join(root, 'docs/package.json'))) files.push('docs/package.json');
  return files.sort();
}

export async function dependencyState(root, env = process.env) {
  const manifests = await workspaceManifests(root);
  const digest = createHash('sha256').update(
    `weq-dev-deps-v1\0${process.versions.node}\0${env.npm_config_user_agent ?? ''}\0${process.platform}-${process.arch}\0`,
  );
  for (const relative of [
    ...manifests,
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.npmrc',
    '.pnpmfile.cjs',
  ]) {
    digest.update(`${relative}\0`);
    try {
      digest.update(await readFile(join(root, relative)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      digest.update('missing');
    }
  }
  let complete = await exists(join(root, 'node_modules/.modules.yaml'));
  const installation = createHash('sha256');
  for (const relative of ['.modules.yaml', '.pnpm/lock.yaml', '.pnpm-workspace-state-v1.json']) {
    installation.update(relative);
    try {
      installation.update(await readFile(join(root, 'node_modules', relative)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      installation.update('missing');
    }
  }
  for (const relative of manifests) {
    const manifest = await readJson(join(root, relative));
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (!(await exists(join(root, dirname(relative), 'node_modules', name, 'package.json'))))
        complete = false;
    }
  }
  return { fingerprint: digest.digest('hex'), installation: installation.digest('hex'), complete };
}

export async function prepareDependencies(
  root,
  { env = process.env, run = runCommand, log = startupLog } = {},
) {
  const marker = join(root, 'node_modules/.weq-dev-dependencies.json');
  const state = await dependencyState(root, env);
  const previous = await readCache(marker);
  if (
    state.complete &&
    previous?.fingerprint === state.fingerprint &&
    previous.installation === state.installation
  ) {
    log('项目依赖已就绪', 'debug', 'dependencies');
    return;
  }
  log('正在补齐项目依赖（遵循锁文件，优先使用缓存）', 'info', 'dependencies');
  const [command, args] = pnpmCommand(
    ['install', '--frozen-lockfile', '--prefer-offline', '--prod=false'],
    env,
  );
  await run(command, args, { cwd: root, env, log, scope: 'dependencies' });
  const installed = await dependencyState(root, env);
  if (!installed.complete || installed.fingerprint !== state.fingerprint)
    throw new Error('依赖安装后仍不完整，或安装期间清单发生变化，请重试');
  await writeJson(marker, installed);
}

export function electronPackage(root) {
  const require = createRequire(join(root, 'apps/desktop/package.json'));
  return dirname(require.resolve('electron/package.json'));
}

export async function prepareBot(
  root,
  { env = process.env, run = runCommand, log = startupLog } = {},
) {
  const directory = join(root, 'resources/bot-runtime');
  const artifact = join(directory, 'bot.mjs');
  const markerPath = join(root, '.weq-dev/bot-build.json');
  const metaPath = join(root, '.weq-dev/bot-meta.json');
  const manifest = await readJson(join(root, 'package.json'));
  const fingerprint = async (inputs) => {
    const digest = createHash('sha256')
      .update(manifest.scripts['build:bot'])
      .update(await hashFile(join(root, 'pnpm-lock.yaml')));
    for (const path of Object.keys(inputs).sort())
      digest.update(`${path}\0`).update(await hashFile(resolve(root, path)));
    return digest.digest('hex');
  };
  const previous = await readCache(markerPath);
  if (previous?.inputs && (await exists(artifact))) {
    try {
      if (
        previous.fingerprint === (await fingerprint(previous.inputs)) &&
        previous.sha256 === (await hashFile(artifact))
      ) {
        log('机器人运行时已就绪', 'debug', 'build');
        return;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  log('正在构建机器人运行时', 'info', 'build');
  const started = performance.now();
  await mkdir(dirname(metaPath), { recursive: true });
  // 元数据路径经环境变量传递：走脚本参数会被 cmd.exe 再解析一次，路径带空格时
  // 会被拆成多个参数（Windows CI 上 `--metafile=<带空格路径>` 就是这样断的）。
  const [command, args] = pnpmCommand(['run', 'build:bot'], env);
  await run(command, args, {
    cwd: root,
    env: { ...env, WEQ_BOT_METAFILE: metaPath },
    log,
    scope: 'build',
  });
  const meta = await readJson(metaPath);
  if (!meta?.inputs || !Object.keys(meta.inputs).length || !(await exists(artifact)))
    throw new Error('机器人运行时构建产物或输入清单缺失');
  await writeJson(markerPath, {
    inputs: meta.inputs,
    fingerprint: await fingerprint(meta.inputs),
    sha256: await hashFile(artifact),
  });
  log(
    `机器人运行时构建完成（耗时 ${((performance.now() - started) / 1000).toFixed(1)}s）`,
    'info',
    'build',
  );
}

export async function prepareElectron(
  root,
  { env = process.env, run = runCommand, log = startupLog } = {},
) {
  env = { ...env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_OVERRIDE_DIST_PATH;
  const directory = electronPackage(root);
  log('正在检查 Electron 运行时', 'debug', 'electron');
  // Electron 自己的安装器处理平台路径、版本、缓存和镜像，不复制其判定规则。
  await run(process.execPath, [join(directory, 'install.js')], {
    cwd: root,
    env,
    log,
    scope: 'electron',
  });
  const desktop = await readJson(join(root, 'apps/desktop/package.json'));
  const installed = await readJson(join(directory, 'package.json'));
  if (installed.version !== desktop.devDependencies.electron)
    throw new Error('Electron 依赖版本与桌面清单不一致，请修复依赖安装');
  const entry = createRequire(join(root, 'apps/desktop/package.json')).resolve('electron');
  const executable = (
    await run(process.execPath, ['-e', 'process.stdout.write(require(process.argv[1]));', entry], {
      cwd: root,
      env,
      capture: true,
    })
  ).trim();
  const version = (
    await run(executable, ['-p', 'process.versions.electron'], {
      cwd: root,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      capture: true,
    })
  ).trim();
  if (version !== installed.version)
    throw new Error(`Electron 可执行文件版本不一致：需要 ${installed.version}，实际 ${version}`);
  return executable;
}

async function goSources(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'build' && !entry.name.startsWith('.'))
      paths.push(...(await goSources(join(directory, entry.name))));
    else if (
      entry.isFile() &&
      (/\.go$/.test(entry.name) || ['go.mod', 'go.sum'].includes(entry.name))
    )
      paths.push(join(directory, entry.name));
  }
  return paths.sort();
}

export async function prepareNetwork(
  root,
  {
    env = process.env,
    run = runCommand,
    log = startupLog,
    platform = process.platform,
    arch = process.arch,
  } = {},
) {
  const goos = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform];
  const goarch = { arm64: 'arm64', x64: 'amd64' }[arch];
  if (!goos || !goarch) throw new Error(`远程网络辅助程序暂不支持 ${platform}/${arch}`);
  const directory = join(root, 'tools/remote-network');
  const helper = join(
    directory,
    'build',
    `${platform}-${arch}`,
    platform === 'win32' ? 'weq-remote-network.exe' : 'weq-remote-network',
  );
  const markerPath = `${helper}.json`;
  const digest = createHash('sha256').update(`weq-dev-network-v1\0${goos}-${goarch}`);
  digest.update(await readFile(new URL('./prepare-remote-network.mjs', import.meta.url)));
  for (const key of ['GOFLAGS', 'GOEXPERIMENT', 'GOTOOLCHAIN'])
    digest.update(`${key}=${env[key] ?? ''}\0`);
  for (const path of await goSources(directory))
    digest
      .update(`${path.slice(directory.length)}\0`)
      .update(await readFile(path))
      .update('\0');
  const fingerprint = digest.digest('hex');
  const previous = await readCache(markerPath);
  if (
    previous?.fingerprint === fingerprint &&
    (await exists(helper)) &&
    previous.sha256 === (await hashFile(helper))
  ) {
    log('网络辅助程序已就绪', 'debug', 'network');
    return helper;
  }
  log('正在准备网络辅助程序（需要 Go 工具链）', 'info', 'network');
  const { remoteNetworkBuild } = await import('./prepare-remote-network.mjs');
  await run('go', ['version'], { cwd: directory, env, capture: true });
  // 复用已有平台映射和构建参数，只把执行与日志交给启动器。
  const plan = remoteNetworkBuild({
    repoDir: root,
    platform,
    arch,
    outputDirectory: dirname(helper),
    env,
  });
  await run('go', plan.args, { ...plan.options, log, scope: 'network' });
  if (!(await stat(helper)).isFile()) throw new Error('网络辅助程序未生成');
  await writeJson(markerPath, { fingerprint, sha256: await hashFile(helper) });
  log('网络辅助程序已就绪', 'info', 'network');
  return helper;
}
