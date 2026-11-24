import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const desktop = join(root, 'apps/desktop');
function run(command, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        encoding: 'utf8',
        timeout: 180_000,
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
    child.stdin.on('error', () => {
      /* 命令失败由退出回调统一报告。 */
    });
    child.stdin.end(input);
  });
}
const debuggerKey = 'com.apple.security.cs.debugger';
const bundleIdentity = {
  CFBundleIdentifier: 'app.weq.desktop.dev',
  CFBundleName: 'WeQ Dev',
  CFBundleDisplayName: 'WeQ Dev',
  CFBundleIconFile: 'weq.icns',
};

async function hash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * 读取签名里的权限。部分平台的 Electron 发行物整包未签名（zip 内没有
 * `_CodeSignature`），此时没有可继承的权限，返回 `null` 与"已签名但无权限"区分。
 */
async function entitlements(path) {
  let stdout;
  try {
    ({ stdout } = await run('/usr/bin/codesign', ['-d', '--entitlements', ':-', path]));
  } catch (error) {
    if (/is not signed/i.test(String(error.stderr ?? error.message))) return null;
    throw error;
  }
  if (!stdout.trim()) return {};
  // 交给系统解析 plist，不手工匹配 XML 字段。
  const { stdout: json } = await run(
    '/usr/bin/plutil',
    ['-convert', 'json', '-o', '-', '--', '-'],
    { input: stdout },
  );
  return JSON.parse(json);
}

async function verify(path, { deep = false } = {}) {
  // 已签名发行物的嵌套框架可能只有 linker-signed 签名，此时仅验证本轮重签的宿主；
  // 整包补签过的宿主则需要连同嵌套应用一起验证。
  const args = ['--verify', '--strict'];
  if (deep) args.push('--deep');
  args.push(path);
  await run('/usr/bin/codesign', args);
  if ((await entitlements(path))?.[debuggerKey] !== true)
    throw new Error('开发 Electron 宿主缺少调试权限。');
}

