export type MessageDay = { day: string; count: number };
export type CalendarTarget = { kind: 'group' | 'c2c'; conv: string };

export function beijingDay(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function daySeconds(day: string): number {
  return Date.parse(`${day}T00:00:00+08:00`) / 1000;
}

/** 与本地聊天库相同的七级对数密度，稀疏日期仍有可见色阶。 */
export function messageDensity(count: number, maxCount: number): number {
  return count > 0 && maxCount > 0
    ? Math.min(7, Math.max(1, Math.ceil((7 * Math.log1p(count)) / Math.log1p(maxCount))))
    : 0;
}

export function pickCalendarRange(start: string, end: string, day: string) {
  if (!start || end) return { start: day, end: '' };
  return day < start ? { start: day, end: start } : { start, end: day };
}
