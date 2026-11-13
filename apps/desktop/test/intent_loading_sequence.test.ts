import { expect, it } from 'vitest';
import { createLoadingIconSequence } from '../src/renderer/src/components/intentSense/loadingIconSequence';

it.each([0, 1, 15, 17])('随机序列完整覆盖 %i 枚图标，不丢失也不重复', (count) => {
  const sequence = createLoadingIconSequence(count, undefined, () => 0.3);
  expect([...sequence].sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, i) => i));
});

it('不同随机输入产生不同顺序，不改动列表规模', () => {
  expect(createLoadingIconSequence(17, undefined, () => 0.1)).not.toEqual(
    createLoadingIconSequence(17, undefined, () => 0.8),
  );
});

it('即便下一轮首枚恰好与上一轮末枚相同，也避免连续重复', () => {
  const first = createLoadingIconSequence(15, undefined, () => 0.4);
  const next = createLoadingIconSequence(15, first[0], () => 0.4);
  expect(next[0]).not.toBe(first[0]);
  expect(new Set(next).size).toBe(15);
});
