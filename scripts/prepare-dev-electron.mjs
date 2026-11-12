import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const desktop = join(root, 'apps/desktop');
const require = createRequire(join(desktop, 'package.json'));
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

/** 解析依赖包的可执行入口。Windows 上 pnpm 只有 `.CMD`，spawn 找不到，故不经过 pnpm。 */
async function resolveBin(specifier, binName) {
  const packagePath = require.resolve(`${specifier}/package.json`);
  const { bin } = JSON.parse(await readFile(packagePath, 'utf8'));
  const entry = typeof bin === 'string' ? bin : bin?.[binName];
  if (!entry) throw new Error(`找不到 ${specifier} 的可执行入口。`);
  return join(dirname(packagePath), entry);
}

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

/** 仅准备独立开发宿主，不改 node_modules 原件及渲染子进程签名。 */
export async function prepareDevElectron({
  executable = require('electron'),
  platform = process.platform,
  directory = join(desktop, 'dist/dev-runtime'),
  entitlementPath = join(desktop, 'build/entitlements.mac.plist'),
} = {}) {
  if (platform !== 'darwin') return executable;
  const source = resolve(dirname(executable), '../..');
  const target = join(directory, 'Electron.app');
  const targetExec = join(target, 'Contents/MacOS/Electron');
  const markerPath = join(directory, 'weq-runtime.json');
  const fingerprint = {
    format: 1,
    source,
    executable: await hash(executable),
    entitlements: await hash(entitlementPath),
  };
  await mkdir(directory, { recursive: true });
  const lock = join(directory, '.prepare-lock');
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`开发宿主正在准备，或上次异常退出留下锁：${lock}`);
    throw error;
  }
  let staging;
  const backup = join(directory, 'Electron.previous.app');
  try {
    let marker;
    if (await exists(markerPath)) marker = JSON.parse(await readFile(markerPath, 'utf8'));
    if (marker && JSON.stringify(marker) === JSON.stringify(fingerprint)) {
      try {
        await verify(target);
        return targetExec;
      } catch {
        // 缓存损坏时重建，但不能替换正在运行的宿主。
      }
    }
    if (await exists(backup)) throw new Error(`上次准备留有恢复资产，请先检查：${backup}`);
    if (await exists(target)) {
      if (marker?.format !== 1 || (await lstat(target)).isSymbolicLink())
        throw new Error(`开发宿主位置已有非管理应用，未覆盖：${target}`);
      const { stdout } = await run('/bin/ps', ['-axo', 'comm=']);
      if (stdout.split('\n').some((line) => line.trim().startsWith(`${target}/Contents/`)))
        throw new Error('开发宿主需要更新，请先按 Cmd+Q 退出 WeQ 后重新启动。');
    }
    staging = await mkdtemp(join(directory, '.prepare-'));
    const app = join(staging, 'Electron.app');
    await run('/bin/cp', ['-cR', source, app]);
    // 部分平台的发行物整包未签名（zip 内没有 `_CodeSignature`），没有可继承的权限，
    // 嵌套的 Helper / Framework 也必须一并补签，否则加固运行时无法启动。
    const original = await entitlements(app);
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
    await writeFile(stagedMarker, JSON.stringify(fingerprint));
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const executable = await prepareDevElectron();
    if (process.argv[2] !== '--launch') console.log(executable);
    else {
      const env = { ...process.env, ELECTRON_EXEC_PATH: executable };
      delete env.ELECTRON_RUN_AS_NODE;
      const { tsImport } = await import('tsx/esm/api');
      const { launchDevelopment } = await tsImport(
        '../apps/desktop/src/main/development_console.ts',
        import.meta.url,
      );
      process.exitCode = await launchDevelopment(
        process.execPath,
        [await resolveBin('electron-vite', 'electron-vite'), 'dev', ...process.argv.slice(3)],
        desktop,
        env,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
