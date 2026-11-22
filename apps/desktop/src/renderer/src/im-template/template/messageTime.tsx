// @ts-nocheck
import { TimeLabel } from '../../components/TimeLabel';
import { useOutgoingMetadataMotion } from '../../hooks/useOutgoingMetadataMotion';
import { formatChatTime, type TimeValue } from '@weq/time';
import { cn } from './classNames';

export function MessageTimeDivider({
  value,
  precision = 'second',
  visible = true,
  animate = false,
}: {
  value: TimeValue;
  precision?: 'second' | 'millisecond';
  visible?: boolean;
  animate?: boolean;
}) {
  const label = visible ? formatChatTime(value) : null;
  const ref = useOutgoingMetadataMotion<HTMLTimeElement>(label, animate);

  if (!label) {
    return null;
  }

  return (
    <TimeLabel
      ref={ref}
      className={cn('message-time-divider')}
      value={value}
      precision={precision}
      tabbable={false}
    >
      {label}
    </TimeLabel>
  );
}
