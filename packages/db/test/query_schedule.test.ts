import { afterEach, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NtHelperBinding } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { maintainDatabases } from '../src/maintenance';
import {
  aliasDatabaseBinding,
  databasePerformance,
  scheduleDatabase,
  waitForDatabaseQuiet,
  withDatabasePriority,
  promoteDatabaseSignal,
  measureMessageWork,
  observeSlowDatabaseOperations,
} from '../src/query_schedule';
import { databaseStartupSnapshot, observeDatabaseStartup } from '../src/startup_diagnostics';

afterEach(() => vi.useRealTimers());

it('启动观察按阶段收集直接读取的行，只对有限结果值估算大小并在启动窗口后停止', async () => {
  let time = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => time);
  const path = '/synthetic/startup-diagnostics.db';
  const rows = Array.from({ length: 200 }, () => ['测试', Buffer.alloc(3), 9n]);
  const read = () => scheduleDatabase(path, async () => rows);
  try {
    observeDatabaseStartup(true);
    await measureMessageWork(path, 'watermarks', async () => {
      await Promise.all([read(), measureMessageWork(path, 'unreadSmallTables', read)]);
    });
    const snapshot = databaseStartupSnapshot();
    expect(snapshot?.watermarks).toMatchObject({
      calls: 1,
      returnedRows: 200,
      sampledRows: 128,
      sampledValueBytes: 128 * (6 + 3 + 8),
    });
    expect(snapshot?.unreadSmallTables).toMatchObject({ calls: 1, returnedRows: 200 });
    expect(snapshot?.watermarks?.peakObservedHeapUsedBytes).toBeGreaterThan(0);
    expect(databaseStartupSnapshot()).toBeUndefined();
    time = 90_001;
    await expect(measureMessageWork(path, 'watermarks', read)).resolves.toBe(rows);
    expect(databaseStartupSnapshot()).toBeUndefined();
  } finally {
    observeDatabaseStartup(false);
    clock.mockRestore();
  }
});
it('维护中前台写入立即拒绝，后台写入在队列外暂停，读取仍可完成且暂停可取消', async () => {
  const path = '/synthetic/maintenance-write.db';
  const write = vi.fn(async () => 1);
  const nt = {
    executeSql: vi.fn(async () => [[1]]),
    executeSqlWrite: write,
    closeDb: vi.fn(),
  } as unknown as NtHelperBinding;
  const db = new QqDb(nt, { dbPath: path });
  const release = maintainDatabases([path]);
  try {
    await expect(db.write('INSERT INTO t VALUES(1)')).rejects.toThrow('维护中');
    const pending = withDatabasePriority('background', () => db.write('INSERT INTO t VALUES(2)'));
    await Promise.resolve();
    expect(await db.query('SELECT 1')).toEqual([[1]]);
    expect(write).not.toHaveBeenCalled();
    const abort = new AbortController();
    const cancelled = withDatabasePriority(
      'background',
      () => db.write('INSERT INTO t VALUES(3)'),
      abort.signal,
    );
    const stopped = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    await stopped;
    release();
    await expect(pending).resolves.toBe(1);
    expect(write).toHaveBeenCalledOnce();
  } finally {
    release();
    db.close();
  }
});
it('慢诊断独立区分排队和 native 等待，不开启 SQL 诊断，回调可清理且异常不影响队列', async () => {
  vi.stubEnv('WEQ_DATABASE_DIAGNOSTICS', '0');
  let clock = 0;
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const samples: unknown[] = [];
  const stop = observeSlowDatabaseOperations((sample) => samples.push(sample));
  const stopBroken = observeSlowDatabaseOperations(() => {
    throw new Error('observer');
  });
  try {
    let release!: () => void;
    const first = scheduleDatabase(
      '/synthetic/slow.db',
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    const second = scheduleDatabase('/synthetic/slow.db', async () => 42);
    clock = 600;
    release();
    expect(await Promise.all([first, second])).toEqual([undefined, 42]);
    expect(samples).toEqual([
      {
        priority: 'interactive',
        jsQueueWaitMs: 0,
        nativePromiseAwaitMs: 600,
        outcome: 'ok',
        affectedQueryCount: 1,
        maxBlockedMs: 600,
      },
      { priority: 'interactive', jsQueueWaitMs: 600, nativePromiseAwaitMs: 0, outcome: 'ok' },
    ]);
    stop();
    await scheduleDatabase('/synthetic/slow.db', async () => {
      clock += 700;
    });
    expect(samples).toHaveLength(2);
  } finally {
    stop();
    stopBroken();
    now.mockRestore();
    vi.unstubAllEnvs();
  }
});
it('排队请求的慢回调保留各自异步上下文，不错误关联到占用队列的请求', async () => {
  const context = new AsyncLocalStorage<string>();
  let time = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => time);
  const owners: Array<string | undefined> = [];
  const stop = observeSlowDatabaseOperations(() => owners.push(context.getStore()));
  try {
    let release!: () => void;
    const first = context.run('first', () =>
      scheduleDatabase(
        '/synthetic/context.db',
        () =>
          new Promise<void>((done) => {
            release = done;
          }),
      ),
    );
    const second = context.run('second', () =>
      scheduleDatabase('/synthetic/context.db', async () => 1),
    );
    time = 600;
    release();
    await Promise.all([first, second]);
    expect(owners).toEqual(['first', 'second']);
  } finally {
    stop();
    clock.mockRestore();
  }
});
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((done) => setTimeout(done, 1));
  expect(condition()).toBe(true);
};

