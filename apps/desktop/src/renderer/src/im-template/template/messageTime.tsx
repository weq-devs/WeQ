// @ts-nocheck
import { TimeLabel } from '../../components/TimeLabel';
import * as timeFormat from '@weq/time';
import type { Message } from './types';
import { cn } from './classNames';

const messageTimeDividerIntervalMs = 5 * 60 * 1000;

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

export function shouldShowMessageTime(previous: Message | undefined, current: Message) {
  if (!previous) {
    return true;
  }

  const previousTime = new Date(previous.createdAt).getTime();
  const currentTime = new Date(current.createdAt).getTime();
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) {
    return false;
  }

  return currentTime - previousTime >= messageTimeDividerIntervalMs;
}

function formatMessageTimeDivider(value: string | undefined) {
  return timeFormat.formatChatTime(value);
}
