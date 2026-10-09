/**
 * Linux 提权小工具（`sudo -S`）—— 被 attach / 抓包 / 内存扫描等需要 root 的
 * 子进程复用。
 *
 * 渲染层弹密码框，密码经 stdin 喂给 `sudo -S`，root 只做受控的字节级操作
 * （cp / rm / echo）；密码只在函数内内存活，不落盘、不进日志。
 *
 * 本文件只保留与在线实例 attach / 抓包 / 内存扫描共用的提权 + yama ptrace 开关。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

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

/** 提权执行结果。 */
export interface ElevatedResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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

// ---------- yama ptrace 保护 -----------------------------------------------

/** yama 的 ptrace_scope：0 = 同用户进程之间可以互相 ptrace。 */
export const YAMA_PTRACE_SCOPE_PATH = '/proc/sys/kernel/yama/ptrace_scope';

/** 读当前 ptrace_scope（世界可读）；内核没编 yama / 读不到 → null。 */
export function readYamaPtraceScope(): string | null {
  try {
    const value = readFileSync(YAMA_PTRACE_SCOPE_PATH, 'utf-8').trim();
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

/**
 * 以管理员权限写 ptrace_scope。只接受 0–3（不把外部字符串拼进 shell）；失败
 * 按 {@link linuxSudoErrorHint} 抛友好错误。
 */
export async function writeYamaPtraceScope(value: string, password: string): Promise<void> {
  if (!/^[0-3]$/.test(value)) throw new Error(`ptrace_scope 取值非法：${value}`);
  await runSudoChecked(`echo ${value} > ${YAMA_PTRACE_SCOPE_PATH}`, password);
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
  // AppImage / 单用户 FUSE 安装：root 读不到挂载点里的文件，sudo 起的 worker
  // 在 exec 我们自己的二进制时就被内核拒绝（`env: "…": 权限不够`）。密码其实
  // 是对的、提权也成功了，所以别让用户去查 sudo 配置。
  if (/^env:/.test(raw.trim()) && /权限不够|permission denied|eacces/i.test(raw)) {
    return (
      `${raw}\n\n` +
      '这是 FUSE 的挂载语义：AppImage（以及单用户 FUSE 家目录）里的文件默认只有挂载者能访问，' +
      'root 也读不到，因此提权子进程跑不了 WeQ 自己的程序 —— 不是 sudo / 密码的问题。'
    );
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

export { shq };
