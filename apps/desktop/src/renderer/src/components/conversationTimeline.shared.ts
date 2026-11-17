/**
 * 私聊 / 群聊分析共用的「时间轴」组件。
 *
 * 三段：
 *   1. {@link GitHubTimeline} —— 所选区间的周柱状图（每周一根，随区间重排）；
 *   2. {@link RangeTimeline}  —— 消息曲线 + 可拖动的区间选择（默认最近一年）；
 *   3. {@link PersonWeekCard} —— 发言人卡片里的周 sparkline。
 *
 * 口径与后端 `analytics_weeks.ts` 一致：**周一是一周的第一天**，所有周序列都按
 * 北京时间对齐。这里只做展示与手势，不查库。
 */

import { daySeconds } from '../lib/messageCalendar';

export const DAY_SECONDS = 86400;
/** 拖动选择的最小跨度：一天。 */
const MIN_SPAN = DAY_SECONDS;

export interface WeeklyPoint {
  /** 该周周一的本地日期，`YYYY-MM-DD`。 */
  weekStart: string;
  count: number;
}

export interface RangeSelection {
  /** unix 秒（含）。 */
  start: number;
  /** unix 秒（含）。 */
  end: number;
}

export function parseDayKey(key: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? daySeconds(key) : 0;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Catmull-Rom → 三次贝塞尔。曲线经过每个真实数据点；把控制点限制在同一段
 * 的纵向范围内，避免高计数尖峰在平滑后跌到 0 以下（SVG 不会裁掉它，视觉上
 * 会出现假的负值波浪）。
 */
export function smoothLine(points: ReadonlyArray<readonly [number, number]>): string {
  if (points.length === 0) return '';
  let path = `M${points[0]![0].toFixed(2)},${points[0]![1].toFixed(2)}`;
  if (points.length === 1) return path;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    const low = Math.min(p1[1], p2[1]);
    const high = Math.max(p1[1], p2[1]);
    const c1y = clamp(p1[1] + (p2[1] - p0[1]) / 6, low, high);
    const c2y = clamp(p2[1] - (p3[1] - p1[1]) / 6, low, high);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    path += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(
      2,
    )} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return path;
}

/**
 * 选择区间的兜底：开始/结束必须落在数据范围内，且至少间隔一天。
 * 数据范围为空时原样返回。
 */
export function normalizeRange(
  start: number,
  end: number,
  min: number,
  max: number,
): RangeSelection {
  if (!(max > min)) return { start: min, end: max };
  let a = clamp(start, min, max);
  let b = clamp(end, min, max);
  if (b < a) [a, b] = [b, a];
  if (b - a < MIN_SPAN) {
    b = Math.min(max, a + MIN_SPAN);
    a = Math.max(min, b - MIN_SPAN);
  }
  return { start: a, end: b };
}

/**
 * 截出与选区相交的周。周起点不一定与选区恰好重合：选区从周三开始，这一周
 * 仍要算进来（否则该周的消息会从图中消失）。区间为空时保留全历史。
 */
export function weeksInRange(weeks: WeeklyPoint[], range: RangeSelection | null): WeeklyPoint[] {
  const valid = weeks.filter((week) => typeof week.weekStart === 'string' && week.weekStart);
  if (!range) return valid;
  return valid.filter((week) => {
    const start = parseDayKey(week.weekStart);
    return start + 7 * DAY_SECONDS > range.start && start <= range.end;
  });
}
