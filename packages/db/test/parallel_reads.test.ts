import { afterEach, expect, it, vi } from 'vitest';
import type { DatabaseReadRequest, DatabaseReadResult, NtHelperBinding } from '@weq/native';
import { QqDb } from '../src/qq_db';
import {
  configureDatabaseReadConcurrency,
  databasePerformance,
  withDatabasePriority,
  withDatabaseSignal,
  withDatabaseWorkload,
} from '../src/query_schedule';
import { wrapBindingForSalvage } from '../src/salvage';
import { wrapBindingForCorruption } from '../src/errors';

const timing = { nativeQueueMs: 1, connectionWaitMs: 2, connectionOpenMs: 3, executionMs: 4 };
const tick = () => new Promise<void>((done) => setImmediate(done));
afterEach(() => configureDatabaseReadConcurrency(4));
function fixture() {
  const pending: Array<{
    input: DatabaseReadRequest;
    resolve: (value: DatabaseReadResult) => void;
  }> = [];
  const executeDatabaseRead = vi.fn(
    (input: DatabaseReadRequest) =>
      new Promise<DatabaseReadResult>((resolve) => pending.push({ input, resolve })),
  );
  const nt = {
    executeDatabaseRead,
    configureDatabaseReads: vi.fn(),
    cancelDatabaseRead: vi.fn(),
    closeDb: vi.fn(),
    executeSqlWrite: vi.fn(async () => 1),
  } as unknown as NtHelperBinding;
  const db = new QqDb(nt, { dbPath: `/synthetic/parallel-${Math.random()}.db` });
  const finish = (index: number, patch: Partial<DatabaseReadResult> = {}) =>
    pending[index]!.resolve({ rows: [[1n]], timing, ...patch });
  return { nt, db, pending, finish, executeDatabaseRead };
}

it('同库读可并行，达到上限后排队；动态缩容不打断在途读取', async () => {
  const f = fixture();
  configureDatabaseReadConcurrency(2);
  const reads = Array.from({ length: 4 }, () => f.db.query('SELECT 1'));
  expect(f.pending).toHaveLength(2);
  configureDatabaseReadConcurrency(1);
  f.finish(0);
  await tick();
  expect(f.pending).toHaveLength(2);
  f.finish(1);
  await tick();
  expect(f.pending).toHaveLength(3);
  configureDatabaseReadConcurrency(4);
  expect(f.pending).toHaveLength(4);
  f.finish(2);
  f.finish(3);
  await Promise.all(reads);
  expect(databasePerformance(f.db.dbPath).nativeExecutionMs?.count).toBe(4);
});

it('重查询只并发一个，普通读可使用保留容量；优先级提升不改变工作类型', async () => {
  const f = fixture();
  configureDatabaseReadConcurrency(2);
  const bulk1 = withDatabaseWorkload('bulk', () => f.db.query('SELECT 1'));
  const bulk2 = withDatabasePriority('interactive', () =>
    withDatabaseWorkload('bulk', () => f.db.query('SELECT 2')),
  );
  const quick = f.db.query('SELECT 3');
  expect(f.pending.map((p) => p.input.sql)).toEqual(['SELECT 1', 'SELECT 3']);
  f.finish(1);
  await tick();
  expect(f.pending).toHaveLength(2);
  f.finish(0);
  await tick();
  expect(f.pending[2]?.input.bulk).toBe(true);
  f.finish(2);
  await Promise.all([bulk1, bulk2, quick]);
});

it('普通读已占用三个连接时，重查询仍可使用第四个空闲连接', async () => {
  const f = fixture();
  const reads = Array.from({ length: 3 }, () => f.db.query('SELECT 1'));
  reads.push(withDatabaseWorkload('bulk', () => f.db.query('SELECT 2')));
  expect(f.pending).toHaveLength(4);
  expect(f.pending[3]!.input.bulk).toBe(true);
  for (let index = 0; index < 4; index++) f.finish(index);
  await Promise.all(reads);
});

