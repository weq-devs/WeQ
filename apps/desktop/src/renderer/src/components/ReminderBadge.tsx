import type { HTMLAttributes } from 'react';
import '../styles/reminder-badge.css';

type ReminderTone = 'notice' | 'muted' | 'running';

function reminderClass(kind: 'dot' | 'count', overlay: boolean, className?: string) {
  return `weq-reminder weq-reminder-${kind}${overlay ? ' weq-reminder-overlay' : ''}${className ? ` ${className}` : ''}`;
}

export function ReminderDot({
  overlay = false,
  className,
  ...props
}: Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & { overlay?: boolean }) {
  return <span {...props} className={reminderClass('dot', overlay, className)} />;
}

export function ReminderCount({
  count,
  tone = 'notice',
  overlay = false,
  as = 'span',
  className,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'children'> & {
  count: number;
  tone?: ReminderTone;
  overlay?: boolean;
  as?: 'span' | 'button';
}) {
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
