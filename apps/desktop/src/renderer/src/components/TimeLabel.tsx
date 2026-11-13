import type { ReactNode } from 'react';
import {
  formatDateTime,
  formatDuration,
  timeDate,
  type TimePrecision,
  type TimeValue,
} from '@weq/time';
import '../styles/time-label.css';

/** 完整时间提示由应用现有 HoverTooltip 统一承载，不为每行增加计时器。 */
export function TimeLabel({
  value,
  precision = 'second',
  children,
  className,
}: {
  value: TimeValue;
  precision?: TimePrecision;
  children?: ReactNode;
  className?: string;
}) {
  const full = formatDateTime(value, precision);
  if (!full) return <>{children}</>;
  const dateOnly =
    precision === 'day' || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
  return (
    <time
      className={className ? `weq-time-label ${className}` : 'weq-time-label'}
      dateTime={dateOnly ? full : timeDate(value)?.toISOString()}
      title={`${full}（北京时间）`}
      aria-label={`${full}（北京时间）`}
      tabIndex={0}
      data-time-detail
      data-hover-delay="0"
    >
      {children ?? full}
    </time>
  );
}

export function DurationLabel({ seconds }: { seconds: number }) {
  const full = seconds === 0 ? '<1秒（按秒级消息时间计算）' : formatDuration(seconds);
  return (
    <span
      className="weq-time-label"
      title={full}
      tabIndex={0}
      data-time-detail
      data-hover-delay="0"
    >
      {formatDuration(seconds, 'approximate') || '-'}
    </span>
  );
}
