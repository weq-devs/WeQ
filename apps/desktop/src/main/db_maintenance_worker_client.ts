import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNtHelperPath, type RecoverReport, type RecoverProgress } from '@weq/native';
import {
  runOwnedChild,
  type BadPageScanReport,
  type DbRepairCheckupIntegrity,
  type DatabaseWorkProgress,
} from '@weq/service';
import { resolveChildWorkerPath } from './worker_path';
import type { DatabaseMaintenanceWorkerRequest } from './db_maintenance_worker_types';
import { DatabaseScanUnsupportedError } from '@weq/service/db-checkup';

export async function runDatabaseMaintenanceWorker(
  request: DatabaseMaintenanceWorkerRequest,
  signal: AbortSignal,
  onProgress: (progress: DatabaseWorkProgress | RecoverProgress) => void,
  options: { workerPath?: string; nativeRoot?: string; executable?: string } = {},
): Promise<BadPageScanReport | DbRepairCheckupIntegrity | RecoverReport> {
  let pending = '';
  let result: BadPageScanReport | DbRepairCheckupIntegrity | RecoverReport | undefined;
  let error: string | undefined;
  let code: string | undefined;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'progress') onProgress(event.progress);
    else if (event.type === 'result') result = event.result;
    else if (event.type === 'error') {
      error = event.error;
      code = event.code;
    }
  };
  const done = await runOwnedChild(
    options.executable ?? process.execPath,
    [
      options.workerPath ??
        resolveChildWorkerPath('dbMaintenanceWorker.mjs', dirname(fileURLToPath(import.meta.url))),
    ],
    {
      input: JSON.stringify(request),
      signal,
      killAfterMs: 2000,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        WEQ_NATIVE_DIR: options.nativeRoot ?? dirname(dirname(dirname(resolveNtHelperPath()))),
      },
      timeoutMs: 24 * 60 * 60_000,
      maxOutputBytes: 64 * 1024 * 1024,
      onStdout: (text) => {
        pending += text;
        for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
          consume(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
      },
    },
  );
  consume(pending);
  if (done.code !== 0 || !result) {
    const message = error ?? '数据库维护进程未返回有效结果。';
    throw code === 'unsupported-source'
      ? new DatabaseScanUnsupportedError(message)
      : new Error(message);
  }
  if (
    request.kind === 'scan' &&
    (!('dbPath' in result) || result.dbPath !== request.target.dbPath || !('pageCount' in result))
  )
    throw new Error('源库扫描结果无效。');
  if (request.kind === 'deep' && !('ran' in result)) throw new Error('结构体检结果无效。');
  if (
    request.kind === 'repair' &&
    (!('outPath' in result) || result.outPath !== request.options.outPath)
  )
    throw new Error('临时重建结果无效。');
  return result;
}
