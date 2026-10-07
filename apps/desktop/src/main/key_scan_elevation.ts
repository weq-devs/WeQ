/**
 * 提权密钥扫描的**主进程半边** —— 用 `sudo -S` 起一个 root 子进程跑 nt_helper 的
 * 内存扫描。
 *
 * 为什么不能在本进程提权：Electron 拒绝以 root 运行，而读别的进程内存
 * （Linux `process_vm_readv` / macOS `task_for_pid`）在 unix 上基本都要 root。所以只有
 * 「扫描」这一段进 root 子进程，主进程按 `key_scan_worker.ts` 的 NDJSON 协议代理进度
 * 与最终结果。
 *
 * 密码来源与 attach / capture 完全一致：渲染层自绘的密码框（macOS 姿势的 `sudo -S`，
 * 不走 polkit）。**先非交互探测一次**（`sudo -n true`）——如果刚刚「读 QQ 内存 / 抓包」
 * 那条链路已经 sudo 过，凭据还在缓存里，这时就不再弹第二个框白让人输一遍。
 *
 * 有一类宿主 root 根本起不了 worker —— AppImage / 单用户 FUSE 挂载，root 对我们的
 * 二进制是 EACCES（见 attach_elevation 的 {@link installInvisibleToRoot}）。那种宿主上
 * 密码只换一次「临时放开 yama ptrace 保护」，读取仍由非特权的本进程完成（同用户 ptrace
 * 同用户，正是 ptrace_scope=0 允许的场景），完事再把原值写回。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  linuxSudoErrorHint,
  readYamaPtraceScope,
  resolveNtHelperPath,
  resolveSudoPath,
  writeYamaPtraceScope,
} from '@weq/native';
import type { KeyScanProgress, KeyScanResult } from '@weq/native';
import { getLogger } from '@weq/service';
import { installInvisibleToRoot } from './attach_elevation';
import { requestSudoPassword } from './sudo_prompt';

const logger = getLogger().child({ scope: 'key-scan-elevation' });

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the bundled `keyScanWorker.mjs`. electron-vite emits it next to the main
 * entry (`out/main/`), but this module may be chunked into `out/main/chunks/`,
 * so try the sibling path first, then one level up.
 */
