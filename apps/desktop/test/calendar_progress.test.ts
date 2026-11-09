import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { CalendarScanProgress } from '../src/renderer/src/components/CalendarScanProgress';

it('按当月和调用方指定的当前扫描日显示真实完成数量', () => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    createElement(CalendarScanProgress, {
      day: '2026-11-10',
      progress: { completedSources: 12, totalSources: 240 },
      dayProgress: { completedSources: 3, totalSources: 8 },
    }),
  );
  const month = host.querySelector('progress[aria-label="当月进度"]')!;
  expect(month.getAttribute('value')).toBe('12');
  expect(month.getAttribute('max')).toBe('240');
  const source = host.querySelector('progress[aria-label="2026-11-10 进度"]')!;
  expect(source.getAttribute('value')).toBe('3');
  expect(source.getAttribute('max')).toBe('8');
  expect(host.textContent).toContain('3 / 8');
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
      day: '2026-11-09',
      progress: { completedSources: 2, totalSources: 9 },
      dayProgress: { completedSources: 1, totalSources: 2 },
      controls: { month: { state, disabled: false }, day: { state, disabled: false } },
      onControl: vi.fn(),
    }),
  );
  const tracks = host.querySelectorAll('.weq-calendar-progress-track');
  expect(tracks).toHaveLength(2);
  expect(tracks[0]?.children[0]?.tagName).toBe('PROGRESS');
  expect(tracks[0]?.children[1]?.getAttribute('aria-label')).toBe(`${label}当月统计`);
  expect(tracks[1]?.children[1]?.getAttribute('aria-label')).toBe(`${label}2026-11-09统计`);
  expect(tracks[0]?.children[1]?.textContent).toBe('');
  expect(tracks[0]?.children[1]?.hasAttribute('disabled')).toBe(false);
  expect(tracks[1]?.children[1]?.hasAttribute('disabled')).toBe(false);
});
it('准备中与空范围不伪造完成进度', () => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    createElement(CalendarScanProgress, {
      day: '2026-11-10',
      dayProgress: { completedSources: 0, totalSources: 0 },
    }),
  );
  const bars = host.querySelectorAll('progress');
  expect(bars[0].hasAttribute('value')).toBe(false);
  expect(bars[1].getAttribute('value')).toBe('0');
  expect(host.textContent).toContain('准备中');
  expect(host.textContent).toContain('未开始');
});
