import { describe, expect, it } from 'vitest';
import { createPinyinMatcher } from '../src/pinyin_search';

describe('名称拼音匹配', () => {
  it.each([
    '厦门dx',
    'xm大学',
    '厦门 daxue',
    'x门大学',
    'xmdaxue',
    'xiamendx',
    '厦m大xue',
    '厦门dax',
  ])('按逐字规则匹配 %s 并高亮原文', (query) => {
    const matcher = createPinyinMatcher(query)!;
    expect(matcher.test('厦门大学')).toBe(true);
    expect(matcher.rank('厦门大学')).toBe(1.5);
    expect(matcher.findRanges('🌊 厦门大学、厦门大学')).toEqual([
      [3, 7],
      [8, 12],
    ]);
  });

  it('在同一名称内连续匹配，只允许末尾音节输入全拼前缀', () => {
    expect(createPinyinMatcher('xi门dx')?.test('厦门大学')).toBe(false);
    const matcher = createPinyinMatcher('厦门dx')!;
    expect(matcher.test('厦门', '大学')).toBe(false);
    expect(matcher.test('厦门某大学')).toBe(false);
    expect(matcher.test('厦门-大学')).toBe(false);
  });

  it('保留输入单个字母的行为，以及相同起点取较长的高亮', () => {
    expect(createPinyinMatcher('x')).toBeUndefined();
    expect(createPinyinMatcher('厦门')).toBeUndefined();
    expect(createPinyinMatcher('sh')?.findRanges('上海')).toEqual([[0, 2]]);
  });
});
