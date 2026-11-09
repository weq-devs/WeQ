import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NtHelperBinding } from '@weq/native';
import { QqDb, databasePerformance, withDatabasePriority, withDatabaseReadBudget } from '@weq/db';

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

it('持续的短前台读取不能让日历一直等在队列外', async () => {
  const { db, budgeted } = fixture();
  const pending = withDatabasePriority('background', () =>
    withDatabaseReadBudget(10, () => db.query('SELECT 1')),
  );
  try {
    for (let i = 0; i < 15; i++) {
      await db.query('SELECT 2');
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(budgeted).toHaveBeenCalledTimes(1);
    expect(budgeted.mock.calls[0]?.[3]).toBe(10);
  } finally {
    await vi.runAllTimersAsync();
    await pending;
  }
});

it.each(['interactive', 'background'] as const)(
  '%s 在途读取持续繁忙时日历仍可入队，但不并发抢占原生连接',
  async (priority) => {
    const { db, ordinary, budgeted } = fixture();
    let release!: (rows: []) => void;
    ordinary.mockImplementationOnce(
      () =>
        new Promise<[]>((resolve) => {
          release = resolve;
        }),
    );
    const active = withDatabasePriority(priority, () => db.query('SELECT 2'));
    const pending = withDatabasePriority('background', () =>
      withDatabaseReadBudget(10, () => db.query('SELECT 1')),
    );
    try {
      await vi.advanceTimersByTimeAsync(1500);
      expect(databasePerformance(db.dbPath).queued).toBe(1);
      expect(budgeted).not.toHaveBeenCalled();
    } finally {
      release([]);
      await active;
      await vi.runAllTimersAsync();
      await pending;
    }
    expect(budgeted).toHaveBeenCalledTimes(1);
  },
);

it('繁忙时入队后取消仍移除日历查询，不执行原生读取', async () => {
  const { db, ordinary, budgeted } = fixture();
  let release!: (rows: []) => void;
  ordinary.mockImplementationOnce(
    () =>
      new Promise<[]>((resolve) => {
        release = resolve;
      }),
  );
  const active = db.query('SELECT 2');
  const controller = new AbortController();
  const pending = withDatabasePriority(
    'background',
    () => withDatabaseReadBudget(10, () => db.query('SELECT 1')),
    controller.signal,
  );
  const rejected = expect(pending).rejects.toThrow('取消');
  try {
    await vi.advanceTimersByTimeAsync(1500);
    expect(databasePerformance(db.dbPath).queued).toBe(1);
  } finally {
    controller.abort();
    await vi.runAllTimersAsync();
    await rejected;
    release([]);
    await active;
  }
  expect(databasePerformance(db.dbPath).queued).toBe(0);
  expect(budgeted).not.toHaveBeenCalled();
});
