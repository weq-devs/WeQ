import '../../styles/task-progress.css';

export function TaskProgressBar({
  value,
  label,
  status = 'running',
  valueText,
  className = '',
}: {
  value?: number;
  label: string;
  status?: string;
  valueText?: string;
  className?: string;
}) {
  const progress =
    value !== undefined && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
  const indeterminate = progress === undefined;
  return (
    <span
      className={`weq-task-progress-track is-${status}${indeterminate ? ' is-indeterminate' : ''} ${className}`}
    >
      <progress
        max={100}
        value={progress}
        aria-label={label}
        aria-valuetext={valueText ?? (indeterminate ? '进度未知' : undefined)}
      />
      {indeterminate ? <span className="weq-task-progress-indicator" aria-hidden /> : null}
    </span>
  );
}
