import { expect, it } from 'vitest';
import {
  quickReactionCapacity,
  REACTION_BUTTON_MIN_WIDTH,
} from '../src/renderer/src/lib/reactionItems';

it.each([
  [290, 5],
  [264, 5],
  [263, 4],
  [220, 4],
  [176, 3],
  [88, 1],
  [44, 0],
  [0, 0],
])('可用宽度 %s 预留更多入口后容纳 %s 个快捷表情', (width, expected) => {
  expect(quickReactionCapacity(width)).toBe(expected);
  if (width >= REACTION_BUTTON_MIN_WIDTH)
    expect((quickReactionCapacity(width) + 1) * REACTION_BUTTON_MIN_WIDTH).toBeLessThanOrEqual(
      width,
    );
});

it('无效尺寸不会产生负数或无限容量', () => {
  for (const width of [-1, Number.NaN, Number.POSITIVE_INFINITY])
    expect(quickReactionCapacity(width)).toBe(0);
});
