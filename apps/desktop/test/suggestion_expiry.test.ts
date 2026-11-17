import { expect, it } from 'vitest';
import { formatSuggestionAge } from '../src/renderer/src/lib/suggestionExpiry';

it.each([
  [0, '0 秒'],
  [-1000, '0 秒'],
  [999, '0 秒'],
  [59_999, '59 秒'],
  [60_000, '1 分钟'],
  [119_999, '1 分钟'],
  [3_661_000, '1 小时 1 分钟'],
  [90_061_000, '1 天 1 小时'],
  [172_860_000, '2 天 1 分钟'],
  [31_622_461_000, '1 年 1 天'],
  [63_072_000_000, '2 年'],
])('推荐间隔 %s ms 最多两级单位：%s', (elapsed, expected) => {
  expect(formatSuggestionAge(elapsed)).toBe(expected);
});
