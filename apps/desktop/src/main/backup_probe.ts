import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNtHelperPath } from '@weq/native';
import { runOwnedChild } from '@weq/service';
import {
  backupProbeInput,
  backupProbeResult,
  type BackupProbeInput,
} from './backup_probe_protocol';
import { resolveChildWorkerPath } from './worker_path';

/** 路径/密钥只经 stdin 传递，不进入命令行；等待进程关闭后才返回结果。 */
export async function runBackupProbe(
  input: BackupProbeInput,
  options: {
    workerPath?: string;
    executable?: string;
    nativeRoot?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
) {
  const request = backupProbeInput.parse(input);
  const worker =
    options.workerPath ??
    resolveChildWorkerPath('backupProbeWorker.mjs', dirname(fileURLToPath(import.meta.url)));
  const nativeRoot = options.nativeRoot ?? dirname(dirname(dirname(resolveNtHelperPath())));
  const result = await runOwnedChild(options.executable ?? process.execPath, [worker], {
    input: JSON.stringify(request),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WEQ_NATIVE_DIR: nativeRoot },
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 60_000,
    maxOutputBytes: 65536,
  });
  if (result.signal || result.code !== 0) {
    throw new Error(
      `备份数据库探测进程异常退出（${result.signal ?? result.code}），已隔离，不影响主窗口。`,
    );
  }
  try {
    return backupProbeResult.parse(JSON.parse(result.stdout.trim()));
  } catch {
    throw new Error('备份数据库探测进程未返回有效结果。');
  }
}
