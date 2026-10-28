import { afterEach, expect, it, vi } from 'vitest';
import {
  aliasDatabaseBinding,
  databasePerformance,
  scheduleDatabase,
  waitForDatabaseQuiet,
  withDatabasePriority,
  promoteDatabaseSignal,
} from '../src/query_schedule';

afterEach(() => vi.useRealTimers());
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((done) => setTimeout(done, 1));
  expect(condition()).toBe(true);
};

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
  const pending = waitForDatabaseQuiet('/synthetic/quiet.db', () => current, 0).then((value) => {
    quiet = value;
    return value;
  });
  await new Promise((done) => setTimeout(done, 110));
  expect(quiet).toBe(false);
  current = false;
  expect(await pending).toBe(false);
  finish();
  await active;
  await until(() => databasePerformance('/synthetic/quiet.db').inFlight === 0);
  expect(await waitForDatabaseQuiet('/synthetic/quiet.db', () => true, 0)).toBe(true);
});
