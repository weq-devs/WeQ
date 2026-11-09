import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NtHelperBinding } from '@weq/native';
import { QqDb, withDatabasePriority, withDatabaseReadBudget } from '@weq/db';

let counter = 0;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
});
afterEach(() => {
  vi.useRealTimers();
});
function fixture() {
  const ordinary = vi.fn<NtHelperBinding['executeSql']>(async () => [[2n]]);
  const budgeted = vi.fn<NonNullable<NtHelperBinding['executeSqlBudgeted']>>(async () => [[1n]]);
  const native = {
    executeSql: ordinary,
    executeSqlBudgeted: budgeted,
  } as unknown as NtHelperBinding;
  return {
    ordinary,
    budgeted,
    native,
    db: new QqDb(native, { dbPath: join(tmpdir(), `synthetic-calendar-budget-${counter++}.db`) }),
  };
}
it('日历短预算不改变普通查询，前台活动后等待空闲再提交', async () => {
  const { db, ordinary, budgeted } = fixture();
  const observed: number[] = [];
  const pending = withDatabasePriority('background', () =>
    withDatabaseReadBudget(
      10,
      () => db.query('SELECT 1'),
      (ms) => observed.push(ms),
    ),
  );
  await vi.advanceTimersByTimeAsync(400);
  expect(budgeted).not.toHaveBeenCalled();
  expect(await db.query('SELECT 2')).toEqual([[2n]]);
  await vi.advanceTimersByTimeAsync(400);
  expect(budgeted).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  expect(await pending).toEqual([[1n]]);
  expect(budgeted.mock.calls[0]?.[3]).toBe(10);
  expect(ordinary).toHaveBeenCalledTimes(1);
  expect(observed).toHaveLength(1);
});
it('旧组件不能回退普通长查询', async () => {
  const { db, native, ordinary } = fixture();
  delete native.executeSqlBudgeted;
  await expect(withDatabaseReadBudget(10, () => db.query('SELECT 1'))).rejects.toThrow('短预算');
  expect(ordinary).not.toHaveBeenCalled();
});
it('等待空闲期间取消，不再调用原生 SQL', async () => {
  const { db, budgeted } = fixture();
  const controller = new AbortController();
  const promise = withDatabasePriority(
    'background',
    () => withDatabaseReadBudget(10, () => db.query('SELECT 1')),
    controller.signal,
  );
  const rejected = expect(promise).rejects.toThrow('取消');
  controller.abort();
  await vi.runAllTimersAsync();
  await rejected;
  expect(budgeted).not.toHaveBeenCalled();
});
