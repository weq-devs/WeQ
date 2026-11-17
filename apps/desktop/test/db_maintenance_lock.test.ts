// @vitest-environment node
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { DbRepairTarget } from '@weq/service';
import { DatabaseMaintenanceLock } from '../src/main/db_maintenance_lock';

const options = {
  workerPath: fileURLToPath(new URL('./fixtures/db-maintenance-lock-worker.mjs', import.meta.url)),
  nativeRoot: '/synthetic/native',
  executable: process.execPath,
};
const target: DbRepairTarget = {
  uin: 'synthetic',
  dbName: 'ready.db',
  dbPath: '/synthetic/ready.db',
  dbDir: '/synthetic',
  dataDir: null,
  key: 'synthetic',
  algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
};

it('扫描停止后持锁进程保持运行；替换需要明确确认，结束维护等待实际进程退出', async () => {
  const worker = new DatabaseMaintenanceLock(options);
  const abort = new AbortController();
  try {
    expect(await worker.begin('session', [target], abort.signal)).toEqual([
      { dbPath: target.dbPath },
    ]);
    abort.abort();
    expect(worker.signal.aborted).toBe(false);
    await worker.protect(target.dbPath, '/synthetic/product.db');
    expect(process.kill(worker.pid!, 0)).toBe(true);
    await worker.end();
    expect(() => process.kill(worker.pid!, 0)).toThrow();
    expect(worker.signal.aborted).toBe(false);
  } finally {
    await worker.terminate();
  }
});

it('持锁启动可主动取消，意外退出会立即失效，而不是继续接受替换请求', async () => {
  const starting = new DatabaseMaintenanceLock(options);
  const abort = new AbortController();
  const pending = starting.begin('starting', [{ ...target, dbName: 'hang.db' }], abort.signal);
  const stopped = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  abort.abort();
  await stopped;
  const worker = new DatabaseMaintenanceLock(options);
  try {
    await worker.begin('second', [target], new AbortController().signal);
    await worker.terminate();
    expect(worker.signal.aborted).toBe(true);
    await expect(worker.protect(target.dbPath, '/synthetic/product.db')).rejects.toThrow('释放');
  } finally {
    await starting.terminate();
    await worker.terminate();
  }
});
