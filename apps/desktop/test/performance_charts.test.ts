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

function chart(values: Array<number | null>, width = 300, count = 1) {
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
      count,
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
    select = vi.fn(),
    onHover = vi.fn(),
    move = vi.fn();
  document.body.append(host);
  const render = (hover: MonitorPoint | null = null) =>
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
          hover,
          onHover,
          select,
          move,
          zoom: vi.fn(),
        }),
      ),
    );
  render();
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return {
    host,
    select,
    onHover,
    move,
    inspect() {
      render(points[0] ?? null);
      act(() =>
        host.querySelector('svg')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true })),
      );
    },
  };
}

function pointerFixture(scale: number, offset: number) {
  const fixture = chart([10, 20, 30, 40, 50, 60, 70]);
  const svg = fixture.host.querySelector('svg')!;
  Object.assign(svg, {
    getBoundingClientRect: () => ({ left: 20, top: 0, width: 600, height: 100 }),
    createSVGPoint: () => ({
      x: 0,
      y: 0,
      matrixTransform(matrix: { a: number; e: number }) {
        return { x: this.x * matrix.a + matrix.e, y: this.y };
      },
    }),
    getScreenCTM: () => ({ inverse: () => ({ a: 1 / scale, e: -offset / scale }) }),
    setPointerCapture: vi.fn(),
  });
  const dispatch = (type: string, x: number) =>
    act(() =>
      svg.dispatchEvent(
        new PointerEvent(type, { bubbles: true, clientX: x * scale + offset, clientY: 40 }),
      ),
    );
  return { ...fixture, dispatch };
}

it.each([
  [1, 170],
  [0.75, 110],
])('悬停与点击按 SVG 实际变换定位采样（缩放 %s，偏移 %s）', (scale, offset) => {
  const f = pointerFixture(scale, offset);
  // 第二个点位于绘图区的 1/6，外框留白和 CSS 缩放不应改变所选采样。
  const x = 76 + (288 - 76) / 6;
  f.dispatch('pointermove', x);
  expect(f.onHover).toHaveBeenLastCalledWith(expect.objectContaining({ id: 2 }));
  f.dispatch('pointerdown', x);
  f.dispatch('pointerup', x);
  expect(f.select).toHaveBeenLastCalledWith(expect.objectContaining({ id: 2 }));
});

it('拖动距离按 SVG 绘图区时间比例换算，不包含坐标轴和外框留白', () => {
  const f = pointerFixture(0.75, 110);
  f.dispatch('pointerdown', 76 + (288 - 76) / 3);
  f.dispatch('pointerup', 76 + (288 - 76) / 2);
  expect(f.move).toHaveBeenCalledOnce();
  expect(Math.abs(f.move.mock.calls[0]![0] + 30_000)).toBeLessThanOrEqual(1);
  expect(f.select).not.toHaveBeenCalled();
});

it('单次采样不显示范围，多次采样即使最小值和最大值相同也保留范围', () => {
  for (const count of [1, 2]) {
    const f = chart([0.2], 300, count);
    f.inspect();
    const tooltip = f.host.querySelector('.weq-perf-chart-tooltip');
    expect(tooltip).not.toBeNull();
    expect(tooltip!.textContent).toContain('全部进程');
    expect(tooltip!.textContent).toContain('0.2%');
    expect(tooltip!.textContent!.includes('范围')).toBe(count > 1);
  }
});

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
