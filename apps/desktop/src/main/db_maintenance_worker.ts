import { dirname } from 'node:path';
import { loadNative, resolveNtHelperPath } from '@weq/native';
import type { DatabaseMaintenanceWorkerRequest } from './db_maintenance_worker_types';
import { mapBadPagesToObjects, probeDbLayout } from '@weq/service';
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
  if (request.kind === 'layout') {
    // Independent process: a raw descriptor close must not release SQLite's locks in WeQ.
    const result = probeDbLayout(request.dbPath);
    process.stdout.write(`${JSON.stringify({ type: 'result', result })}\n`, () => process.exit(0));
    return;
  }
  process.chdir(dirname(resolveNtHelperPath()));
  const { ntHelper: nt } = loadNative();
  const progress = (value: unknown) =>
    process.stdout.write(`${JSON.stringify({ type: 'progress', progress: value })}\n`);
  let result: unknown;
  if (request.kind === 'repair') {
    const reportProgress = (error: Error | null, tick: import('@weq/native').RecoverProgress) => {
      if (!error) progress(tick);
    };
    if (request.method === 'quick') {
      if (!nt.repairDatabaseQuick) throw new Error('当前原生组件不支持快速修复。');
      result = await nt.repairDatabaseQuick(
        request.options,
        request.references ?? [],
        reportProgress,
      );
    } else if (request.streaming) {
      if (!nt.recoverDatabaseStreaming) throw new Error('当前原生组件不支持流式重建。');
      result = await nt.recoverDatabaseStreaming(request.options, reportProgress);
    } else result = await nt.recoverDatabase(request.options, reportProgress);
  } else if (request.kind === 'clone-backup') {
    if (!nt.cloneDatabaseRepairBackup) throw new Error('当前原生组件不支持同卷克隆备份。');
    await nt.cloneDatabaseRepairBackup(request.source, request.target);
    result = { cloned: true };
  } else if (request.kind === 'locate') {
    const { dbPath, dbDir, key, algo } = request.target;
    const scan = request.scan;
    progress({ step: 'mapping', message: '定位坏页所属表与索引' });
    const evidence = await nt
      .inspectDatabaseQuickPages?.(dbPath, key, algo, scan.badPages, request.references)
      .catch(() => undefined);
    const candidates = [
      { name: '空闲叶页', pagetype: 'freelist-leaf', pages: evidence?.freeLeaves ?? [] },
      { name: '已核验的备份页', pagetype: 'backup-page', pages: evidence?.backupMatches ?? [] },
    ];
    const known = new Set(candidates.flatMap((candidate) => candidate.pages));
    const unresolved = scan.badPages.filter((page) => !known.has(page));
    const affected = nt.locateDatabaseBadPages
      ? await nt.locateDatabaseBadPages(dbPath, key, algo, unresolved).catch(() => [])
      : await mapBadPagesToObjects(nt, dbPath, key, algo, unresolved);
    for (const { name, pagetype, pages } of candidates) {
      if (pages.length)
        affected.push({
          name,
          pagetype,
          badPageCount: pages.length,
          samplePages: pages.slice(0, 20),
        });
    }
    const canQuick =
      !!nt.repairDatabaseQuick &&
      scan.usedHmac &&
      !scan.plaintext &&
      scan.sourceLayout !== 'standard' &&
      !scan.trailingBytes &&
      known.size === scan.badPages.length &&
      known.size > 0 &&
      known.size <= 128;
    const quickBudgetBytes = canQuick
      ? await nt.probeDatabaseCloneBudget?.(dbDir).catch(() => undefined)
      : undefined;
    result = { affected, quickBudgetBytes };
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
