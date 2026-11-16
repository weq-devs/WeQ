import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  nextStartupQueryStage,
  scheduleStartupQueryBatch,
} from '../src/renderer/src/lib/startupQueries';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('首屏完成后逐批放行，上一批未完成不前进，最后一批不重复启动', () => {
  expect(nextStartupQueryStage(0, false, true)).toBeNull();
  expect(nextStartupQueryStage(0, true, false)).toBe(1);
  for (const stage of [1, 2, 3, 4] as const) {
    expect(nextStartupQueryStage(stage, true, false)).toBeNull();
    expect(nextStartupQueryStage(stage, true, true)).toBe(stage + 1);
  }
  expect(nextStartupQueryStage(5, true, true)).toBeNull();
});

it('查询失败也算本批完成，不把可行的后续批次永久阻塞', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const observer = new QueryObserver(client, {
    queryKey: ['startup-failure'],
    queryFn: async () => {
      throw new Error('synthetic unavailable');
    },
  });
  const stop = observer.subscribe(() => {});
  try {
    const result = await observer.refetch();
    expect(result.isError).toBe(true);
    expect(nextStartupQueryStage(1, true, result.isFetched && !result.isFetching)).toBe(2);
  } finally {
    stop();
    client.clear();
  }
});

function fixture() {
  let next = 0;
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  const frames = new Map<number, () => void>(),
    timers = new Map<number, () => void>(),
    idle = new Map<number, () => void>();
  const enqueue = (map: Map<number, () => void>, fn: () => void) => {
    const id = ++next;
    map.set(id, fn);
    return id;
  };
  const flush = (map: Map<number, () => void>) => {
    const current = [...map.values()];
    map.clear();
    for (const fn of current) fn();
  };
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    requestAnimationFrame: (fn: () => void) => enqueue(frames, fn),
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: (fn: () => void, delay = 0) => {
      const after = now + delay;
      return enqueue(timers, () => {
        now = Math.max(now, after);
        fn();
      });
    },
    clearTimeout: (id: number) => timers.delete(id),
    requestIdleCallback: (fn: () => void) => enqueue(idle, fn),
    cancelIdleCallback: (id: number) => idle.delete(id),
  });
  return {
    paint: () => {
      flush(frames);
      flush(frames);
    },
    runIdle: async () => {
      flush(timers);
      flush(idle);
      for (let turn = 0; turn < 6; turn++) await Promise.resolve();
    },
    flush: () => {
      flush(frames);
      flush(timers);
      flush(idle);
    },
  };
}

it('首屏先绘制、前台查询忙时不放行，空闲后再绘制并启动一次', async () => {
  const f = fixture(),
    run = vi.fn();
  let busy = true;
  scheduleStartupQueryBatch(run, () => !busy);
  expect(run).not.toHaveBeenCalled();
  f.paint();
  await f.runIdle();
  expect(run).not.toHaveBeenCalled();
  busy = false;
  await f.runIdle();
  f.paint();
  await f.runIdle();
  expect(run).toHaveBeenCalledOnce();
  f.flush();
  expect(run).toHaveBeenCalledOnce();
});

it('顶层页面支持绘制计时时，不在动画帧回调早于真实首屏绘制时提前放行', async () => {
  const f = fixture(),
    run = vi.fn();
  let painted = false;
  Object.assign(window, {
    top: window,
    PerformanceObserver: { supportedEntryTypes: ['paint'] },
    performance: { getEntriesByName: () => (painted ? [{ startTime: 1 }] : []) },
  });
  scheduleStartupQueryBatch(run, () => true);
  f.paint();
  await f.runIdle();
  expect(run).not.toHaveBeenCalled();
  painted = true;
  await f.runIdle();
  f.paint();
  await f.runIdle();
  expect(run).toHaveBeenCalledOnce();
});

it('卸载或账号切换取消尚未启动的批次，隐藏页面不后台抢读', async () => {
  const f = fixture(),
    run = vi.fn();
  const cancel = scheduleStartupQueryBatch(run, () => true);
  f.paint();
  cancel();
  await f.runIdle();
  expect(run).not.toHaveBeenCalled();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const stop = scheduleStartupQueryBatch(run, () => true);
  f.paint();
  await f.runIdle();
  expect(run).not.toHaveBeenCalled();
  stop();
  f.flush();
  expect(run).not.toHaveBeenCalled();
});
