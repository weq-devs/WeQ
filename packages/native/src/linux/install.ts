/**
 * Linux NineBird 安装 —— 与 macOS 同一套 `sudo -S` 提权，但只处理一个文件。
 *
 * Linux 的注入介质是 `ninebird_launcher.so`（LD_PRELOAD）：QQ 的 Electron
 * 入口由 launcher 在运行时重定向到 `<QQ>/resources/app/loadNineBird.js`，
 * 并用 raw statx 校验该文件真实存在（LD_PRELOAD 骗不过）。所以只需要在
 * 磁盘上放一个持久 stub —— **不动 package.json**（main 保持原版）。
 *
 *   - 安装 = 提权写入 `loadNineBird.js`（QQ 的 resources/app 通常 root 所有）；
 *   - 还原 = 提权删除该文件。
 *
 * stub 不随 QQ 启动自删（学习 macOS：常驻）。普通启动 QQ 时 launcher.so
 * 没有介入，main 还是原版入口，stub 根本不会被执行，留在磁盘上是无害的。
 * WeQ 启动 QQ 时 launcher 把入口重定向到 stub，stub 按 NINEBIRD_* 环境变量
 * 加载 loader（env 只有 WeQ 拉起 QQ 时才有，是比 `--no-sandbox` 更可靠的
 * 模式开关——Linux 用户可能在 qq-flags.conf 里自带 --no-sandbox）。
 *
 * 提权姿势与 macOS 完全一致：渲染层弹密码框 → 密码经 stdin 喂给
 * `sudo -S`，root 只做受控的字节级 cp / rm（TS 先把内容写临时文件，
 * root 不碰内容生成逻辑）。密码只在本函数内存活，不落盘、不进日志。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ElevatedResult } from '../darwin/install';

// ---------- 路径 -----------------------------------------------------------

/** `<QQ>/resources/app`（QQ 可执行文件在同一层目录，`../resources/app`）。 */
export function linuxAppDir(qqExePath: string): string {
  return join(dirname(qqExePath), 'resources', 'app');
}

export interface LinuxInstallPaths {
  qqExe: string;
  /** `<QQ>/resources/app`。 */
  appDir: string;
  /** 入口 stub —— Linux ninebird 唯一需要提权处理的文件。 */
  loaderJs: string;
}

export function linuxPaths(qqExePath: string): LinuxInstallPaths {
  const appDir = linuxAppDir(qqExePath);
  return {
    qqExe: qqExePath,
    appDir,
    loaderJs: join(appDir, 'loadNineBird.js'),
  };
}

// ---------- 状态 -----------------------------------------------------------

/** stub 首行标记：判断磁盘上的文件是不是「我们写的持久版」。
 *  旧版（自删 + 硬编码 loader 路径）没有这行，dropStub 会重写迁移一次。 */
export const STUB_MARKER = '// weq-ninebird-stub v2';

export interface LinuxStubStatus {
  /** `loadNineBird.js` 是否存在。 */
  installed: boolean;
  /** 是否带 {@link STUB_MARKER}（旧版自删 stub 为 false，需重写迁移）。 */
  fresh: boolean;
}

export function linuxStubStatus(paths: LinuxInstallPaths): LinuxStubStatus {
  try {
    if (!existsSync(paths.loaderJs)) return { installed: false, fresh: false };
    const content = readFileSync(paths.loaderJs, 'utf-8');
    return { installed: true, fresh: content.includes(STUB_MARKER) };
  } catch {
    return { installed: false, fresh: false };
  }
}

/**
 * 当前 package.json 的 main 绝对化（Electron 的 require 走 asar 补丁，
 * 绝对路径一样能加载）。读不到 / 不是字符串时返回 null —— 生成 shim 时
 * 省略「原版启动器」分支。
 */
export function linuxOriginalMain(appDir: string): string | null {
  const pkgPath = join(appDir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { main?: unknown };
    const main = typeof pkg.main === 'string' && pkg.main ? pkg.main : null;
    return main ? resolve(appDir, main) : null;
  } catch {
    return null;
  }
}

/**
 * 持久 stub 内容（Linux 版）。
 *
 * 与 macOS shim 的区别：
 *   - 不按 `--no-sandbox` 分支（Linux 用户可能在 qq-flags.conf 里自带该
 *     参数），而是按 NINEBIRD_* 环境变量 —— 只有 WeQ 拉起 QQ 时才有；
 *   - 不随加载自删（常驻，还原走设置页显式删除）；
 *   - loader 走 `NINEBIRD_LOAD_PATH`（WeQ 每次启动都会带当前 loader 路径），
 *     兜底用安装时记录的 WeQ loader 路径。
 */
export function linuxLoaderShimContent(
  fallbackLoader: string,
  originalMain: string | null,
): string {
  const lines = [
    STUB_MARKER,
    `function __nblog(m){ try { if (process.env.NINEBIRD_LOG) require('fs').appendFileSync(process.env.NINEBIRD_LOG, '[stub pid=' + process.pid + '] ' + m + '\\n'); } catch (e) {} }`,
    `const __weqNinebird = !!(process.env.NINEBIRD_PIPE_NAME || process.env.NINEBIRD_LOAD_PATH || process.env.NINEBIRD_LOADER_DIR);`,
    `if (__weqNinebird) {`,
    `    const __weqLoader = process.env.NINEBIRD_LOAD_PATH || ${JSON.stringify(fallbackLoader)};`,
    `    __nblog('loadNineBird.js executed, requiring loader: ' + __weqLoader);`,
    `    try { require(__weqLoader); }`,
    `    catch (e) { __nblog('require(loader) THREW: ' + (e && e.stack || e)); throw e; }`,
    `} else {`,
    `    __nblog('loadNineBird.js executed without WeQ env, requiring original launcher');`,
    `    require(${JSON.stringify(originalMain ?? fallbackLoader)});`,
    `}`,
    ``,
  ];
  return lines.join('\n');
}

