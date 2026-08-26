/**
 * macOS NineBird 安装器 —— napcat-mac-installer 机制的 TS 移植。
 *
 * 原理（与 NapCat-Mac-Installer 完全一致，已在其生产环境验证）：
 *
 *   1. QQ 是沙箱 Electron 应用，只能读写自己的容器
 *      `~/Library/Containers/com.tencent.qq/Data/`，所以 NineBird 的
 *      loader JS + NineBird.node 必须部署进容器 Documents 下，QQ 运行时
 *      才能 require 到。
 *   2. `/Applications/QQ.app/Contents/Resources/app/package.json` 的
 *      `main` 字段是 Electron 入口，普通进程没有写权限，需要提权修改
 *      （备份成 `.bak`，再把修改后的文件拷回去）。
 *   3. loader（`loadNineBird.js`）按 `--no-sandbox` 参数决定走 NineBird
 *      还是原版 QQ 启动器——与 napcat 的 `loadNapCat.js` 同一个约定。
 *
 * 提权方式：不用 polkit（macOS 没有），也不用 osascript 的 Authorization
 * Services（Electron 环境下常直接 -60007 连授权框都不弹），照抄 napcat 的
 * `sudo -S` 方案——渲染层弹密码框，主进程把密码经 stdin 喂给 sudo，root
 * 只做两个字节级 cp（备份 + 覆盖）。其余一切（容器文件、热更新
 * package.json）都在用户权限内完成。
 */

import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

import type { NineBirdResources } from '../types';

// ---------- 路径 -----------------------------------------------------------

export const QQ_BUNDLE_ID = 'com.tencent.qq';

/** QQ 沙箱容器数据根：`~/Library/Containers/com.tencent.qq/Data`。 */
export function qqContainerDataRoot(home = homedir()): string {
  return join(home, 'Library', 'Containers', QQ_BUNDLE_ID, 'Data');
}

/**
 * NineBird 在 QQ 容器内的部署目录。QQ 的 loader 只能读到这里——
 * WeQ 安装目录（app bundle）对沙箱 QQ 不可见。
 */
export function nineBirdInstallDir(home = homedir()): string {
  return join(qqContainerDataRoot(home), 'Documents', 'weq-ninebird');
}

/** QQ 应用资源目录：`<app>/Contents/Resources/app`（从 QQ 可执行文件推导）。 */
export function qqAppDir(qqExePath: string): string {
  // dirname(exe) = …/Contents/MacOS；上一层就是 Contents。
  return join(dirname(qqExePath), '..', 'Resources', 'app');
}

export interface DarwinInstallPaths {
  /** QQ 主可执行文件（/Applications/QQ.app/Contents/MacOS/QQ）。 */
  qqExe: string;
  /** `<app>/Contents/Resources/app`。 */
  appDir: string;
  packageJson: string;
  /** package.json.bak —— 提权备份的原始入口。 */
  packageBackup: string;
  /** 容器内的 NineBird 部署目录。 */
  installDir: string;
  /** 容器内的入口 shim（package.json main 指向它）。 */
  loaderJs: string;
  /** 容器内的 hooker（loader JS 用 NINEBIRD_LOADER_DIR 找到它）。 */
  nineBirdNode: string;
  qqntJson: string;
  /** 容器内的热更新入口列表（`versions/<v>/QQUpdate.app/…/package.json`）。 */
  versionsDir: string;
}

export function darwinPaths(qqExe: string, home = homedir()): DarwinInstallPaths {
  const appDir = qqAppDir(qqExe);
  const installDir = nineBirdInstallDir(home);
  return {
    qqExe,
    appDir,
    packageJson: join(appDir, 'package.json'),
    packageBackup: join(appDir, 'package.json.bak'),
    installDir,
    loaderJs: join(installDir, 'loadNineBird.js'),
    nineBirdNode: join(installDir, 'NineBird.node'),
    qqntJson: join(installDir, 'qqnt.json'),
    versionsDir: join(
      qqContainerDataRoot(home),
      'Library',
      'Application Support',
      'QQ',
      'versions',
    ),
  };
}

// ---------- 状态 -----------------------------------------------------------

export type NineBirdPatchStatus =
  | { kind: 'missing' }
  | { kind: 'original'; main: string }
  | { kind: 'ninebird'; main: string }
  | { kind: 'custom'; main: string }
  | { kind: 'failed'; error: string };

/** QQ 各版本的原版入口（与 napcat-mac-installer 的 originalLoaders 一致）。 */
export const ORIGINAL_LOADERS = [
  './application.asar/app_launcher/index.js',
  './application/app_launcher/index.js',
  './app_launcher/index.js',
];

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
}

