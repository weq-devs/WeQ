import { afterEach, expect, it, vi } from 'vitest';
import {
  observeSlowDatabaseOperations,
  scheduleDatabase,
  withDatabasePriority,
  type SlowDatabaseOperation,
} from '../src/query_schedule';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture() {
  vi.stubEnv('WEQ_DATABASE_DIAGNOSTICS', '0');
  let time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  const samples: SlowDatabaseOperation[] = [];
  const stop = observeSlowDatabaseOperations((sample) => samples.push(sample));
  return { samples, stop, at: (value: number) => (time = value) };
}

it('快操作不展开来源或生成影响采样，保持按需诊断', async () => {
  const f = fixture();
  const caller = vi.fn(() => 'FixtureReader.fast');
  const fingerprint = vi.fn(() => 'aaaaaaaaaaaaaaaa');
  try {
    await scheduleDatabase('/synthetic/fast-impact.db', async () => 1, undefined, {
      get caller() {
        return caller();
      },
      get fingerprint() {
        return fingerprint();
      },
    });
    expect(f.samples).toEqual([]);
    expect(caller).not.toHaveBeenCalled();
    expect(fingerprint).not.toHaveBeenCalled();
  } finally {
    f.stop();
  }
});

it('慢操作汇总实际阻塞的查询，不归入其他数据库或独立绑定的查询', async () => {
  const f = fixture();
  const path = '/synthetic/slow-impact.db';
  const binding = {};
  let release!: () => void;
  try {
    const first = scheduleDatabase(
      path,
      () => new Promise<void>((done) => (release = done)),
      binding,
      { caller: 'FixtureReader.slow', fingerprint: 'aaaaaaaaaaaaaaaa' },
    );
    f.at(100);
    const early = scheduleDatabase(path, async () => 1, binding);
    f.at(400);
    const late = withDatabasePriority('background', () =>
      scheduleDatabase(path, async () => 2, binding),
    );
    await scheduleDatabase(path, async () => 3, {});
    await scheduleDatabase('/synthetic/other-impact.db', async () => 4, binding);
    f.at(1000);
    release();
    await Promise.all([first, early, late]);
    expect(f.samples[0]).toMatchObject({
      caller: 'FixtureReader.slow',
      fingerprint: 'aaaaaaaaaaaaaaaa',
      nativePromiseAwaitMs: 1000,
      affectedQueryCount: 2,
      maxBlockedMs: 900,
    });
    expect(f.samples.slice(1).every((sample) => sample.nativePromiseAwaitMs === 0)).toBe(true);
    expect(f.samples.slice(1).every((sample) => !('affectedQueryCount' in sample))).toBe(true);
  } finally {
    f.stop();
  }
});

it('连续慢操作分别归因，最长阻塞不包含前一个操作造成的排队', async () => {
  const f = fixture();
  const path = '/synthetic/consecutive-slow-impact.db';
  let release!: () => void;
  try {
    const first = scheduleDatabase(path, () => new Promise<void>((done) => (release = done)));
    const second = scheduleDatabase(path, async () => {
      f.at(1400);
    });
    const third = scheduleDatabase(path, async () => 3);
    f.at(600);
    release();
    await Promise.all([first, second, third]);
    expect(f.samples).toEqual([
      expect.objectContaining({
        nativePromiseAwaitMs: 600,
        affectedQueryCount: 2,
        maxBlockedMs: 600,
      }),
      expect.objectContaining({
        jsQueueWaitMs: 600,
        nativePromiseAwaitMs: 800,
        affectedQueryCount: 1,
        maxBlockedMs: 800,
      }),
      expect.objectContaining({ jsQueueWaitMs: 1400, nativePromiseAwaitMs: 0 }),
    ]);
  } finally {
    f.stop();
  }
});

it('计入排队中取消的实际阻塞，但不把取消后的时间算入其等待', async () => {
  const f = fixture();
  const path = '/synthetic/cancelled-slow-impact.db';
  const controller = new AbortController();
  let release!: () => void;
  try {
    const first = scheduleDatabase(path, () => new Promise<void>((done) => (release = done)));
    f.at(200);
    const cancelled = withDatabasePriority(
      'background',
      () => scheduleDatabase(path, async () => 1),
      controller.signal,
    );
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    f.at(800);
    controller.abort();
    f.at(2000);
    release();
    await Promise.all([first, rejected]);
    expect(f.samples).toEqual([
      expect.objectContaining({ affectedQueryCount: 1, maxBlockedMs: 600 }),
    ]);
  } finally {
    f.stop();
  }
});

it('操作自身的排队和慢操作结束后才进入的查询不算入该操作的影响', async () => {
  const f = fixture();
  const path = '/synthetic/late-slow-impact.db';
  let release!: () => void;
  try {
    const first = scheduleDatabase(path, () => new Promise<void>((done) => (release = done)));
    const second = scheduleDatabase(path, async () => {
      f.at(1000);
    });
    f.at(400);
    release();
    await Promise.all([first, second]);
    await scheduleDatabase(path, async () => 3);
    expect(f.samples).toHaveLength(1);
    expect(f.samples[0]).toMatchObject({ jsQueueWaitMs: 400, nativePromiseAwaitMs: 600 });
    expect(f.samples[0]).not.toHaveProperty('affectedQueryCount');
    expect(f.samples[0]).not.toHaveProperty('maxBlockedMs');
  } finally {
    f.stop();
  }
});

it.each(['failed', 'cancelled'] as const)(
  '慢操作 %s 后仍汇总影响并继续排空队列',
  async (outcome) => {
    const f = fixture();
    const path = `/synthetic/${outcome}-slow-impact.db`;
    let reject!: (error: Error) => void;
    try {
      const first = scheduleDatabase(path, () => new Promise<void>((_, fail) => (reject = fail)));
      const error =
        outcome === 'cancelled' ? new DOMException('取消', 'AbortError') : new Error('失败');
      const rejected = expect(first).rejects.toBe(error);
      const second = scheduleDatabase(path, async () => 42);
      f.at(600);
      reject(error);
      await rejected;
      expect(await second).toBe(42);
      expect(f.samples[0]).toMatchObject({ outcome, affectedQueryCount: 1, maxBlockedMs: 600 });
    } finally {
      f.stop();
    }
  },
);