it('首屏阶段计时保留结果与错误，失败和取消同样记录，不泄露消息或会话', async () => {
  const path = '/synthetic/page-measurement.db';
  const row = { text: '不进入采样的正文' };
  expect(await measureMessageWork(path, 'messagePage', async () => row)).toBe(row);
  const error = new DOMException('读取已取消', 'AbortError');
  await expect(
    measureMessageWork(path, 'messagePage', async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  await measureMessageWork(path, 'roamingCache', async () => []);
  const snapshot = databasePerformance(path);
  expect(snapshot.phases.messagePage?.count).toBe(2);
  expect(snapshot.phases.roamingCache?.count).toBe(1);
  expect(JSON.stringify(snapshot)).not.toContain(row.text);
  expect(JSON.stringify(snapshot)).not.toContain(path);
});

it('点击提升同一预取的排队与后续 SQL，提升后仍可正确取消', async () => {
  const path = '/synthetic/promoted.db';
  const order: string[] = [];
  let release!: () => void;
  const blocker = scheduleDatabase(
    path,
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  const background = withDatabasePriority('background', () =>
    scheduleDatabase(path, async () => {
      order.push('background');
    }),
  );
  const controller = new AbortController();
  const page = withDatabasePriority(
    'background',
    async () => {
      await scheduleDatabase(path, async () => {
        order.push('page');
      });
      await scheduleDatabase(path, async () => {
        order.push('state');
      });
    },
    controller.signal,
  );
  promoteDatabaseSignal(controller.signal);
  release();
  await Promise.all([blocker, background, page]);
  expect(order).toEqual(['page', 'state', 'background']);
  let finish!: () => void;
  const running = scheduleDatabase(
    path,
    () =>
      new Promise<void>((done) => {
        finish = done;
      }),
  );
  const cancel = new AbortController();
  const read = vi.fn(async () => 1);
  const pending = withDatabasePriority(
    'background',
    () => scheduleDatabase(path, read),
    cancel.signal,
  );
  const failed = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  promoteDatabaseSignal(cancel.signal);
  cancel.abort();
  finish();
  await Promise.all([running, failed]);
  expect(read).not.toHaveBeenCalled();
});

it('同一绑定的多层代理共享调度，独立绑定可模拟 QQ 并发，不与它互相等待', async () => {
  const underlying = {},
    firstWrapper = aliasDatabaseBinding({}, underlying),
    secondWrapper = aliasDatabaseBinding({}, firstWrapper);
  let release!: () => void;
  const order: string[] = [];
  const first = scheduleDatabase(
    '/synthetic/bindings.db',
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
    underlying,
  );
  const same = scheduleDatabase(
    '/synthetic/bindings.db',
    async () => {
      order.push('same-native');
    },
    secondWrapper,
  );
  await scheduleDatabase(
    '/synthetic/bindings.db',
    async () => {
      order.push('independent-native');
    },
    {},
  );
  expect(order).toEqual(['independent-native']);
  release();
  await Promise.all([first, same]);
  expect(order).toEqual(['independent-native', 'same-native']);
});

it('同库不抢占已执行 SQL，交互优先于排队后台，其他库不受阻塞', async () => {
  const order: string[] = [];
  let finish!: () => void;
  const first = withDatabasePriority('background', () =>
    scheduleDatabase('/synthetic/priority.db', async () => {
      order.push('running');
      await new Promise<void>((done) => {
        finish = done;
      });
    }),
  );
  const background = withDatabasePriority('background', () =>
    scheduleDatabase('/synthetic/priority.db', async () => {
      order.push('background');
    }),
  );
  const foreground = scheduleDatabase('/synthetic/priority.db', async () => {
    order.push('interactive');
  });
  await scheduleDatabase('/synthetic/independent.db', async () => {
    order.push('independent');
  });
  expect(order).toEqual(['running', 'independent']);
  finish();
  await Promise.all([first, background, foreground]);
  expect(order).toEqual(['running', 'independent', 'interactive', 'background']);
  const snapshot = databasePerformance('/synthetic/priority.db');
  expect(snapshot.nativeQueueMs).toBeNull();
  expect(snapshot.jsQueueWait.count).toBe(3);
  expect(JSON.stringify(snapshot)).not.toContain('synthetic');
});

it('持续交互最多八条后让出后台，失败不阻断后续工作，取消只移除未执行任务', async () => {
  let release!: () => void;
  const order: string[] = [];
  const first = scheduleDatabase(
    '/synthetic/fair.db',
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  const jobs = Array.from({ length: 12 }, (_, index) =>
    scheduleDatabase('/synthetic/fair.db', async () => {
      order.push(String(index));
    }),
  );
  const background = withDatabasePriority('background', () =>
    scheduleDatabase('/synthetic/fair.db', async () => {
      order.push('background');
    }),
  );
  const controller = new AbortController();
  const cancelled = withDatabasePriority(
    'background',
    () =>
      scheduleDatabase('/synthetic/fair.db', async () => {
        throw new Error('不应执行');
      }),
    controller.signal,
  );
  const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  release();
  await Promise.all([first, ...jobs, background, rejected]);
  expect(order.indexOf('background')).toBeLessThanOrEqual(8);
  await expect(
    scheduleDatabase('/synthetic/fair.db', async () => {
      throw new Error('SQL失败');
    }),
  ).rejects.toThrow('SQL失败');
  expect(await scheduleDatabase('/synthetic/fair.db', async () => 42)).toBe(42);
});

it('异步上下文保留后台优先级，空闲等待随账号取消，不依据固定定时器误判空闲', async () => {
  let finish!: () => void;
  const active = scheduleDatabase(
    '/synthetic/quiet.db',
    () =>
      new Promise<void>((done) => {
        finish = done;
      }),
  );
  let current = true,
    quiet = false;
  const onWait = vi.fn();
  const pending = waitForDatabaseQuiet('/synthetic/quiet.db', () => current, 0, onWait).then(
    (value) => {
      quiet = value;
      return value;
    },
  );
  await new Promise((done) => setTimeout(done, 110));
  expect(quiet).toBe(false);
  expect(onWait).toHaveBeenCalledTimes(1);
  current = false;
  expect(await pending).toBe(false);
  finish();
  await active;
  await until(() => databasePerformance('/synthetic/quiet.db').inFlight === 0);
  const immediate = vi.fn();
  expect(await waitForDatabaseQuiet('/synthetic/quiet.db', () => true, 0, immediate)).toBe(true);
  expect(immediate).not.toHaveBeenCalled();
});