function packageMain(paths: DarwinInstallPaths): string | null {
  if (!existsSync(paths.packageJson)) return null;
  const pkg = readJson(paths.packageJson);
  return typeof pkg.main === 'string' ? pkg.main : '';
}

/** package.json main 指向我们 loader 的相对路径（与 napcat 相同算法）。 */
export function loaderMain(paths: DarwinInstallPaths): string {
  return relative(paths.appDir, paths.loaderJs);
}

/** 读取当前入口状态：原版 / NineBird / 自定义 / 缺失。 */
export function getPatchStatus(paths: DarwinInstallPaths): NineBirdPatchStatus {
  try {
    const main = packageMain(paths);
    if (main === null) return { kind: 'missing' };
    if (main === loaderMain(paths)) return { kind: 'ninebird', main };
    if (ORIGINAL_LOADERS.includes(main)) return { kind: 'original', main };
    return { kind: 'custom', main };
  } catch (e) {
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}

/** 按 buildVersion 选原版入口（napcat 同款版本阈值）。 */
function originalLoader(buildVersion?: string): string {
  if (!buildVersion) return './application.asar/app_launcher/index.js';
  const v = Number(buildVersion);
  if (v >= 29271) return './application.asar/app_launcher/index.js';
  if (v >= 28060) return './application/app_launcher/index.js';
  return './app_launcher/index.js';
}

// ---------- 提权（sudo -S，napcat 同款） ----------------------------------

/** shell 单引号转义（路径里没有单引号也统一走这个，防注入）。 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface ElevatedResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * 以管理员权限执行一段短小的 sh 脚本（只允许受控的 cp 类操作）。
 * 密码通过 stdin 喂给 `sudo -S`，主进程保持非特权。密码只在本函数内
 * 存活，不落盘、不进日志。
 */
export function runSudo(script: string, password: string): Promise<ElevatedResult> {
  const child = spawn('/usr/bin/sudo', ['-S', '/bin/sh', '-c', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (d: Buffer) => stdout.push(d));
  child.stderr.on('data', (d: Buffer) => stderr.push(d));
  const exitCode = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? -1));
  });
  child.stdin.on('error', () => {
    // sudo 提前退出（例如密码错误后立即结束）——忽略 EPIPE。
  });
  child.stdin.write(`${password}\n`);
  child.stdin.end();
  return exitCode.then((code) => ({
    stdout: Buffer.concat(stdout).toString('utf-8').trim(),
    stderr: Buffer.concat(stderr).toString('utf-8').trim(),
    exitCode: code,
  }));
}

function elevatedErrorHint(raw: string): string {
  const lower = raw.toLowerCase();
  if (
    lower.includes('incorrect password') ||
    lower.includes('sorry, try again') ||
    lower.includes('password is required')
  ) {
    return `管理员密码错误：${raw}`;
  }
  if (lower.includes('not in the sudoers file')) {
    return `当前用户没有 sudo 权限：${raw}`;
  }
  if (
    lower.includes('not permitted') ||
    lower.includes('not authorized') ||
    lower.includes('-1743')
  ) {
    return (
      `${raw}\n\n解决办法：请在「系统设置 → 隐私与安全性 → App 管理」中添加本程序` +
      `（WeQ），然后重新点击按钮重试。如已添加仍失败，请先移除后重新添加，` +
      `并完全退出 WeQ 后重试。`
    );
  }
  return raw;
}

/** 提权执行；非零退出码抛错并附上友好提示（密码错误 / TCC 修复）。 */
async function runSudoChecked(script: string, password: string): Promise<void> {
  const result = await runSudo(script, password);
  if (result.exitCode !== 0) {
    const raw = result.stderr || result.stdout || `sudo 退出码 ${result.exitCode}`;
    throw new Error(elevatedErrorHint(raw));
  }
}

// ---------- 入口补丁 --------------------------------------------------------

/**
 * 备份 + 覆盖 `/Applications/QQ.app/…/package.json`。
 * TS 先把 patched JSON 写到自己的临时文件（非特权），root 只做两次 cp：
 * 备份（.bak 已存在时不覆盖，避免把已补丁的入口当原始入口存下来）+ 覆盖。
 */
