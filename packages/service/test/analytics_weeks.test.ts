/**
 * 会话分析周分桶的单测。
 *
 * 群里每人的周卡、私聊双方的周卡、顶部 GitHub 式柱状图都依赖同一套周起点；
 * 一旦时区/周一偏移算错，三处会一起错，但页面上看起来只是「柱子有点歪」，
 * 很难靠肉眼发现。所以这里把周一、跨月、缺周补零都钉住。
 */

import { describe, expect, it } from 'vitest';
import {
  buildWeekKeys,
  dailyToWeekly,
  localDateKey,
  seriesForWeeks,
  weekStartKey,
} from '../src/account/analytics_weeks';

describe('analytics_weeks', () => {
  it('把周三归到本周周一', () => {
    // 2026-10-14 是周三；所在周的周一是 2026-10-12。
    expect(weekStartKey(new Date(2026, 9, 14, 14, 30))).toBe('2026-10-12');
  });

  it('把周日归到上一周的周一（而不是下一周）', () => {
    // 2026-10-18 是周日；周一为 2026-10-12。
    expect(weekStartKey(new Date(2026, 9, 18, 9, 0))).toBe('2026-10-12');
  });

  it('覆盖区间首尾的周起点（含首尾）', () => {
    const start = Math.floor(new Date(2026, 9, 14).getTime() / 1000);
    const end = Math.floor(new Date(2026, 9, 28).getTime() / 1000);
    expect(buildWeekKeys(start, end)).toEqual(['2026-10-12', '2026-10-19', '2026-10-26']);
  });

  it('没有有效区间时返回空数组', () => {
    expect(buildWeekKeys(0, 0)).toEqual([]);
    expect(buildWeekKeys(100, 50)).toEqual([]);
  });

  it('每日计数按周合并，跨月也落在同一根柱子上', () => {
    const weekly = dailyToWeekly([
      { date: '2026-10-11', count: 1 }, // 周日 → 10-05 那周
      { date: '2026-10-12', count: 2 }, // 周一 → 10-12 那周
      { date: '2026-10-13', count: 3 },
      { date: '2026-10-18', count: 4 }, // 周日仍属于 10-12 那周
    ]);
    expect(weekly).toEqual([
      { weekStart: '2026-10-05', count: 1 },
      { weekStart: '2026-10-12', count: 9 },
    ]);
  });

  it('按给定周序列补零（缺周不会被挤掉）', () => {
    const counts = new Map([
      ['2026-10-12', 5],
      ['2026-10-26', 2],
    ]);
    expect(seriesForWeeks(['2026-10-12', '2026-10-19', '2026-10-26'], counts)).toEqual([5, 0, 2]);
  });

  it('localDateKey 固定使用北京时间而不是主机时区', () => {
    const date = new Date('2026-01-02T23:30:00+08:00');
    expect(localDateKey(date)).toBe('2026-01-02');
  });

  it('北京时间跨周时，日键、周键和周序列采用同一边界', () => {
    const before = new Date('2026-10-18T15:59:59Z');
    const after = new Date('2026-10-18T16:00:00Z');
    expect(localDateKey(after)).toBe('2026-10-19');
    expect(weekStartKey(before)).toBe('2026-10-12');
    expect(weekStartKey(after)).toBe('2026-10-19');
    expect(buildWeekKeys(before.getTime() / 1000, after.getTime() / 1000)).toEqual([
      '2026-10-12',
      '2026-10-19',
    ]);
  });
});
