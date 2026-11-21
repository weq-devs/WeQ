import { formatDateTime, timeDate, unixDate } from '@weq/time';
import { TimeLabel } from './TimeLabel';
import '../styles/qzone-time.css';

const pad = (part: string) => part.padStart(2, '0');

function normalizeLabel(value: string): string {
  const label = value.trim().replace(/\s+/g, ' ');
  if (!label) return '';
  const absolute = label
    .replace(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*/, '$1-$2-$3 ')
    .trimEnd()
    .replace(
      /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?=$|[ T])/,
      (_, year, month, day) => `${year}-${pad(month)}-${pad(day)}`,
    )
    .replace(/^([\d-]{10}) (\d)(?=:)/, '$1 0$2');
  if (timeDate(absolute)) return absolute;

  // QQ 有时只给月日或相对日期，保留其原有日期信息。
  return label
    .replace(/^(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*/, '$1 月 $2 日 ')
    .replace(/^(今天|昨天|前天)\s*(?=\d)/, '$1 ')
    .trimEnd();
}

export function QzoneTime({
  value,
  interactive = true,
}: {
  value: number | string | null | undefined;
  interactive?: boolean;
}) {
  const label = typeof value === 'string' ? normalizeLabel(value) : '';
  const time = typeof value === 'number' && value > 0 ? unixDate(value) : label;
  const date = timeDate(time);
  if (!date) {
    return label ? <span className="weq-time-label weq-qzn-time">{label}</span> : null;
  }
  if (interactive) return <TimeLabel value={time} className="weq-qzn-time" />;

  // 在媒体按钮和折叠标题内保留父级点击行为。
  const display = formatDateTime(time);
  const dateTime = /^\d{4}-\d{2}-\d{2}$/.test(display) ? display : date.toISOString();
  return (
    <time className="weq-time-label weq-qzn-time" dateTime={dateTime}>
      {display}
    </time>
  );
}
