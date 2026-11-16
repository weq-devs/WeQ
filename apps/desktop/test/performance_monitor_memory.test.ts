import { act, createElement as h, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { observable } from '@trpc/server/observable';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MONITOR_METRICS, type MonitorHistory, type MonitorPoint } from '@weq/service/performance';
import { trpc } from '../src/renderer/src/trpc/client';
import { createQueryClient } from '../src/renderer/src/trpc/queryClient';
import PerformanceMonitorView from '../src/renderer/src/components/performance/PerformanceMonitorView';
import type { Chart } from '../src/renderer/src/components/performance/PerformanceCharts';

vi.mock('../src/renderer/src/components/performance/PerformanceCharts', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('../src/renderer/src/components/performance/PerformanceCharts')
    >();
  return {
    ...original,
    Chart: ({ metric, points, select }: ComponentProps<typeof Chart>) =>
      h(
        'div',
        { 'data-metric': metric },
        ...points.map((point) =>
          h('button', { key: point.id, 'data-point': point.id, onClick: () => select(point) }),
        ),
      ),
  };
});

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-16T05:00:00Z'));
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function settle(ms = 1) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function fixture() {
  const queries = createQueryClient(false);
  const historyReads: Array<{
    from: number;
    to: number;
    processGroup?: string;
    aggregate?: boolean;
  }> = [];
  const detailReads: number[] = [];
  let holdHistory = false;
  let releaseHistory: (() => void) | undefined;
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            const finish = (data: unknown) => {
              observer.next({ result: { data } });
              observer.complete();
            };
            if (op.path === 'performanceMonitor.status') {
              finish({ host: 'desktop', settings: { mode: 'light' } });
            } else if (op.path === 'performanceMonitor.history') {
              const input = op.input as (typeof historyReads)[number];
              historyReads.push(input);
              const metric = { min: 1, max: 1, mean: 1 };
              const history: MonitorHistory = {
                processGroups: ['合成进程'],
                points: [1, 2, 3].map(
                  (id): MonitorPoint => ({
                    id,
                    process: 'synthetic',
                    label: '合成进程',
                    segment: 'synthetic',
                    start: input.from,
                    end: input.to,
                    firstAt: input.from,
                    lastAt: input.to,
                    count: 1,
                    intervalMs: 30_000,
                    metrics: {
                      cpuPercent: metric,
                      residentBytes: metric,
                      heapBytes: metric,
                      externalBytes: metric,
                      eventLoopP95Ms: metric,
                    },
                  }),
                ),
                events: [],
                eventLimitReached: false,
                pointLimitReached: false,
              };
              if (holdHistory) {
                holdHistory = false;
                releaseHistory = () => finish(history);
              } else finish(history);
            } else if (op.path === 'performanceMonitor.detail') {
              detailReads.push((op.input as { id: number }).id);
              finish({ at: Date.now(), processes: [] });
            } else throw new Error(`未预期的请求：${op.path}`);
          }),
    ],
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const mount = (visible: boolean) =>
    act(() =>
      root.render(
        h(
          trpc.Provider,
          { client, queryClient: queries },
          h(QueryClientProvider, { client: queries }, visible ? h(PerformanceMonitorView) : null),
        ),
      ),
    );
  mount(true);
  cleanups.push(() => {
    act(() => root.unmount());
    queries.clear();
    host.remove();
  });
  const cachedHistory = () =>
    queries.getQueryCache().findAll(getQueryKey(trpc.performanceMonitor.history));
  const cachedDetails = () =>
    queries
      .getQueryCache()
      .findAll(getQueryKey(trpc.performanceMonitor.detail))
      .filter((query) => query.state.data !== undefined);
  return {
    host,
    queries,
    mount,
    cachedHistory,
    cachedDetails,
    historyReads,
    detailReads,
    holdNextHistory() {
      holdHistory = true;
    },
    releaseHistory() {
      releaseHistory?.();
    },
  };
}

it('默认显示全部五项指标，包含 JS 外部内存', async () => {
  const f = fixture();
  await settle();
  expect(
    [...f.host.querySelectorAll<HTMLElement>('[data-metric]')].map((chart) => chart.dataset.metric),
  ).toEqual([...MONITOR_METRICS]);
  expect(f.host.querySelector('[data-metric="externalBytes"]')).not.toBeNull();
});

it('连续实时刷新只保留当前历史结果，不影响其它业务缓存，关闭后释放性能结果', async () => {
  const f = fixture();
  await settle();
  const initialReads = f.historyReads.length;
  for (let round = 0; round < 180; round++) {
    if (round === 90) f.queries.setQueryData(['unrelated-business'], { retained: true });
    await settle(10_000);
    // React 提交后才移除旧观察者，零缓存清理在下一轮任务执行。
    await settle();
    expect(f.cachedHistory()).toHaveLength(1);
  }
  expect(f.historyReads.length).toBeGreaterThanOrEqual(initialReads + 180);
  expect(f.cachedHistory()[0]?.state.data).toMatchObject({
    points: [{ end: f.historyReads.at(-1)!.to }, {}, {}],
  });
  expect(f.queries.getQueryData(['unrelated-business'])).toEqual({ retained: true });
  f.mount(false);
  await settle();
  expect(f.cachedHistory()).toHaveLength(0);
  expect(f.queries.getQueryData(['unrelated-business'])).toEqual({ retained: true });
}, 15_000);

it('实时刷新等待响应时不卸载图表，也不插入读取占位', async () => {
  const f = fixture();
  await settle();
  const point = f.host.querySelector('[data-point="1"]');
  expect(point).not.toBeNull();
  f.holdNextHistory();
  await settle(10_000);
  expect(f.host.querySelector('[data-point="1"]')).toBe(point);
  expect(f.host.textContent).not.toContain('正在读取历史');
  await act(async () => f.releaseHistory());
  await settle();
  expect(f.cachedHistory()).toHaveLength(1);
});

it('筛选和明细切换不积压结果，关闭后迟到的历史响应也会释放', async () => {
  const f = fixture();
  await settle();
  const process = f.host.querySelector<HTMLSelectElement>('[aria-label="进程"]')!;
  await act(async () => {
    process.value = '合成进程';
    process.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
  expect(f.historyReads.at(-1)).toMatchObject({ processGroup: '合成进程', aggregate: true });
  expect(f.cachedHistory()).toHaveLength(1);
  for (const id of [1, 2, 3]) {
    await act(async () => f.host.querySelector<HTMLButtonElement>(`[data-point="${id}"]`)!.click());
    await settle();
    expect(f.cachedDetails()).toHaveLength(1);
    expect(f.detailReads.at(-1)).toBe(id);
  }
  f.holdNextHistory();
  await settle(10_000);
  f.mount(false);
  await act(async () => f.releaseHistory());
  await settle();
  expect(f.cachedHistory()).toHaveLength(0);
  expect(f.cachedDetails()).toHaveLength(0);
});
