import { afterEach, expect, it, vi } from 'vitest';
import {
  currentReportYear,
  localDateKey,
  normalizeReportYear,
  reportSinceLabel,
  reportSpanDays,
  reportYearUnixRange,
} from '../src/account/annual_report/time';
import { dayIndex } from '../src/account/annual_report/day_runs';
import { sparkPage } from '../src/account/annual_report/pages/spark/compute';
import { monthsPage } from '../src/account/annual_report/pages/months/compute';
import { DEFAULT_REPORT_SCOPE, type ReportQueries } from '../src/account/annual_report/types';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each(['America/Los_Angeles', 'UTC', 'Asia/Shanghai'])('年度边界不受主机时区 %s 影响', (tz) => {
  vi.stubEnv('TZ', tz);
  const now = new Date('2025-12-31T16:00:00Z');
  expect(currentReportYear(now)).toBe(2026);
  expect(normalizeReportYear(undefined, now)).toBe(2026);
  expect(reportYearUnixRange(2026)).toEqual({
    startSec: Date.parse('2026-01-01T00:00:00+08:00') / 1000,
    endSec: Date.parse('2027-01-01T00:00:00+08:00') / 1000,
  });
  expect(localDateKey(now.getTime() / 1000)).toBe('2026-01-01');
  expect(reportSinceLabel(0, now.getTime() / 1000)).toBe('自 2026 年 1 月起');
  expect(reportYearUnixRange(0)).toEqual({ startSec: 0, endSec: 0 });
});

it('日均覆盖起止自然日，午夜与同一天的时间差不改变分母', () => {
  vi.stubEnv('TZ', 'America/Los_Angeles');
  const oldest = Date.parse('2026-01-01T23:59:59+08:00') / 1000;
  const midnight = new Date('2026-01-02T00:00:00+08:00');
  expect(reportSpanDays(0, oldest, midnight)).toBe(2);
  expect(reportSpanDays(2026, null, midnight)).toBe(2);
  expect(reportSpanDays(2026, null, new Date('2026-01-02T23:59:59+08:00'))).toBe(2);
  expect(reportSpanDays(2024, null, midnight)).toBe(366);
  expect(reportSpanDays(0, null, midnight)).toBe(1);
});

it('连续自然日不被夏令时切换压缩或拉长', () => {
  vi.stubEnv('TZ', 'America/Los_Angeles');
  for (const days of [
    ['2026-03-07', '2026-03-08', '2026-03-09'],
    ['2026-10-31', '2026-11-01', '2026-11-02'],
  ]) {
    expect(days.slice(1).map((day, i) => dayIndex(day) - dayIndex(days[i]!))).toEqual([1, 1]);
  }
});

it('跨年瞬间的火花正文窗口、滚动补足和月份使用同一北京口径', async () => {
  vi.stubEnv('TZ', 'America/Los_Angeles');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00+08:00'));
  const unused = () => {
    throw new Error('不应读取无关分析来源');
  };
  const tallies = vi.fn<ReportQueries['c2c']['peerDayTallies']>().mockResolvedValue([]);
  tallies.mockResolvedValueOnce([{ peerUid: 'u_peer', date: '2026-01-01', total: 2, mine: 1 }]);
  const messages = vi.fn<ReportQueries['c2c']['peerMessagesInWindow']>().mockResolvedValue([]);
  const q: ReportQueries = {
    c2c: {
      peerDayTallies: tallies,
      peerMessagesInWindow: messages,
      peerProfiles: async () => [],
      initiationTallies: unused,
    },
    buddies: { list: async () => [] },
    overview: { countByDirection: unused },
    dress: { tally: unused, names: unused },
    emoji: { names: unused },
    speech: { sentRows: unused },
    group: {
      countRows: unused,
      speechRows: unused,
      standing: unused,
      interactionTally: unused,
      details: unused,
      memberBriefs: unused,
      allActiveMembers: unused,
    },
    meta: {
      oldestMessageTime: unused,
      yearsWithMessages: unused,
      selfIdentity: unused,
      botUids: unused,
    },
    rhythm: { sentWeekdayHourlyTallies: unused },
    qzone: { canQuery: unused, posts: unused, likeCount: unused },
  };
  const ctx = {
    year: 2026,
    scope: DEFAULT_REPORT_SCOPE,
    q,
    signal: new AbortController().signal,
    dataRevision: 'synthetic',
  };
  const data = await sparkPage.compute(ctx);
  const start = Date.parse('2026-01-01T00:00:00+08:00') / 1000;
  expect(messages).toHaveBeenCalledWith('u_peer', start, start + 86400);
  expect(tallies).toHaveBeenNthCalledWith(2, Date.parse('2025-02-01T00:00:00+08:00') / 1000, start);
  expect(data.wallWindow).toEqual({ fromYear: 2025, fromMonth: 2, toYear: 2026, toMonth: 1 });
  expect((await monthsPage.compute(ctx)).monthCount).toBe(1);
});
