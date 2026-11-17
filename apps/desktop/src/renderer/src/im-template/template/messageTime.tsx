// @ts-nocheck
import { TimeLabel } from '../../components/TimeLabel';
import * as timeFormat from '@weq/time';
import { cn } from './classNames';

export function MessageTimeDivider({
  value,
  precision = 'second',
}: {
  value: string | undefined;
  precision?: 'second' | 'millisecond';
}) {
  const label = formatMessageTimeDivider(value);

  if (!label) {
    return null;
  }

  return (
    <TimeLabel className={cn('message-time-divider')} value={value} precision={precision}>
      {label}
    </TimeLabel>
  );
}

function formatMessageTimeDivider(value: string | undefined) {
  return timeFormat.formatChatTime(value);
}
