/**
 * macOS 提权扫内存 —— `sudo -S` 拉起 {@link mac_scan_worker} 的封装。
 *
 * 与 ninebird 安装同一套提权姿势：渲染层弹密码框，密码经 stdin 喂给
 * `/usr/bin/sudo -S`，root 只跑一个短命子进程（electron-as-node 加载
 * nt_helper.node 调 `scanKeyFromDatabase`）。密码不落盘、不进日志。
 *
 * 结果说明：扫描本身成功与否由 worker 的 JSON 决定；只有「读内存」这步
 * 需要 root，所以密码错误 / TCC 拒绝会在这里直接变成带提示的异常。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveNtHelperPath } from '@weq/native';
import { getLogger } from '@weq/service';

const logger = getLogger().child({ scope: 'mac-scan-elevation' });

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 找到 electron-vite 打出来的 `macScanWorker.mjs`（out/main/ 或 chunks/ 上一级）。 */
function resolveWorkerPath(): string {
  const candidates = [
    join(__dirname, 'macScanWorker.mjs'),
    join(__dirname, '..', 'macScanWorker.mjs'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

export interface MacKeyScanResult {
  success: boolean;
  key?: string;
  keyContextHex?: string;
  pid: number;
  error?: string;
}

/**
 * 以管理员权限扫描 QQ 进程内存并验证数据库密钥。
 * 密码经 sudo stdin 传入；成功返回密钥，失败抛带友好提示的 Error。
 */
export function runElevatedKeyScan(
  pid: number,
  dbPath: string,
  password: string,
): Promise<MacKeyScanResult> {
  const workerPath = resolveWorkerPath();
  const ntHelperPath = resolveNtHelperPath();
  logger.info('elevated mac memory scan start', {
    event: 'mac-scan-start',
    pid,
    dbPath,
  });

  return new Promise((resolve, reject) => {
    // `sudo -S /usr/bin/env ELECTRON_RUN_AS_NODE=1 <electron> <worker> <pid> <db> <addon>`
    // sudo 会重置环境，`env` 把 electron-as-node 需要的唯一变量补回去。
    const child = spawn(
      '/usr/bin/sudo',
      [
        '-S',
        '/usr/bin/env',
        'ELECTRON_RUN_AS_NODE=1',
        process.execPath,
        workerPath,
        String(pid),
        dbPath,
        ntHelperPath,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', (e) => {
      reject(new Error(`sudo 无法启动：${e.message}`));
    });
    child.on('close', (code) => {
      const out = stdout.trim();
      const err = stderr.trim();
      if (code === 0 && out) {
        try {
          const parsed = JSON.parse(out) as { ok: boolean; key?: string; keyContextHex?: string };
          if (parsed.ok && parsed.key) {
            logger.info('elevated mac memory scan succeeded', {
              event: 'mac-scan-success',
              pid,
            });
            resolve({
              success: true,
              key: parsed.key,
              ...(parsed.keyContextHex ? { keyContextHex: parsed.keyContextHex } : {}),
              pid,
            });
            return;
          }
        } catch {
          /* fall through to hint below */
        }
      }

      // 密码错误 / TCC 拒绝先给专门提示；其余带 worker 的原始报错。
      const hint = sudoErrorHint(err || out || `扫描进程退出码 ${code ?? '?'}`);
      logger.warn('elevated mac memory scan failed', {
        event: 'mac-scan-failed',
        pid,
        code,
        stderr: err,
      });
      reject(new Error(`扫描 QQ 进程内存需要管理员权限：${hint}`));
    });

    child.stdin.on('error', () => {
      // sudo 提前退出（密码错误后立即结束）——忽略 EPIPE。
    });
    child.stdin.write(`${password}\n`);
    child.stdin.end();
  });
}

/** 把 sudo / TCC 的原始报错转成用户可读的提示。 */
function sudoErrorHint(raw: string): string {
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
