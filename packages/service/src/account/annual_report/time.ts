export function currentReportYear(now = new Date()): number {
  return now.getFullYear();
}

export function normalizeReportYear(year: number | undefined, now = new Date()): number {
  const value = year ?? currentReportYear(now);
  if (!Number.isInteger(value) || value < 1970 || value > currentReportYear(now) + 1) {
    throw new Error(`无效的报告年份：${value}`);
  }
  return value;
}

/** Local-time half-open range: [Jan 1 of year, Jan 1 of next year). */
export function reportYearRange(year: number): { from: Date; to: Date } {
  return {
    from: new Date(year, 0, 1, 0, 0, 0, 0),
    to: new Date(year + 1, 0, 1, 0, 0, 0, 0),
  };
}

export function localDateKey(timestampSeconds: number): string {
  const date = new Date(timestampSeconds * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
