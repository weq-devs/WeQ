import { Ban, CircleAlert, CircleCheck, Clock, Loader2, Pause } from 'lucide-react';
import '../../styles/long-tasks.css';
import { TaskProgressBar } from './TaskProgressBar';
import { NumericText } from '../NumericText';
import { type LongTaskItem, longTaskProgress, LABELS } from './LongTaskRow.shared';

export function LongTaskRow({
  task,
  active,
  onSelect,
  showQuickActions = false,
}: {
  task: LongTaskItem;
  active: boolean;
  onSelect: () => void;
  showQuickActions?: boolean;
}) {
  const Icon = {
    pending: Clock,
    running: Loader2,
    paused: Pause,
    completed: CircleCheck,
    failed: CircleAlert,
    cancelled: Ban,
  }[task.status];
  const progress = longTaskProgress(task.progress);
  const row = (
    <button
      type="button"
      className={`weq-long-task is-${task.status}${active ? ' is-selected' : ''}`}
      aria-expanded={active}
      onClick={onSelect}
    >
      <span className="weq-long-task-icon" aria-hidden>
        {task.icon}
      </span>
      <span className="weq-long-task-main">
        <span className="weq-long-task-name">{task.name}</span>
        <span className="weq-long-task-meta">
          {task.kind}
          {task.note ? (
            <>
              {' '}
              · <NumericText>{task.note}</NumericText>
            </>
          ) : (
            ''
          )}
        </span>
        <TaskProgressBar value={progress} label={`${task.name}进度`} status={task.status} />
      </span>
      <span className="weq-long-task-state">
        <span>
          <Icon size={14} aria-hidden />
          {task.statusLabel ?? LABELS[task.status]}
        </span>
        {progress !== undefined ? (
          <small>
            <span className="weq-number weq-number-inherit">{progress}</span>%
          </small>
        ) : null}
      </span>
    </button>
  );
  return showQuickActions && task.quickActions ? (
    <div
      className={`weq-long-task-entry${active ? ' is-selected' : ''}`}
      role="group"
      aria-label={task.name}
    >
      {row}
      {task.quickActions}
    </div>
  ) : (
    row
  );
}
export type { LongTaskStatus, LongTaskItem } from './LongTaskRow.shared';
