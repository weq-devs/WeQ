export const TIME_ZONE: 'Asia/Shanghai';
export type TimeValue = Date | number | string | null | undefined;
export type TimePrecision = 'day' | 'minute' | 'second' | 'millisecond';
export interface CalendarParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  dayIndex: number;
}
/** 数字必须是毫秒。 */
export function timeDate(value: TimeValue): Date | null;
export function unixDate(value: number | bigint | string | null | undefined): Date | null;
export function calendarParts(value: TimeValue): CalendarParts | null;
export function calendarStart(year: number, month?: number, day?: number): number;
export function calendarDayWindow(
  value?: string,
  now?: TimeValue,
): { startSec: number; endSec: number; label: string } | null;
export function formatDate(value: TimeValue): string;
export function formatClock(value: TimeValue, precision?: Exclude<TimePrecision, 'day'>): string;
export function formatDateTime(value: TimeValue, precision?: TimePrecision): string;
export function formatUnixTime(
  value: number | bigint | string | null | undefined,
  precision?: TimePrecision,
): string;
export function formatChineseDate(value: TimeValue, withYear?: boolean): string;
export function formatPartialDate(value: {
  year?: number | null;
  month?: number | null;
  day?: number | null;
}): string;
export function formatMonth(value: TimeValue): string;
export function formatChatTime(value: TimeValue, now?: TimeValue): string;
export function formatConversationTime(
  value: TimeValue,
  now?: TimeValue,
  mode?: 'conversation' | 'channel',
): string;
export function formatListTimestamp(value: TimeValue, now?: TimeValue): string;
export function formatTimeRange(start: TimeValue, end: TimeValue, now?: TimeValue): string;
export function formatRelativeTime(
  value: TimeValue,
  now?: TimeValue,
  fallbackDays?: number,
): string;
export function formatDuration(
  seconds: number,
  style?: 'exact' | 'approximate' | 'media' | 'call' | 'countdown' | 'elapsed',
): string;
export function formatDateTimeInput(
  value: TimeValue,
  precision?: Exclude<TimePrecision, 'day'>,
): string;
export function parseDateTimeInput(value: string): number | null;
export const eventTimeFormatter: { format: typeof formatDateTime };
export const dateFormatter: { format: typeof formatDate };
export const clockFormatter: { format: typeof formatClock };
export const preciseTimeFormatter: { format(value: TimeValue): string };
export const preciseClockFormatter: { format(value: TimeValue): string };
export const browserTimeSource: string;
