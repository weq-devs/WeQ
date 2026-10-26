import { describe, expect, it } from 'vitest';
import { searchNameRank } from '../src/account/search_policy';

describe('搜索匹配度', () => {
  it('完整相等、连续命中、断开命中、不匹配依次递减，不让长度跨越匹配层级', () => {
    const scores = ['报告', `很长的${'年度'.repeat(40)}报告`, '报-告', '报表'].map((name) =>
      searchNameRank('报告', name),
    );
    expect(scores[0]).toBeGreaterThan(scores[1]!);
    expect(scores[1]).toBeGreaterThan(scores[2]!);
    expect(scores[2]).toBeGreaterThan(scores[3]!);
    expect(scores[3]).toBe(0);
  });
  it('同为连续命中时短结果优先，不让长前缀压过短包含', () => {
    expect(searchNameRank('报告', '周报告')).toBeGreaterThan(
      searchNameRank('报告', '报告及年度汇总'),
    );
    expect(searchNameRank('报告', '周报告')).toBeGreaterThan(searchNameRank('报告', '上周报告'));
    expect(searchNameRank('报告', '报告周')).toBeGreaterThan(searchNameRank('报告', '周报告'));
  });
  it('断开命中优先紧凑窗口，重复字符选最紧的完整窗口', () => {
    expect(searchNameRank('abc', 'a-bc')).toBeGreaterThan(searchNameRank('abc', 'a---b-c'));
    expect(searchNameRank('abc', 'a---ab-c')).toBeGreaterThan(searchNameRank('abc', 'a---b-c'));
    expect(searchNameRank('aab', 'ab')).toBe(0);
    expect(searchNameRank('abc', 'cba')).toBe(0);
  });
  it('统一大小写、全半角和空白，按 Unicode 字符计算，别名取最佳而不叠加刷分', () => {
    expect(searchNameRank('ABC', 'ＡｂＣ')).toBe(searchNameRank('abc', 'abc'));
    expect(searchNameRank(' a  b ', 'A B')).toBe(searchNameRank('a b', 'a b'));
    expect(searchNameRank('报告', '报告', '报告')).toBe(searchNameRank('报告', '报告'));
    expect(searchNameRank('报告', '无关', '报告')).toBe(searchNameRank('报告', '报告'));
    expect(searchNameRank('😀', '😀x')).toBe(searchNameRank('a', 'ab'));
    expect(searchNameRank(' ', '名称')).toBe(0);
  });
});