async function brandDevApp(app, staging, iconPath) {
  const plist = join(app, 'Contents/Info.plist');
  const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]);
  await writeFile(plist, JSON.stringify({ ...JSON.parse(stdout), ...bundleIdentity }));
  await run('/usr/bin/plutil', ['-convert', 'xml1', plist]);
  const iconset = join(staging, 'weq.iconset');
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      await run('/usr/bin/sips', [
        '--resampleHeightWidth',
        pixels,
        pixels,
        iconPath,
        '--out',
        join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`),
      ]);
    }
  }
  await mkdir(join(app, 'Contents/Resources'), { recursive: true });
  await run('/usr/bin/iconutil', [
    '--convert',
    'icns',
    '--output',
    join(app, 'Contents/Resources', bundleIdentity.CFBundleIconFile),
    iconset,
  ]);
}

async function runningElectronExecutables() {
  // ps 可能报告真实路径，也可能保留启动时的路径别名。
  const { stdout } = await run('/bin/ps', ['-ww', '-axo', 'comm=']);
  const commands = stdout.split('\n').map((line) => line.trim());
  return Promise.all(
    commands
      .filter((command) => command.includes('/Electron.app/Contents/'))
      .map((command) => realpath(command).catch(() => null)),
  );
}

async function selectRuntime(directory, fingerprint) {
  let running;
  for (let slot = 0; ; slot++) {
    const location = slot === 0 ? directory : join(directory, `slot-${slot}`);
    const target = join(location, 'Electron.app');
    const targetExec = join(target, 'Contents/MacOS/Electron');
    const markerPath = join(location, 'weq-runtime.json');
    const marker = (await exists(markerPath))
      ? JSON.parse(await readFile(markerPath, 'utf8'))
      : null;
    if (marker && JSON.stringify(marker) === fingerprint) {
      try {
        await verify(target);
        return { targetExec, cached: true };
      } catch {
        // 缓存损坏时重建，但不能替换正在使用的宿主。
      }
    }
    const backup = join(location, 'Electron.previous.app');
    if (await exists(backup)) throw new Error(`上次准备留有恢复资产，请先检查：${backup}`);
    if (await exists(target)) {
      if (![1, 2].includes(marker?.format) || (await lstat(target)).isSymbolicLink())
        throw new Error(`开发宿主位置已有非管理应用，未覆盖：${target}`);
      const contents = `${await realpath(target)}/Contents/`;
      running ??= await runningElectronExecutables();
      // QQ 同步监护进程可在窗口退出后继续使用旧宿主。保留完整路径，改用下一个缓存位置。
      if (running.some((path) => path?.startsWith(contents))) continue;
    }
    return { location, target, targetExec, markerPath, backup };
  }
}

/** 仅准备独立开发宿主，不改 node_modules 原件及渲染子进程签名。 */
export async function prepareDevElectron({
  executable = require('electron'),
  platform = process.platform,
  directory = join(desktop, 'dist/dev-runtime'),
  entitlementPath = join(desktop, 'build/entitlements.mac.plist'),
  iconPath = join(root, 'resources/brand/logo.png'),
} = {}) {
  if (platform !== 'darwin') return executable;
  const source = resolve(dirname(executable), '../..');
  const fingerprint = JSON.stringify({
    format: 2,
    source,
    executable: await hash(executable),
    info: await hash(join(source, 'Contents/Info.plist')),
    entitlements: await hash(entitlementPath),
    icon: await hash(iconPath),
  });
  await mkdir(directory, { recursive: true });
  const lock = join(directory, '.prepare-lock');
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`开发宿主正在准备，或上次异常退出留下锁：${lock}`);
    throw error;
  }
  let staging;
  try {
    const { location, target, targetExec, markerPath, backup, cached } = await selectRuntime(
      directory,
      fingerprint,
    );
    if (cached) return targetExec;
    await mkdir(location, { recursive: true });
    staging = await mkdtemp(join(directory, '.prepare-'));
    const app = join(staging, 'Electron.app');
    await run('/bin/cp', ['-cR', source, app]);
    // 部分平台的发行物整包未签名（zip 内没有 `_CodeSignature`），没有可继承的权限，
    // 嵌套的 Helper / Framework 也必须一并补签，否则加固运行时无法启动。
    const original = await entitlements(app);
    // macOS 通知从应用包读取身份和图标，运行时设置 Dock 图标不能代替它。
    await brandDevApp(app, staging, iconPath);
    const { stdout: configured } = await run('/usr/bin/plutil', [
      '-convert',
      'json',
      '-o',
      '-',
      entitlementPath,
    ]);
    const merged = join(staging, 'entitlements.json');
    await writeFile(merged, JSON.stringify({ ...original, ...JSON.parse(configured) }));
    await run('/usr/bin/plutil', ['-convert', 'xml1', merged]);
    const deep = original === null;
    const signArgs = ['--force'];
    if (deep) signArgs.push('--deep');
    signArgs.push(
      '--sign',
      '-',
      '--options',
      'runtime',
      '--timestamp=none',
      '--entitlements',
      merged,
      app,
    );
    await run('/usr/bin/codesign', signArgs);
    await verify(app, { deep });
    const stagedMarker = join(staging, 'weq-runtime.json');
    await writeFile(stagedMarker, fingerprint);
    const hadTarget = await exists(target);
    if (hadTarget) await rename(target, backup);
    try {
      await rename(app, target);
      await rename(stagedMarker, markerPath);
    } catch (error) {
      if (await exists(target)) await rename(target, app);
      if (hadTarget) await rename(backup, target);
      throw error;
    }
    if (hadTarget) await run('/bin/rm', ['-r', '--', backup]);
    return targetExec;
  } finally {
    try {
      if (staging) await run('/bin/rm', ['-r', '--', staging]);
    } finally {
      await rm(lock, { recursive: true });
    }
  }
}

export async function launchDevElectron(args = [], environment = process.env, executable) {
  const prepared = await prepareDevElectron(executable ? { executable } : {});
  const env = { ...environment, ELECTRON_EXEC_PATH: prepared };
  delete env.ELECTRON_RUN_AS_NODE;
  const { tsImport } = await import('tsx/esm/api');
  const { launchDevelopment } = await tsImport(
    '../apps/desktop/src/main/development_console.ts',
    import.meta.url,
  );
  return launchDevelopment(
    process.execPath,
    [fileURLToPath(new URL('./run-dev-electron.mjs', import.meta.url)), ...args],
    desktop,
    env,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== '--launch') console.log(await prepareDevElectron());
    else process.exitCode = await launchDevElectron(process.argv.slice(3));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
