/**
 * 「我的主场」轮盘数据：前 8 群 + 周 sparkline 的对齐。
 *
 * 这里钉住两件容易悄悄错的事：
 *   - 只取前 8（不是全部、也不是只取冠军）；
 *   - SQL 返回的 week 序号要落到正确的柱子上，且缺周补 0。
 */

import { describe, expect, it } from 'vitest';
import { homePage, reportWeekSpan } from '../src/account/annual_report/pages/home/compute';
import { reportYearUnixRange } from '../src/account/annual_report/time';

const YEAR = 2026;

function rankedRows() {
  return Array.from({ length: 10 }, (_, index) => ({
    groupCode: `g${index}`,
    groupName: `群 ${index}`,
    memberCount: 10 + index,
    sentCount: 100 - index,
    totalCount: 1000 - index,
  }));
}

describe('我的主场：轮盘卡片', () => {
  it('按自己发言数取前 8，周序列与报告窗口对齐', async () => {
    const ranked = rankedRows();
    const { startSec, endSec } = reportYearUnixRange(YEAR);
    const weekly = [
      { groupCode: 'g0', week: 0, count: 2 },
      { groupCode: 'g0', week: 52, count: 5 },
      { groupCode: 'g2', week: 10, count: 3 },
    ];
    const q = {
      group: {
        countRows: async () => ranked,
        weeklyCounts: async () => weekly,
        speechRows: async () => [],
        standing: async () => null,
      },
    };
    const data = await homePage.compute({
      year: YEAR,
      scope: {} as never,
      q: q as never,
      signal: new AbortController().signal,
      dataRevision: 'test',
    });

    expect(data.groups).toHaveLength(8);
    expect(data.groups.map((g) => g.groupCode)).toEqual(
      Array.from({ length: 8 }, (_, i) => `g${i}`),
    );
    // 2026-01-01 所在周的周一是 2025-12-29，12/31 仍在同一周序列里。
    // 年度报告的半开窗口覆盖 53 个周起点。
    expect(data.groups[0]!.weekly).toHaveLength(53);
    expect(data.groups[0]!.weekly[0]).toBe(2);
    expect(data.groups[0]!.weekly[52]).toBe(5);
    expect(data.groups[2]!.weekly[10]).toBe(3);
    expect(data.groups[1]!.weekly.every((n) => n === 0)).toBe(true);

    expect(data.top?.groupCode).toBe('g0');
    expect(data.activeGroupCount).toBe(10);
    expect(data.groupSentTotal).toBe(ranked.reduce((sum, row) => sum + row.sentCount, 0));
    expect(startSec).toBeGreaterThan(0);
    expect(endSec).toBeGreaterThan(startSec);
    expect(reportWeekSpan(startSec, endSec)).toBe(53);
  });

  it('周序列从所在周的周一算起，与 SQL 周序号口径一致', () => {
    // 2026-01-07 是周三；从周三开始的一段时间仍覆盖它所在的整周。
    const start = Math.floor(new Date(2026, 0, 7, 12).getTime() / 1000);
    const end = Math.floor(new Date(2026, 0, 21, 12).getTime() / 1000);
    expect(reportWeekSpan(start, end)).toBe(3);
  });

  it('sparkline SQL 失败时仍保留冠军兜底所需的卡片数字', async () => {
    const q = {
      group: {
        countRows: async () => rankedRows().slice(0, 1),
        weeklyCounts: async () => {
          throw new Error('sparkline unavailable');
        },
        speechRows: async () => [],
        standing: async () => null,
      },
    };
    const data = await homePage.compute({
      year: YEAR,
      scope: {} as never,
      q: q as never,
      signal: new AbortController().signal,
      dataRevision: 'test',
    });
    expect(data.groups).toHaveLength(1);
    expect(data.groups[0]?.sentCount).toBe(100);
    expect(data.groups[0]?.weekly).toHaveLength(53);
  });
});
