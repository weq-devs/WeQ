/**
 * Key-scan worker — the ROOT half of the elevated key-scan flow.
 *
 * 读取正在运行的 QQ 进程内存（Linux `process_vm_readv` / macOS `task_for_pid`）
 * 基本都要 root，而 Electron 拒绝以 root 运行。所以把**只有扫描**的那部分放进这个
 * 短命 root 子进程：`key_scan_elevation.ts` 用 `sudo -S` 起它（密码来自渲染层自绘的
 * 密码框），它在这里 require `nt_helper.node`，跑带进度的密钥扫描，并把结果按
 * **行分隔 JSON** 打到 stdout —— 每条进度一行 `{type:"progress",progress}`，最后一行
 * `{type:"result",result}`；失败走 stderr。
 *
 * 为什么进度能走 stdout：worker 只打这一串 NDJSON，`sudo -S` 的密码提示在 stderr、
 * 密码从 stdin 读，互不干扰（不像 capture_worker 要活到会话结束、得另开环回端口）。
 *
 * 由 electron-vite 作为独立入口打成 `.mjs`，打包后的（asar）安装也靠
 * `ELECTRON_RUN_AS_NODE` 用 electron-as-node 跑 —— 不假设用户机器上有系统 node。
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const requireFn = createRequire(__filename);

/** 与 `@weq/native` 的 `KeyScanResult` 同形（worker 不 import 工作区包）。 */
interface KeyScanResult {
  success: boolean;
  key?: string;
  keyContextHex?: string;
  error?: string;
}

/** 与 `@weq/native` 的 `KeyScanProgress` 同形。 */
interface KeyScanProgress {
  phase: string;
  percent: number;
  message: string;
}

/** 本进程用到的 nt_helper 出口（其余不碰）。 */
interface KeyScanAddon {
  getInitStatus(): number;
  scanKeyFromDatabase(dbPath: string, pid: number): Promise<KeyScanResult>;
  scanKeyFromDatabaseWithProgress?(
    dbPath: string,
    pid: number,
    onProgress?: (error: Error | null, progress: KeyScanProgress) => void,
  ): Promise<KeyScanResult>;
}

function writeLine(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** 冲掉 stdout 再退出 —— 直接 `process.exit` 可能把最后一条 result 截断。 */
function exitFlush(code: number): void {
  const timer = setTimeout(() => process.exit(code), 500);
  timer.unref();
  process.stdout.write('', () => {
    clearTimeout(timer);
    process.exit(code);
  });
}

function fail(error: string, code: number): never {
  process.stderr.write(JSON.stringify({ ok: false, error }));
  process.exit(code);
}

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  const pid = Number(process.argv[3]);
  // argv[4] 是 nt_helper.node 的绝对路径 —— 子进程里必须显式 require 这一份。
  const ntHelperPath = process.argv[4];

  if (!dbPath) fail('missing dbPath (argv[2])', 2);
  if (!Number.isInteger(pid) || pid <= 0) fail(`bad pid: ${process.argv[3]}`, 2);
  if (!ntHelperPath) fail('missing nt_helper.node path (argv[4])', 2);

  // Must run BEFORE require — the addon's LICENSE check runs on load, and it
  // walks up from cwd. The addon dir's ancestors contain the LICENSE.
  try {
    process.chdir(dirname(ntHelperPath));
  } catch (e) {
    fail(`chdir failed: ${e instanceof Error ? e.message : String(e)}`, 2);
  }

  let nt: KeyScanAddon;
  try {
    nt = requireFn(ntHelperPath) as KeyScanAddon;
  } catch (e) {
    fail(`require nt_helper.node failed: ${e instanceof Error ? e.message : String(e)}`, 1);
  }

  const initStatus = nt.getInitStatus();
  if (initStatus !== 0) fail(`nt_helper init failed (status ${initStatus})`, 1);

  try {
    const result =
      typeof nt.scanKeyFromDatabaseWithProgress === 'function'
        ? await nt.scanKeyFromDatabaseWithProgress(dbPath, pid, (error, progress) => {
            if (error) return; // 单次投递失败不影响扫描本身
            writeLine({ type: 'progress', progress });
          })
        : await nt.scanKeyFromDatabase(dbPath, pid);
    writeLine({ type: 'result', result });
    exitFlush(0);
  } catch (e) {
    fail(`key scan failed: ${e instanceof Error ? e.message : String(e)}`, 1);
  }
}

void main();
