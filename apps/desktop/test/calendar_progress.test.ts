import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
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
it('准备中不伪造进度，空范围显示完成', () => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    createElement(CalendarScanProgress, {
      day: '2026-11-10',
      dayProgress: { completedSources: 0, totalSources: 0 },
    }),
  );
  const bars = host.querySelectorAll('progress');
  expect(bars[0].hasAttribute('value')).toBe(false);
  expect(bars[1].getAttribute('value')).toBe('1');
  expect(host.textContent).toContain('准备中');
});
