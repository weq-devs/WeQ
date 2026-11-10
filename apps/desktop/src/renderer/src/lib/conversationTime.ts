/**
 * 手表的“今天 HH:mm”格式化器。放在模块级：会话列表每行都会调用，逐行新建
 * Intl 实例既浪费又会让翻页时出现可感知的分配抖动。
 */
const hourMinute = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
});

const beijing = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 会话列表统一规则：今天显示时分，昨天显示“昨天 时分”，一周内显示星期，更早显示年月日。 */
export function formatConversationTime(value: string | undefined, now = new Date()): string {
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return '';
  const startOfDay = (input: Date) =>
    new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
  const dayDiff = Math.floor((startOfDay(now) - startOfDay(date)) / 86400000);

  if (dayDiff <= 0) {
    return hourMinute.format(date);
  }
  if (dayDiff === 1) return `昨天 ${hourMinute.format(date)}`;
  if (dayDiff < 7) {
    return ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][date.getDay()]!;
  }
  const pad = (part: number) => part.toString().padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

/** 账号入口等需要完整日期的列表保留日期和时间，不依赖系统时区。 */
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
