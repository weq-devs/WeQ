export interface AnalyticsRange {
  startTime?: number;
  endTime?: number;
}

export function validateAnalyticsRange(range: AnalyticsRange = {}): AnalyticsRange {
  for (const value of [range.startTime, range.endTime]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new Error('分析时间必须是非负整数秒。');
  }
  if (
    range.startTime !== undefined &&
    range.endTime !== undefined &&
    range.startTime > range.endTime
  )
    throw new Error('分析开始时间不能晚于结束时间。');
  return { startTime: range.startTime, endTime: range.endTime };
}

export function analyticsBrowseFilter(range: AnalyticsRange) {
  const valid = validateAnalyticsRange(range);
  return { start: valid.startTime, end: valid.endTime };
}

export function analyticsDayParts(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const shifted = new Date((seconds + 8 * 3600) * 1000);
  if (!Number.isFinite(shifted.getTime())) return null;
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const date = shifted.getUTCDate();
  return {
    day: `${year}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`,
    hour: shifted.getUTCHours(),
    dayIndex: Math.floor((seconds + 8 * 3600) / 86400),
  };
}
