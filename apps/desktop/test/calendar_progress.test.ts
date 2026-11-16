import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { CalendarScanProgress } from '../src/renderer/src/components/CalendarScanProgress';

const days = [
  { day: '2020-11-01', complete: true, errors: [] },
  { day: '2020-11-02', complete: false, errors: [] },
  { day: '2020-11-03', complete: true, errors: ['读取失败'] },
  { day: '2099-11-01', complete: true, errors: [], unavailable: true },
];
it('只显示一个按已完成天数计算的进度条，不计未来和失败日期', () => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    createElement(CalendarScanProgress, {
      days,
    }),
  );
  const month = host.querySelector('progress[aria-label="当月进度"]')!;
  expect(host.querySelectorAll('progress')).toHaveLength(1);
  expect(Number(month.getAttribute('value'))).toBeCloseTo(100 / 3);
  expect(month.getAttribute('aria-valuetext')).toBe('已完成 1 / 3 天统计');
  expect(host.textContent).toContain('1 / 3 天');
});
it.each([
  ['running', '暂停'],
  ['paused', '继续'],
  ['complete', '重试'],
  ['failed', '重试'],
] as const)('进度条右侧按 %s 状态显示 %s 图标按钮', (state, label) => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    createElement(CalendarScanProgress, {
      days,
      controls: { month: { state, disabled: false }, day: { state, disabled: false } },
      onControl: vi.fn(),
    }),
  );
  const tracks = host.querySelectorAll('.weq-calendar-progress-track');
  expect(tracks).toHaveLength(1);
  expect(tracks[0]?.querySelector('progress')).not.toBeNull();
  expect(tracks[0]?.children[1]?.getAttribute('aria-label')).toBe(`${label}当月统计`);
  expect(tracks[0]?.children[1]?.textContent).toBe('');
  expect(tracks[0]?.children[1]?.hasAttribute('disabled')).toBe(false);
});
it.each([undefined, []])('准备中与空日期范围不伪造完成进度：%s', (days) => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    createElement(CalendarScanProgress, {
      days,
    }),
  );
  const bars = host.querySelectorAll('progress');
  expect(bars).toHaveLength(1);
  expect(bars[0].getAttribute('value')).toBe(days ? '0' : null);
  expect(host.textContent).toContain(days ? '未开始' : '准备中');
});
