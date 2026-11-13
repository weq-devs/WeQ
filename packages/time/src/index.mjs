/** 自包含工厂同时服务模块和内嵌页面，打包改名后仍保持完整闭包。 */
function createTimeRuntime() {
  const TIME_ZONE = 'Asia/Shanghai';
  const OFFSET = 8 * 3600_000;
  const DAY = 86400_000;
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  /** 数值输入一律为毫秒；秒值必须显式通过 unixDate 转换。无时区墙钟按北京解析。 */
  function timeDate(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string') {
      value = value.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T');
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const parsed = parseDateTimeInput(`${value}T00:00:00`);
        return parsed === null ? null : new Date(parsed);
      }
      const wall = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;
      if (wall.test(value)) {
        const parsed = parseDateTimeInput(value.replace(' ', 'T'));
        return parsed === null ? null : new Date(parsed);
      }
      if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
      const zoned = value.match(
        /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(?:Z|[+-]\d{2}:?\d{2})$/i,
      );
      if (!zoned || parseDateTimeInput(zoned[1]) === null) return null;
    }
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function unixDate(seconds) {
    if (seconds === null || seconds === undefined || seconds === '') return null;
    const value = Number(seconds);
    return Number.isFinite(value) ? timeDate(value * 1000) : null;
  }

  function calendarParts(value) {
    const date = timeDate(value);
    if (!date) return null;
    const shifted = new Date(date.getTime() + OFFSET);
    if (!Number.isFinite(shifted.getTime())) return null;
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      weekday: shifted.getUTCDay(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
      millisecond: shifted.getUTCMilliseconds(),
      dayIndex: Math.floor((date.getTime() + OFFSET) / DAY),
    };
  }

  function calendarStart(year, month = 1, day = 1) {
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime() - OFFSET;
  }

  function formatDate(value) {
    const p = calendarParts(value);
    return p ? `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}` : '';
  }

  function formatClock(value, precision = 'second') {
    const p = calendarParts(value);
    if (!p) return '';
    const hm = `${pad(p.hour)}:${pad(p.minute)}`;
    if (precision === 'minute') return hm;
    const hms = `${hm}:${pad(p.second)}`;
    return precision === 'millisecond' ? `${hms}.${pad(p.millisecond, 3)}` : hms;
  }

  function formatDateTime(value, precision = 'second') {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
    if (
      typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})?$/.test(value) &&
      precision !== 'day'
    )
      precision = 'minute';
    const day = formatDate(value);
    if (!day || precision === 'day') return day;
    return `${day} ${formatClock(value, precision)}`;
  }

  function formatUnixTime(seconds, precision = 'second') {
    return formatDateTime(unixDate(seconds), precision);
  }

  function formatChineseDate(value, withYear = true) {
    const p = calendarParts(value);
    return p ? `${withYear ? `${p.year}年` : ''}${p.month}月${p.day}日` : '';
  }

  function formatPartialDate({ year, month, day }) {
    return `${Number.isInteger(year) && year > 0 ? `${year}年` : ''}${Number.isInteger(month) && month >= 1 && month <= 12 ? `${month}月` : ''}${Number.isInteger(day) && day >= 1 && day <= 31 ? `${day}日` : ''}`;
  }

  function formatMonth(value) {
    const p = calendarParts(value);
    return p ? `${p.year}年${p.month}月` : '';
  }

  function formatChatTime(value, now = Date.now()) {
    const p = calendarParts(value),
      today = calendarParts(now);
    if (!p || !today) return '';
    const diff = today.dayIndex - p.dayIndex;
    const clock = formatClock(value);
    if (diff === 0) return clock;
    if (diff === 1) return `昨天 ${clock}`;
    if (diff > 1 && diff < 7) return `${weekdays[p.weekday]} ${clock}`;
    return formatDateTime(value);
  }

  function formatConversationTime(value, now = Date.now(), mode = 'conversation') {
    const p = calendarParts(value),
      today = calendarParts(now);
    if (!p || !today) return '';
    const diff = today.dayIndex - p.dayIndex;
    if (diff === 0) return formatClock(value, 'minute');
    if (mode === 'conversation' && diff === 1) return `昨天 ${formatClock(value, 'minute')}`;
    if (mode === 'conversation' && diff > 1 && diff < 7) return weekdays[p.weekday];
    const date = formatDate(value);
    return mode === 'conversation' || p.year !== today.year ? date : date.slice(5);
  }

  function formatListTimestamp(value, now = Date.now()) {
    const p = calendarParts(value),
      today = calendarParts(now);
    if (!p || !today) return '';
    return `${p.year === today.year ? formatDate(value).slice(5) : formatDate(value)} ${formatClock(value, 'minute')}`;
  }

  function formatTimeRange(start, end, now = Date.now()) {
    const a = calendarParts(start),
      b = calendarParts(end),
      today = calendarParts(now);
    if (!a || !b || !today) return '';
    const date = (value, p) =>
      a.year !== b.year || p.year !== today.year ? formatDate(value) : formatDate(value).slice(5);
    return `${date(start, a)} ${formatClock(start)} — ${a.dayIndex === b.dayIndex ? '' : `${date(end, b)} `}${formatClock(end)}`;
  }

  function formatRelativeTime(value, now = Date.now(), fallbackDays = 30) {
    const date = timeDate(value),
      current = timeDate(now);
    if (!date || !current) return '';
    const delta = current.getTime() - date.getTime(),
      seconds = Math.abs(delta) / 1000;
    if (seconds < 60) return delta >= 0 ? '刚刚' : '即将';
    if (seconds >= fallbackDays * 86400) return formatDateTime(date);
    const [amount, unit] =
      seconds < 3600
        ? [Math.floor(seconds / 60), '分钟']
        : seconds < 86400
          ? [Math.floor(seconds / 3600), '小时']
          : [Math.floor(seconds / 86400), '天'];
    return `${amount} ${unit}${delta >= 0 ? '前' : '后'}`;
  }

  function formatDuration(seconds, style = 'exact') {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const rounded = Math.round(seconds);
    if (style === 'media' || style === 'call') {
      return `${style === 'call' ? pad(Math.floor(rounded / 60)) : Math.floor(rounded / 60)}:${pad(rounded % 60)}`;
    }
    if (style === 'countdown')
      return `${pad(Math.floor(rounded / 3600))}:${pad(Math.floor(rounded / 60) % 60)}:${pad(rounded % 60)}`;
    if (style === 'elapsed')
      return seconds < 1
        ? `${Number((seconds * 1000).toFixed(3))} ms`
        : `${Number(seconds.toFixed(3))} s`;
    if (style === 'approximate') {
      if (seconds < 1) return '<1秒';
      if (rounded >= 86400) return `${Number((seconds / 86400).toFixed(1))}天`;
      if (rounded >= 3600) return `${Number((seconds / 3600).toFixed(1))}小时`;
    }
    let rest = style === 'exact' ? Math.round(seconds * 1000) / 1000 : rounded;
    const parts = [];
    for (const [unit, size] of [
      ['天', 86400],
      ['小时', 3600],
      ['分', 60],
      ['秒', 1],
    ]) {
      const amount = size === 1 ? Number(rest.toFixed(3)) : Math.floor(rest / size);
      rest = Number((rest % size).toFixed(3));
      if (amount) parts.push(`${amount}${unit}`);
    }
    return parts.join('') || '0秒';
  }

  function formatDateTimeInput(value, precision = 'second') {
    return formatDateTime(value, precision).replace(' ', 'T');
  }

  /** 返回毫秒；对日历字段逐项回验，拒绝 Date 的自动进位。 */
  function parseDateTimeInput(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
    if (!m) return null;
    const [, y, mo, d, h, mi, s = '0', fraction = ''] = m;
    const ms =
      calendarStart(Number(y), Number(mo), Number(d)) +
      Number(h) * 3600_000 +
      Number(mi) * 60000 +
      Number(s) * 1000 +
      Number(fraction.padEnd(3, '0'));
    const p = calendarParts(ms);
    return p &&
      p.year === Number(y) &&
      p.month === Number(mo) &&
      p.day === Number(d) &&
      p.hour === Number(h) &&
      p.minute === Number(mi) &&
      p.second === Number(s)
      ? ms
      : null;
  }

  function calendarDayWindow(value, now = Date.now()) {
    let label;
    const raw = value?.trim() ?? '';
    if (raw) {
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
      if (!m) return null;
      label = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    } else label = formatDate(now);
    const start = parseDateTimeInput(`${label}T00:00:00`);
    return start === null ? null : { startSec: start / 1000, endSec: start / 1000 + 86400, label };
  }

  const eventTimeFormatter = { format: formatDateTime };
  const dateFormatter = { format: formatDate };
  const clockFormatter = { format: formatClock };
  const preciseTimeFormatter = { format: (value) => formatDateTime(value, 'millisecond') };
  const preciseClockFormatter = { format: (value) => formatClock(value, 'millisecond') };

  return {
    TIME_ZONE,
    timeDate,
    unixDate,
    calendarParts,
    calendarStart,
    calendarDayWindow,
    formatDate,
    formatClock,
    formatDateTime,
    formatUnixTime,
    formatChineseDate,
    formatPartialDate,
    formatMonth,
    formatChatTime,
    formatConversationTime,
    formatListTimestamp,
    formatTimeRange,
    formatRelativeTime,
    formatDuration,
    formatDateTimeInput,
    parseDateTimeInput,
    eventTimeFormatter,
    dateFormatter,
    clockFormatter,
    preciseTimeFormatter,
    preciseClockFormatter,
  };
}

export const {
  TIME_ZONE,
  timeDate,
  unixDate,
  calendarParts,
  calendarStart,
  calendarDayWindow,
  formatDate,
  formatClock,
  formatDateTime,
  formatUnixTime,
  formatChineseDate,
  formatPartialDate,
  formatMonth,
  formatChatTime,
  formatConversationTime,
  formatListTimestamp,
  formatTimeRange,
  formatRelativeTime,
  formatDuration,
  formatDateTimeInput,
  parseDateTimeInput,
  eventTimeFormatter,
  dateFormatter,
  clockFormatter,
  preciseTimeFormatter,
  preciseClockFormatter,
} = createTimeRuntime();

export const browserTimeSource = `const { TIME_ZONE, timeDate, unixDate, calendarParts, calendarStart, calendarDayWindow, formatDate, formatClock, formatDateTime, formatUnixTime, formatChineseDate, formatPartialDate, formatMonth, formatChatTime, formatConversationTime, formatListTimestamp, formatTimeRange, formatRelativeTime, formatDuration, formatDateTimeInput, parseDateTimeInput, eventTimeFormatter, dateFormatter, clockFormatter, preciseTimeFormatter, preciseClockFormatter } = (${createTimeRuntime.toString()})();`;
