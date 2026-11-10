import { expect, it } from 'vitest';
import { timelineViewportRange } from '../src/renderer/src/lib/timelinePreload';

it('快速滚动按像素预留前方两屏、后方一屏，短行也不只预留固定六行', () => {
  const range = { startIndex: 100, endIndex: 105, count: 300, overscan: 6 };
  const forward = timelineViewportRange(range, 600, () => 30, 'forward');
  expect(forward[0]).toBe(80);
  expect(forward.at(-1)).toBe(145);
  const backward = timelineViewportRange(range, 600, () => 30, 'backward');
  expect(backward[0]).toBe(60);
  expect(backward.at(-1)).toBe(125);
});

it('超高消息保留最少预挂载行，极短行与边界范围不会无界扩张', () => {
  const range = { startIndex: 100, endIndex: 105, count: 300, overscan: 6 };
  const tall = timelineViewportRange(range, 600, () => 1000, null);
  expect(tall[0]).toBe(94);
  expect(tall.at(-1)).toBe(111);
  expect(timelineViewportRange(range, 900, () => 1, 'forward')).toHaveLength(102);
  expect(
    timelineViewportRange({ ...range, startIndex: 0, endIndex: 3, count: 4 }, 900, () => 30, null),
  ).toEqual([0, 1, 2, 3]);
});
