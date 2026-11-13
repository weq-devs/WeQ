import { formatConversationTime as compact, formatListTimestamp, timeDate } from '@weq/time';

/** 紧凑会话时间按北京自然日分段，完整值由时间提示提供。 */
export function formatConversationTime(value: string | undefined, now = new Date()): string {
  return compact(value, now);
}

export function formatConversationTimestamp(value: string | undefined, now = new Date()): string {
  const date = timeDate(value);
  return date && date.getTime() > 0 ? formatListTimestamp(date, now) : '';
}