export async function installEntry(
  paths: DarwinInstallPaths,
  password: string,
): Promise<void> {
  if (!existsSync(paths.packageJson)) {
    throw new Error(`未找到 QQ 入口配置：${paths.packageJson}`);
  }
  const pkg = readJson(paths.packageJson);
  const patched = { ...pkg, main: loaderMain(paths) };
  const tmp = join(tmpdir(), `weq-package-${process.pid}-${Date.now()}.json`);
  writeFileSync(tmp, `${JSON.stringify(patched, null, 2)}\n`);
  try {
    const script = [
      `PKG=${shq(paths.packageJson)}`,
      `BAK=${shq(paths.packageBackup)}`,
      `TMP=${shq(tmp)}`,
      `[ -f "$BAK" ] || cp -p "$PKG" "$BAK"`,
      `cp "$TMP" "$PKG"`,
    ].join('\n');
    await runSudoChecked(script, password);
  } finally {
    rmSync(tmp, { force: true });
  }
  // 热更新包在容器内，用户权限即可写，无需提权。
  patchHotUpdatePackages(paths);
}

/** 从 .bak 恢复原版入口（提权），并还原热更新包入口。 */
export async function restoreEntry(
  paths: DarwinInstallPaths,
  password: string,
): Promise<void> {
  if (!existsSync(paths.packageBackup)) {
    throw new Error(`未找到备份文件：${paths.packageBackup}`);
  }
  const script = [
    `PKG=${shq(paths.packageJson)}`,
    `BAK=${shq(paths.packageBackup)}`,
    `[ -f "$BAK" ] || { echo "backup missing: $BAK" >&2; exit 1; }`,
    `cp -p "$BAK" "$PKG"`,
  ].join('\n');
  await runSudoChecked(script, password);
  restoreHotUpdatePackages(paths);
}

// ---------- 热更新包 --------------------------------------------------------

