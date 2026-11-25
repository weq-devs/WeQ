import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNtHelperPath, type RecoverReport, type RecoverProgress } from '@weq/native';
import {
  runOwnedChild,
  type BadPageScanReport,
  type DatabasePageLocation,
  type DbRepairCheckupIntegrity,
  type DbRepairLayoutProbe,
  type DatabaseWorkProgress,
} from '@weq/service';
import { resolveChildWorkerPath } from './worker_path';
import type { DatabaseMaintenanceWorkerRequest } from './db_maintenance_worker_types';
import { DatabaseScanUnsupportedError } from '@weq/service/db-checkup';

type DatabaseMaintenanceWorkerResult =
  | BadPageScanReport
  | DatabasePageLocation
  | BadPageScanReport
  | DatabasePageLocation['affected']
  | DbRepairCheckupIntegrity
  | RecoverReport
  | DbRepairLayoutProbe;

export async function runDatabaseMaintenanceWorker(
  request: DatabaseMaintenanceWorkerRequest,
  signal: AbortSignal | undefined,
  onProgress: (progress: DatabaseWorkProgress | RecoverProgress) => void = () => {},
  options: { workerPath?: string; nativeRoot?: string; executable?: string } = {},
): Promise<DatabaseMaintenanceWorkerResult> {
  let pending = '';
  let result: DatabaseMaintenanceWorkerResult | undefined;
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
  const rawRead = request.kind === 'layout';
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
        ...(!rawRead && {
          WEQ_NATIVE_DIR: options.nativeRoot ?? dirname(dirname(dirname(resolveNtHelperPath()))),
        }),
      },
      timeoutMs: rawRead ? 15_000 : 24 * 60 * 60_000,
      maxOutputBytes: rawRead ? 64 * 1024 : 64 * 1024 * 1024,
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
  if (
    request.kind === 'layout' &&
    (!('dbPath' in result) || result.dbPath !== request.dbPath || !('needsMigration' in result))
  )
    throw new Error('源库布局检测结果无效。');
  if (request.kind === 'locate' && !('affected' in result)) throw new Error('坏页归属结果无效。');
  if (request.kind === 'deep' && !('ran' in result)) throw new Error('结构体检结果无效。');
  if (
    request.kind === 'repair' &&
    (!('outPath' in result) || result.outPath !== request.options.outPath)
  )
    throw new Error('临时重建结果无效。');
  return result;
}