function resolveWorkerPath(): string {
  const candidates = [
    join(__dirname, 'keyScanWorker.mjs'),
    join(__dirname, '..', 'keyScanWorker.mjs'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

/**
 * `sudo -n true`：非交互探测 sudo 凭据是否还在缓存里。`-n` 保证它**绝不弹提示、绝不
 * 等输入** —— 没缓存就立刻非零退出。
 */
function sudoCredentialsCached(): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(resolveSudoPath(), ['-n', 'true'], { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/** worker 往 stdout 打的一行（进度或最终结果）。 */
interface WorkerLine {
  type?: string;
  progress?: KeyScanProgress;
  result?: KeyScanResult;
}

/** 起 root 子进程跑一次密钥扫描（NDJSON 回流进度）。 */
function scanViaWorker(
  dbPath: string,
  pid: number,
  password: string,
  onProgress?: (progress: KeyScanProgress) => void,
): Promise<KeyScanResult> {
  const workerPath = resolveWorkerPath();
  const ntHelperPath = resolveNtHelperPath();

  return new Promise<KeyScanResult>((resolve, reject) => {
    // `sudo -S /usr/bin/env ELECTRON_RUN_AS_NODE=1 <electron> <worker> <db> <pid> <addon>`
    const child = spawn(
      resolveSudoPath(),
      [
        '-S',
        '/usr/bin/env',
        'ELECTRON_RUN_AS_NODE=1',
        process.execPath,
        workerPath,
        dbPath,
        String(pid),
        ntHelperPath,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let result: KeyScanResult | null = null;
    let settled = false;

    const consume = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed) as WorkerLine;
        if (parsed.type === 'progress' && parsed.progress) onProgress?.(parsed.progress);
        else if (parsed.type === 'result' && parsed.result) result = parsed.result;
      } catch {
        /* 不是 JSON：忽略（sudo / native 的杂音） */
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      let index = stdout.indexOf('\n');
      while (index >= 0) {
        consume(stdout.slice(0, index));
        stdout = stdout.slice(index + 1);
        index = stdout.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(new Error(`sudo 无法启动（是否已安装 sudo？）：${e.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      // 处理最后一行（没有换行结尾时）。
      consume(stdout);
      if (code === 0 && result) {
        logger.info('elevated key scan finished', {
          event: 'key-scan-elevated-done',
          pid,
          success: result.success,
        });
        resolve(result);
        return;
      }
      const detail = stderr.trim() || `key-scan worker 退出码 ${code}`;
      logger.warn('elevated key scan failed', {
        event: 'key-scan-elevated-failed',
        pid,
        code,
        detail,
      });
      reject(new Error(`读取 QQ 进程内存需要管理员授权：${linuxSudoErrorHint(detail)}`));
    });

    child.stdin.on('error', () => {
      // sudo 提前退出（密码错误后立即结束）——忽略 EPIPE。
    });
    child.stdin.write(`${password}\n`);
    child.stdin.end();
  });
}

/**
 * FUSE 宿主的提权姿势：root 只做一件不碰挂载点的事 —— 把 yama ptrace 保护临时放开；
 * 读取本身由非特权的我们完成（同用户 ptrace 同用户，正是 ptrace_scope=0 允许的场景），
 * 完事再把原值写回去。
 */
async function scanViaPtraceScope(
  runInProcess: () => Promise<KeyScanResult>,
  password: string,
): Promise<KeyScanResult> {
  const before = readYamaPtraceScope();
  if (before === null || before === '0') {
    // 走不到这里才对：能读到 / 已经是 0 的话，非提权那一遍就成功了。保底退回 worker。
    throw new Error('ptrace 保护无法临时放开，提权扫描不可用');
  }
  logger.info('lifting yama ptrace protection for key scan (fuse-hosted install)', {
    event: 'key-scan-ptrace-scope-lift',
    previous: before,
  });
  await writeYamaPtraceScope('0', password);
  try {
    return await runInProcess();
  } finally {
    try {
      await writeYamaPtraceScope(before, password);
      logger.info('yama ptrace protection restored', {
        event: 'key-scan-ptrace-scope-restore',
        restored: before,
      });
    } catch (error) {
      logger.warn('failed to restore ptrace_scope after key scan', {
        event: 'key-scan-ptrace-scope-restore-failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** `scanKeyElevated` 的入参。 */
export interface ElevatedKeyScanOptions {
  dbPath: string;
  pid: number;
  /** 非提权跑一遍的入口 —— FUSE 宿主上 root 只放开保护，读取仍由本进程完成。 */
  runInProcess: () => Promise<KeyScanResult>;
  onProgress?: (progress: KeyScanProgress) => void;
}

/**
 * 提权跑一次密钥扫描。需要时先弹密码框（凭据已缓存则不弹）。用户取消授权 / sudo 失败
 * 时抛错，调用方按「提权重试未完成」处理。
 */
export async function scanKeyElevated(options: ElevatedKeyScanOptions): Promise<KeyScanResult> {
  const { dbPath, pid, runInProcess, onProgress } = options;

  let password = '';
  if (!(await sudoCredentialsCached())) {
    const entered = await requestSudoPassword(
      '提权扫描密钥',
      '读取正在运行的 QQ 进程内存需要管理员权限，而 WeQ 不能以管理员身份运行 —— ' +
        '请授权一个临时的管理员子进程来完成扫描。请输入你的管理员密码。',
    );
    if (!entered) throw new Error('已取消授权，未扫描密钥。');
    password = entered;
  }

  // AppImage / 单用户 FUSE：root 读不到我们的二进制，起不了 worker；改走
  // 「root 临时放开 ptrace 保护 → 本进程自己读」。
  if (installInvisibleToRoot()) {
    return scanViaPtraceScope(runInProcess, password);
  }
  return scanViaWorker(dbPath, pid, password, onProgress);
}
