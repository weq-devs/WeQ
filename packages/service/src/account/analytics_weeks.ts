/**
 * 会话分析（群聊 / 私聊）共用的一周分桶工具。
 *
 * 为什么单独一层：群聊的「每人每周发言」和私聊的「双方每周消息」必须用**同一套
 * 周起点**，否则两张图放在一起会对不齐；时间轴选择、周柱状图、成员卡里的
 * sparkline 也都依赖它。这里只做纯计算（北京时间、周一为一周起点），不碰数据库。
 */
import { analyticsDayParts } from '../common/analytics_time';

/** `YYYY-MM-DD`（北京时间）。 */
export function localDateKey(date: Date): string {
  return analyticsDayParts(date.getTime() / 1000)?.day ?? '';
}

/** 该日期所在周的周一（北京时间，00:00）。 */
export function weekStartOf(date: Date): Date {
  const dayIndex = Math.floor((date.getTime() + 8 * 3600_000) / 86400_000);
  const offset = (((dayIndex + 3) % 7) + 7) % 7;
  return new Date((dayIndex - offset) * 86400_000 - 8 * 3600_000);
}

/** 该日期所在周的周一日期键（`YYYY-MM-DD`）。 */
export function weekStartKey(date: Date): string {
  return localDateKey(weekStartOf(date));
}

/**
 * 覆盖 [startSec, endSec] 的周起点序列（含首尾）。
 *
 * `startSec` / `endSec` 为 unix 秒；两者都为 0 时返回空数组（调用方用全历史
 * 的周序列兜底）。一周一根柱子，范围越长数组越长，但最长也就历史年数 × 52。
 */
export function buildWeekKeys(startSec: number, endSec: number): string[] {
  if (!(startSec > 0) || !(endSec > 0) || endSec < startSec) return [];
  const first = weekStartOf(new Date(startSec * 1000));
  const last = weekStartOf(new Date(endSec * 1000));
  const keys: string[] = [];
  const cursor = new Date(first);
  while (cursor.getTime() <= last.getTime()) {
    keys.push(localDateKey(cursor));
    cursor.setTime(cursor.getTime() + 7 * 86400_000);
  }
  return keys;
}

export interface DailyCount {
  /** 本地日期，`YYYY-MM-DD`。 */
  date: string;
  count: number;
}

export interface WeeklyCount {
  /** 该周周一的本地日期，`YYYY-MM-DD`。 */
  weekStart: string;
  count: number;
}

/** 每日计数 → 每周计数（周一为起点，升序）。 */
export function dailyToWeekly(daily: DailyCount[]): WeeklyCount[] {
  const byWeek = new Map<string, number>();
  for (const item of daily) {
    const [y, m, d] = item.date.split('-').map(Number);
    if (!y || !m || !d) continue;
    const key = weekStartKey(new Date(Date.UTC(y, m - 1, d) - 8 * 3600_000));
    byWeek.set(key, (byWeek.get(key) ?? 0) + item.count);
  }
  return [...byWeek.entries()]
    .map(([weekStart, count]) => ({ weekStart, count }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

/** 把「周 → 次数」映射按给定的周序列展开成数组（缺周补 0）。 */
export function seriesForWeeks(weeks: string[], counts: Map<string, number>): number[] {
  return weeks.map((week) => counts.get(week) ?? 0);
}
