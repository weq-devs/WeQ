// @ts-nocheck
import { TimeLabel } from '../../components/TimeLabel';
import { formatChatTime, type TimeValue } from '@weq/time';
import { cn } from './classNames';

export function MessageTimeDivider({
  value,
  precision = 'second',
}: {
  value: TimeValue;
  precision?: 'second' | 'millisecond';
}) {
  const label = formatChatTime(value);

  if (!label) {
    return null;
  }

  return (
    <TimeLabel className={cn('message-time-divider')} value={value} precision={precision}>
      {label}
    </TimeLabel>
  );
}
