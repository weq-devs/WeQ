import type { HTMLAttributes } from 'react';
import { useUnreadMarkers } from '../lib/unreadMarkers';
import '../styles/reminder-badge.css';

type ReminderTone = 'notice' | 'muted' | 'running';
type Marker = Exclude<keyof ReturnType<typeof useUnreadMarkers>, 'aggregates'>;
type MarkerProps = { marker?: Marker | readonly Marker[] };

function reminderClass(kind: 'dot' | 'count', overlay: boolean, className?: string) {
  return `weq-reminder weq-reminder-${kind}${overlay ? ' weq-reminder-overlay' : ''}${className ? ` ${className}` : ''}`;
}

export function ReminderDot({
  marker,
  tone = 'notice',
  overlay = false,
  className,
  ...props
}: Omit<HTMLAttributes<HTMLSpanElement>, 'children'> &
  MarkerProps & { tone?: 'notice' | 'muted'; overlay?: boolean }) {
  const settings = useUnreadMarkers();
  if (marker && !(typeof marker === 'string' ? [marker] : marker).every((key) => settings[key]))
    return null;
  return <span {...props} className={reminderClass('dot', overlay, className)} data-tone={tone} />;
}

export function ReminderCount({
  marker,
  count,
  tone = 'notice',
  overlay = false,
  as = 'span',
  className,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'children'> &
  MarkerProps & {
    count: number;
    tone?: ReminderTone;
    overlay?: boolean;
    as?: 'span' | 'button';
  }) {
  const settings = useUnreadMarkers();
  if (marker && !(typeof marker === 'string' ? [marker] : marker).every((key) => settings[key]))
    return null;
  if (!Number.isFinite(count) || count <= 0) return null;
  const classes = reminderClass('count', overlay, className);
  const label = count > 99 ? '99+' : count;
  return as === 'button' ? (
    <button {...props} type="button" className={classes} data-tone={tone}>
      {label}
    </button>
  ) : (
    <span {...props} className={classes} data-tone={tone}>
      {label}
    </span>
  );
}
