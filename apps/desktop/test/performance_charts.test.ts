import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { MonitorPoint } from '@weq/service/performance';
import { Chart, valueLabel } from '../src/renderer/src/components/performance/PerformanceCharts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

function chart(values: Array<number | null>, width = 300) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const points: MonitorPoint[] = values.map((value, i) => {
    const metric = { min: value, max: value, mean: value };
    return {
      id: i + 1,
      process: 'group:全部进程',
      label: '全部进程',
      segment: 's',
      start: i * 30_000,
      end: (i + 1) * 30_000,
      firstAt: i * 30_000,
      lastAt: i * 30_000,
      count: 1,
      intervalMs: 30_000,
      metrics: {
        cpuPercent: metric,
        residentBytes: metric,
        heapBytes: metric,
        externalBytes: metric,
        eventLoopP95Ms: metric,
      },
    };
  });
  const host = document.createElement('div'),
    root = createRoot(host),
    select = vi.fn();
  document.body.append(host);
  act(() =>
    root.render(
      h(Chart, {
        metric: 'cpuPercent',
        points,
        from: 0,
        to: 180_000,
        width,
        height: 100,
        selected: null,
        hover: null,
        onHover: vi.fn(),
        select,
        move: vi.fn(),
        zoom: vi.fn(),
      }),
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, select };
}

it('默认显示最新汇总值和区间峰值，低占用刻度仍有精度且曲线不跨缺测连接', () => {
  const { host } = chart([0.1, null, 0.3]);
  expect(host.querySelector('header strong')?.textContent).toBe('0.3%');
  expect(host.querySelector('header')?.textContent).toContain('峰值 0.3%');
  const path = host.querySelector('path.weq-perf-line')!.getAttribute('d')!;
  expect(path.match(/M/g)).toHaveLength(2);
  expect(path).not.toContain('NaN');
  expect(host.querySelector('svg')?.textContent).toContain('%');
  expect(host.querySelectorAll('.weq-perf-series')).toHaveLength(1);
});

it('全缺测时不伪造零值，单点保留可见标记且可用键盘打开真实采样', () => {
  const empty = chart([null]);
  expect(empty.host.querySelector('header strong')?.textContent).toBe('不可用');
  expect(empty.host.textContent).toContain('此范围没有可用指标');
  const single = chart([0.2]);
  expect(single.host.querySelector('.weq-perf-series circle')).not.toBeNull();
  act(() =>
    single.host
      .querySelector('svg')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
  );
  expect(single.select).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
});

it('内存数值按量级显示明确单位，保留零值和缺测的区别', () => {
  expect(valueLabel(512, 'heapBytes')).toBe('512 B');
  expect(valueLabel(1536, 'heapBytes')).toBe('1.5 KiB');
  expect(valueLabel(1048576, 'heapBytes')).toBe('1.0 MiB');
  expect(valueLabel(1073741824, 'heapBytes')).toBe('1.0 GiB');
  expect(valueLabel(0, 'cpuPercent')).toBe('0.0%');
  expect(valueLabel(null, 'cpuPercent')).toBe('不可用');
});
