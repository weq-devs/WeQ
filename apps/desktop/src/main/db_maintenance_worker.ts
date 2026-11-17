import { dirname } from 'node:path';
import { loadNative, resolveNtHelperPath } from '@weq/native';
import type { DatabaseMaintenanceWorkerRequest } from './db_maintenance_worker_types';
import { probeDbLayout } from '@weq/service';
import { inspectDatabase } from './db_checkup_core';
import { DatabaseScanUnsupportedError } from '@weq/service/db-checkup';

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 64 * 1024 * 1024) throw new Error('数据库维护请求过大。');
  }
  const request = JSON.parse(input) as DatabaseMaintenanceWorkerRequest;
  process.chdir(dirname(resolveNtHelperPath()));
  const { ntHelper: nt } = loadNative();
  const progress = (value: unknown) =>
    process.stdout.write(`${JSON.stringify({ type: 'progress', progress: value })}\n`);
  let result: unknown;
  if (request.kind === 'repair') {
    result = await nt.recoverDatabase(request.options, (error, tick) => {
      if (!error) progress(tick);
    });
  } else {
    const layout = probeDbLayout(request.target.dbPath);
    if (request.kind === 'scan' && layout.fileBytes < layout.headerOffset + 4096)
      throw new DatabaseScanUnsupportedError(
        '此文件没有完整的数据库数据页，当前不支持重建；未能执行常规扫描。',
      );
    if (request.kind === 'scan') {
      const scan = await nt.scanBadPages(
        request.target.dbPath,
        request.target.key,
        request.target.algo,
        (error, tick) => {
          if (!error)
            progress({ ...tick, ...((tick.badPages ?? 0) > 0 ? { outcome: 'abnormal' } : {}) });
        },
      );
      progress({
        step: 'pages',
        message: scan.usedHmac ? '页扫描完成' : '此数据库没有可校验的页签名',
        completed: scan.usedHmac ? scan.pageCount : 0,
        total: scan.pageCount,
        unit: 'pages',
        badPages: scan.badPages.length,
        zeroPages: scan.zeroPages.length,
        status: scan.usedHmac ? 'completed' : 'skipped',
        outcome: !scan.usedHmac ? 'unverified' : scan.badPages.length ? 'abnormal' : 'normal',
      });
      result = {
        ...scan,
        dbName: request.target.dbName,
        dbPath: request.target.dbPath,
        affected: [],
        sourceLayout: layout.needsMigration ? 'standard' : 'qq',
      };
    } else result = (await inspectDatabase(nt, request.target, progress, 'deep')).integrity;
  }
  process.stdout.write(`${JSON.stringify({ type: 'result', result })}\n`, () => process.exit(0));
}
void main().catch((error: unknown) => {
  process.stdout.write(
    `${JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : String(error), code: error instanceof DatabaseScanUnsupportedError ? 'unsupported-source' : undefined })}\n`,
    () => process.exit(1),
  );
});