it('不同数据库共享宿主总并发上限，释放后其他库继续执行', async () => {
  configureDatabaseReadConcurrency(8);
  const fixtures = Array.from({ length: 5 }, fixture);
  const reads = fixtures.flatMap((f) => Array.from({ length: 8 }, () => f.db.query('SELECT 1')));
  expect(fixtures.reduce((sum, f) => sum + f.pending.length, 0)).toBe(32);
  for (const f of fixtures) for (let index = 0; index < f.pending.length; index++) f.finish(index);
  await tick();
  expect(fixtures.reduce((sum, f) => sum + f.pending.length, 0)).toBe(40);
  for (const f of fixtures) for (let index = 0; index < f.pending.length; index++) f.finish(index);
  await Promise.all(reads);
});

it('写入等待读取完成且阻止后续读穿越；旧 native 保持单路', async () => {
  const f = fixture();
  const first = f.db.query('SELECT 1');
  const write = f.db.write('UPDATE fixture SET id=2');
  const second = f.db.query('SELECT 2');
  expect(f.pending).toHaveLength(1);
  expect(f.nt.executeSqlWrite).not.toHaveBeenCalled();
  f.finish(0);
  await tick();
  await tick();
  expect(f.nt.executeSqlWrite).toHaveBeenCalledOnce();
  expect(f.pending).toHaveLength(2);
  f.finish(1);
  await Promise.all([first, write, second]);
  let releaseOld!: (rows: bigint[][]) => void;
  const old = {
    executeSql: vi.fn(
      () =>
        new Promise<bigint[][]>((resolve) => {
          releaseOld = resolve;
        }),
    ),
  } as unknown as NtHelperBinding;
  const db = new QqDb(old, { dbPath: '/synthetic/legacy-parallel.db' });
  const cancel = new AbortController();
  const reading = withDatabaseSignal(cancel.signal, () => db.query('SELECT 1'));
  const oldRejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  const queued = withDatabaseSignal(cancel.signal, () => db.query('SELECT 2'));
  expect(old.executeSql).toHaveBeenCalledOnce();
  cancel.abort();
  await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
  releaseOld([[1n]]);
  await oldRejected;
});

it('取消只针对自己的 native 请求，不取消并行读取或复用连接的下一次查询', async () => {
  const f = fixture();
  const controller = new AbortController();
  const cancelled = withDatabaseSignal(controller.signal, () => f.db.query('SELECT 1'));
  const rejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  const other = f.db.query('SELECT 2');
  controller.abort();
  expect(f.nt.cancelDatabaseRead).toHaveBeenCalledWith(f.pending[0]!.input.requestId);
  f.finish(0);
  f.finish(1);
  await rejection;
  await other;
  const next = f.db.query('SELECT 3');
  expect(f.pending[2]!.input.requestId).not.toBe(f.pending[0]!.input.requestId);
  f.finish(2);
  await next;
});

it('撤销排队写入后立即放行后续读，不等仍在执行的慢读结束', async () => {
  const f = fixture();
  const first = f.db.query('SELECT 1');
  const controller = new AbortController();
  const write = withDatabaseSignal(controller.signal, () => f.db.write('UPDATE fixture SET id=2'));
  const rejected = expect(write).rejects.toMatchObject({ name: 'AbortError' });
  const next = f.db.query('SELECT 2');
  expect(f.pending).toHaveLength(1);
  controller.abort();
  expect(f.pending).toHaveLength(2);
  expect(f.nt.executeSqlWrite).not.toHaveBeenCalled();
  f.finish(0);
  f.finish(1);
  await Promise.all([first, next, rejected]);
});

it('新读取入口保留宽容解释、损坏观察和短预算语义', async () => {
  const f = fixture();
  const report = vi.fn();
  const wrapped = wrapBindingForCorruption(wrapBindingForSalvage(f.nt, { level: () => 1 }), report);
  const db = new QqDb(wrapped, { dbPath: f.db.dbPath });
  const reading = db.query('SELECT 1');
  expect(f.pending[0]?.input.level).toBe(1);
  f.finish(0, {
    rows: undefined,
    salvage: { ok: true, rows: [[2n]], degraded: false } as DatabaseReadResult['salvage'],
  });
  expect(await reading).toEqual([[2n]]);
  const bad = db.query('SELECT 2');
  const rejected = expect(bad).rejects.toThrow('database disk image is malformed');
  f.finish(1, { error: 'database disk image is malformed' });
  await rejected;
  expect(report).toHaveBeenCalledOnce();
});