// ---------- 提权（sudo -S，macOS 同款） -----------------------------------

/** shell 单引号转义（路径里没有单引号也统一走这个，防注入）。 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 解析 sudo 可执行文件（Debian/Ubuntu 在 /usr/bin，老发行版可能在 /bin）。 */
export function resolveSudoPath(): string {
  for (const candidate of ['/usr/bin/sudo', '/bin/sudo']) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* 忽略 stat 异常，继续下一个候选 */
    }
  }
  return 'sudo';
}

/**
 * 以管理员权限执行一段短小的 sh 脚本（只允许受控的 cp / rm 类操作）。
 * 密码通过 stdin 喂给 `sudo -S`，主进程保持非特权。密码只在本函数内
 * 存活，不落盘、不进日志。
 */
export function runSudo(script: string, password: string): Promise<ElevatedResult> {
  const child = spawn(resolveSudoPath(), ['-S', '/bin/sh', '-c', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (d: Buffer) => stdout.push(d));
  child.stderr.on('data', (d: Buffer) => stderr.push(d));
  const exitCode = new Promise<number>((resolveExit, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolveExit(code ?? -1));
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

/** Linux 版 sudo 报错提示（没有 macOS 的 TCC，多了 requiretty 分支）。 */
export function linuxSudoErrorHint(raw: string): string {
  const lower = raw.toLowerCase();
  if (
    lower.includes('incorrect password') ||
    lower.includes('sorry, try again') ||
    lower.includes('password is required') ||
    /密码错误|密码不正确/.test(raw)
  ) {
    return `管理员密码错误：${raw}`;
  }
  if (lower.includes('not in the sudoers file')) {
    return `当前用户没有 sudo 权限：${raw}`;
  }
  if (lower.includes('must have a tty')) {
    return (
      `sudo 配置了 requiretty，无法通过管道输入密码：${raw}\n\n` +
      `解决办法：在 /etc/sudoers 中移除 requiretty（或用 visudo 编辑），然后重试。`
    );
  }
  if (lower.includes('sudo: command not found') || lower.includes('no sudo')) {
    return `未检测到 sudo，请先安装 sudo（如 apt install sudo / pacman -S sudo）。${raw}`;
  }
  return raw;
}

/** 提权执行；非零退出码抛错并附上友好提示（密码错误 / requiretty / 无 sudo）。 */
async function runSudoChecked(script: string, password: string): Promise<void> {
  if (!password) {
    throw new Error('管理员密码为空，请重新输入后再试。');
  }
  const result = await runSudo(script, password);
  if (result.exitCode !== 0) {
    const raw = result.stderr || result.stdout || `sudo 退出码 ${result.exitCode}`;
    throw new Error(linuxSudoErrorHint(raw));
  }
}

// ---------- 安装 / 还原 ------------------------------------------------------

/**
 * 以 root 写入一个文件：TS 先把内容写到临时文件（非特权），root 只做一次
 * `cp`（内容不进 argv、不落盘）。密码只在本函数内存活。
 */
export async function writeFileAsRoot(
  path: string,
  content: string,
  password: string,
): Promise<void> {
  const tmp = join(tmpdir(), `weq-file-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, content);
  try {
    const script = [
      `SRC=${shq(tmp)}`,
      `DST=${shq(path)}`,
      `cp "$SRC" "$DST"`,
      `chmod 644 "$DST"`,
    ].join('\n');
    await runSudoChecked(script, password);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * 安装：把持久 stub 写入 `<QQ>/resources/app/loadNineBird.js`（提权）。
 * TS 先把内容写到临时文件（非特权），root 只做一次 `cp`。
 * fallbackLoader 是 WeQ 当前安装里的 loader（qr-dbkey.js），NINEBIRD_LOAD_PATH
 * 缺失时的兜底；入口已经是持久版 stub 时直接幂等返回。
 */
export async function installNineBirdLinux(
  qqExePath: string,
  fallbackLoader: string,
  password: string,
): Promise<void> {
  const paths = linuxPaths(qqExePath);
  const status = linuxStubStatus(paths);
  if (status.installed && status.fresh) return;

  const content = linuxLoaderShimContent(fallbackLoader, linuxOriginalMain(paths.appDir));
  await writeFileAsRoot(paths.loaderJs, content, password);
}

/** 还原：删除 `loadNineBird.js`（提权），package.json 本来就没动过。 */
export async function uninstallNineBirdLinux(qqExePath: string, password: string): Promise<void> {
  const paths = linuxPaths(qqExePath);
  if (!existsSync(paths.loaderJs)) return;
  const script = [`DST=${shq(paths.loaderJs)}`, `rm -f "$DST"`].join('\n');
  await runSudoChecked(script, password);
}
