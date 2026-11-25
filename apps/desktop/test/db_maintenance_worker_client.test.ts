import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BadPageScanCheckpoint } from '@weq/native';
import { expect, it } from 'vitest';
import { runDatabaseMaintenanceWorker } from '../src/main/db_maintenance_worker_client';

it('扫描子进程暂停前已传回的检查点可用于下一次启动', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-page-scan-worker-'));
  const workerPath = join(root, 'scan.mjs');
  const target = {
    dbDir: root,
    dbName: 'fixture.db',
    dbPath: join(root, 'fixture.db'),
    dataDir: root,
    uin: '10001',
    key: 'synthetic',
    algo: { pageHmacAlgorithm: 'SHA512', kdfHmacAlgorithm: 'SHA512' },
  };
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error('检查点未收到')), 3000);
  try {
    writeFileSync(
      workerPath,
      `let input = '';
for await (const chunk of process.stdin) input += chunk;
const { firstPage, target } = JSON.parse(input);
if (firstPage === 1) {
  const checkpoint = { firstPage, nextPage: 4097, badPages: [3], zeroPages: [21] };
  process.stdout.write(JSON.stringify({ type: 'checkpoint', checkpoint }) + '\\n');
  setInterval(() => {}, 1000);
} else if (firstPage === 4097) {
  const result = { dbPath: target.dbPath, pageCount: 4098, badPages: [4098], zeroPages: [] };
  process.stdout.write(JSON.stringify({ type: 'result', result }) + '\\n');
} else {
  process.exitCode = 1;
}`,
    );
    const options = { workerPath, executable: process.execPath, nativeRoot: root };
    const batches: BadPageScanCheckpoint[] = [];
    const paused = runDatabaseMaintenanceWorker(
      { kind: 'scan', target, firstPage: 1 },
      abort.signal,
      undefined,
      {
        ...options,
        onCheckpoint: (checkpoint) => {
          batches.push(checkpoint);
          abort.abort(new Error('暂停检查'));
        },
      },
    );
    await expect(paused).rejects.toThrow('暂停检查');
    expect(batches).toEqual([{ firstPage: 1, nextPage: 4097, badPages: [3], zeroPages: [21] }]);

    await expect(
      runDatabaseMaintenanceWorker(
        { kind: 'scan', target, firstPage: batches[0]!.nextPage },
        undefined,
        undefined,
        options,
      ),
    ).resolves.toMatchObject({ pageCount: 4098, badPages: [4098] });
  } finally {
    clearTimeout(timeout);
    abort.abort();
    rmSync(root, { recursive: true, force: true });
  }
});
