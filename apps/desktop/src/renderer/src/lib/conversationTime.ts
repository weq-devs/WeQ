const beijing = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 群助手等紧凑列表保留日期和时间，不依赖系统时区。 */
export function formatConversationTimestamp(value: string | undefined, now = new Date()): string {
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime()) || date.getTime() <= 0) return '';
  const parts = (input: Date) =>
    Object.fromEntries(beijing.formatToParts(input).map(({ type, value }) => [type, value]));
  const at = parts(date),
    today = parts(now);
  const time = `${at.hour}:${at.minute}`;
  return `${at.year === today.year ? '' : `${at.year}-`}${at.month}-${at.day} ${time}`;
}
