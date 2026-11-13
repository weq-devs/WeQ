import { expect, it } from 'vitest';
import { formatSuggestionAge } from '../src/renderer/src/lib/suggestionExpiry';

it.each([
  [0, '0秒'],
  [-1000, '0秒'],
  [999, '0秒'],
  [59_999, '59秒'],
  [60_000, '1分钟'],
  [119_999, '1分钟'],
  [3_661_000, '1小时1分钟'],
  [90_061_000, '1天1小时'],
  [172_860_000, '2天1分钟'],
  [31_622_461_000, '1年1天'],
  [63_072_000_000, '2年'],
])('推荐间隔 %s ms 最多两级单位：%s', (elapsed, expected) => {
  expect(formatSuggestionAge(elapsed)).toBe(expected);
});
