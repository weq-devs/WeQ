import { describe, expect, it } from 'vitest';
import {
  normalizeRange,
  smoothLine,
  weeksInRange,
} from '../src/renderer/src/components/conversationTimeline';

function day(year: number, month: number, date: number): number {
  return Math.floor(new Date(year, month - 1, date, 12).getTime() / 1000);
}

describe('会话分析时间轴', () => {
  it('只保留与选区相交的周，并按周数重新生成柱状图序列', () => {
    const weeks = ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26', '2026-02-02'].map(
      (weekStart, index) => ({ weekStart, count: index + 1 }),
    );

    // 选区从周三开始：所在周仍相交；结束日之前整周都保留。
    const shown = weeksInRange(weeks, { start: day(2026, 1, 7), end: day(2026, 1, 25) });
    expect(shown.map((week) => week.weekStart)).toEqual(['2026-01-05', '2026-01-12', '2026-01-19']);

    const noRange = weeksInRange([...weeks, { weekStart: '', count: 9 }], null);
    expect(noRange).toHaveLength(5);
  });

  it('平滑曲线经过所有数据点且不产生 NaN', () => {
    const path = smoothLine([
      [0, 80],
      [10, 10],
      [20, 80],
    ]);
    expect(path).toMatch(/^M0\.00,80\.00/);
    expect(path).not.toContain('nan');
    expect(path).toMatch(/C[\d., ]+20\.00,80\.00$/);
  });

  it('选区至少保留一天并夹在数据范围内', () => {
    expect(
      normalizeRange(day(2026, 2, 1), day(2026, 2, 1), day(2026, 1, 1), day(2026, 3, 1)),
    ).toEqual({
      start: day(2026, 2, 1),
      end: day(2026, 2, 2),
    });
  });
});