/** 容器 `versions/<v>/QQUpdate.app/Contents/Resources/app/package.json` 列表。 */
export function hotUpdatePackageUrls(paths: DarwinInstallPaths): string[] {
  if (!existsSync(paths.versionsDir)) return [];
  const urls: string[] = [];
  for (const dir of readdirSafe(paths.versionsDir)) {
    const url = join(
      paths.versionsDir,
      dir,
      'QQUpdate.app',
      'Contents',
      'Resources',
      'app',
      'package.json',
    );
    if (existsSync(url)) urls.push(url);
  }
  return urls;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** 把所有热更新包入口指向我们的 loader（napcat patchHotUpdatePackages 同款）。 */
export function patchHotUpdatePackages(paths: DarwinInstallPaths): number {
  let patched = 0;
  const loaderMainPath = loaderMain(paths);
  for (const pkgUrl of hotUpdatePackageUrls(paths)) {
    try {
      const pkg = readJson(pkgUrl);
      const main = pkg.main;
      if (typeof main !== 'string' || main === loaderMainPath) continue;
      pkg.main = loaderMainPath;
      writeJson(pkgUrl, pkg);
      patched++;
    } catch {
      // 单个热更新包损坏不影响主入口，跳过。
    }
  }
  return patched;
}

/** 把热更新包入口恢复为对应 buildVersion 的原版入口。 */
export function restoreHotUpdatePackages(paths: DarwinInstallPaths): number {
  let restored = 0;
  for (const pkgUrl of hotUpdatePackageUrls(paths)) {
    try {
      const pkg = readJson(pkgUrl);
      const main = pkg.main;
      if (typeof main !== 'string' || !main.includes('loadNineBird.js')) continue;
      pkg.main = originalLoader(
        typeof pkg.buildVersion === 'string' ? pkg.buildVersion : undefined,
      );
      writeJson(pkgUrl, pkg);
      restored++;
    } catch {
      // 同上，尽力而为。
    }
  }
  return restored;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------- 部署 ------------------------------------------------------------

/** `loadNineBird.js` shim：`--no-sandbox` 走 NineBird，否则原版启动器。 */
export function loaderShimContent(paths: DarwinInstallPaths): string {
  const fallbackLoader = join(paths.installDir, 'qr-dbkey.js');
  const appLauncher = join(paths.appDir, 'app_launcher', 'index.js');
  return [
    `const loadNineBird = process.argv.includes('--no-sandbox');`,
    `const package = require(${JSON.stringify(paths.packageJson)});`,
    `if (loadNineBird) {`,
    `    require(process.env.NINEBIRD_LOAD_PATH || ${JSON.stringify(fallbackLoader)});`,
    `} else {`,
    `    require(${JSON.stringify(appLauncher)});`,
    `    setImmediate(() => {`,
    `        if (global.launcher && global.launcher.installPathPkgJson) {`,
    `            global.launcher.installPathPkgJson.main = ((version) => {`,
    `                if (version >= 29271) return "./application.asar/app_launcher/index.js";`,
    `                if (version >= 28060) return "./application/app_launcher/index.js";`,
    `                return "./app_launcher/index.js";`,
    `            })(package.buildVersion);`,
    `        }`,
    `    });`,
    `}`,
    ``,
  ].join('\n');
}

function copyIfChanged(src: string, dst: string): void {
  if (!existsSync(src)) {
    throw new Error(`NineBird 资源缺失：${src}`);
  }
  if (existsSync(dst)) {
    try {
      if (statSync(src).size === statSync(dst).size) return;
    } catch {
      // 大小读不出来就照常覆盖。
    }
  }
  copyFileSync(src, dst);
}

/** 把 hooker + loader 脚本拷进 QQ 容器，写入口 shim（不碰 package.json）。 */
export function deployNineBirdFiles(qqExe: string, resources: NineBirdResources): void {
  const paths = darwinPaths(qqExe);
  mkdirSync(paths.installDir, { recursive: true });

  copyIfChanged(resources.nineBirdAddonPath, paths.nineBirdNode);
  copyIfChanged(resources.qqntJsonPath, paths.qqntJson);
  copyIfChanged(resources.qrDbkeyJsPath, join(paths.installDir, basename(resources.qrDbkeyJsPath)));
  copyIfChanged(
    resources.quickDbkeyJsPath,
    join(paths.installDir, basename(resources.quickDbkeyJsPath)),
  );
  copyIfChanged(
    resources.accountListJsPath,
    join(paths.installDir, basename(resources.accountListJsPath)),
  );
  // CJS 语义标记：QQ 的 Electron require 按最近的 package.json 判断模块
  // 类型。容器目录没有上级 marker 时默认 CJS，但显式写一个最稳妥
  // （与 resources/ninebird-runtime/package.json 的用途一致）。
  writeFileSync(
    join(paths.installDir, 'package.json'),
    `${JSON.stringify({ type: 'commonjs' })}\n`,
  );
  writeFileSync(paths.loaderJs, loaderShimContent(paths));
}

/**
 * 幂等检查：部署文件后确认入口状态。
 * - ninebird → 已装好，直接返回；
 * - 其它 → 抛错引导用户去设置里安装（入口补丁需要管理员密码，
 *   由设置页的密码框显式发起，不在登录流程里偷偷弹 sudo）。
 */
export async function ensureInstalled(qqExe: string, resources: NineBirdResources): Promise<void> {
  deployNineBirdFiles(qqExe, resources);
  const paths = darwinPaths(qqExe);
  const status = getPatchStatus(paths);
  switch (status.kind) {
    case 'ninebird':
      return;
    case 'custom':
      throw new Error(
        `QQ 程序入口被其他程序占用（${status.main}）。请在「设置 → 全局设置」中先还原为原版 QQ，再重试。`,
      );
    case 'missing':
      throw new Error(`未找到 QQ 入口配置：${paths.packageJson}`);
    case 'failed':
      throw new Error(`读取 QQ 入口配置失败：${status.error}`);
    case 'original':
      throw new Error(
        'QQ 程序入口还是原版。请先在「设置 → 全局设置」中安装 NineBird（需要输入管理员密码），再启动登录流程。',
      );
  }
}

/** 安装：部署文件 + 提权补丁入口 + 同步热更新包。 */
export async function installNineBird(
  qqExe: string,
  resources: NineBirdResources,
  password: string,
): Promise<void> {
  deployNineBirdFiles(qqExe, resources);
  const paths = darwinPaths(qqExe);
  const status = getPatchStatus(paths);
  switch (status.kind) {
    case 'ninebird':
      return;
    case 'custom':
      throw new Error(
        `QQ 程序入口被其他程序占用（${status.main}）。请先在「设置 → 全局设置」中还原为原版 QQ，再安装 NineBird。`,
      );
    case 'missing':
      throw new Error(`未找到 QQ 入口配置：${paths.packageJson}`);
    case 'failed':
      throw new Error(`读取 QQ 入口配置失败：${status.error}`);
    case 'original':
      await installEntry(paths, password);
  }
}

/** 卸载：恢复入口（提权）+ 恢复热更新 + 删除容器部署目录。 */
export async function uninstallNineBird(qqExe: string, password: string): Promise<void> {
  const paths = darwinPaths(qqExe);
  if (existsSync(paths.packageBackup)) {
    await restoreEntry(paths, password);
  }
  rmSync(paths.installDir, { recursive: true, force: true });
}
