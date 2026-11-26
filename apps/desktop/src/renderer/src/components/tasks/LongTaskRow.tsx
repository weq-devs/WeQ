import { Ban, CircleAlert, CircleCheck, Clock, Loader2, Pause } from 'lucide-react';
import '../../styles/long-tasks.css';
import { TaskProgressBar } from './TaskProgressBar';
import { NumericText } from '../NumericText';
import { taskCreatedLabel } from '@weq/service/task-display';
import { TaskName } from './TaskName';
import { useOutgoingTaskProgress } from '../../lib/transferActivity';
import { type LongTaskItem, longTaskProgress, LABELS } from './LongTaskRow.shared';

export function LongTaskRow({
  task,
  active,
  onSelect,
  showQuickActions = false,
  pageLink = false,
}: {
  task: LongTaskItem;
  active: boolean;
  onSelect: () => void;
  showQuickActions?: boolean;
  pageLink?: boolean;
}) {
  const Icon = {
    pending: Clock,
    running: Loader2,
    paused: Pause,
    completed: CircleCheck,
    failed: CircleAlert,
    cancelled: Ban,
  }[task.status];
  const showProgress = !pageLink || task.status === 'running';
  const outgoing = useOutgoingTaskProgress(task);
  const progress = showProgress ? longTaskProgress(outgoing?.percent ?? task.progress) : undefined;
  const row = (
    <button
      type="button"
      className={`weq-long-task is-${task.status}${active ? ' is-selected' : ''}`}
      aria-expanded={pageLink ? undefined : active}
      onClick={onSelect}
    >
      <span className="weq-long-task-icon" aria-hidden>
        {task.icon}
      </span>
      <span className="weq-long-task-main">
        <span className="weq-long-task-name">
          {task.display ? <TaskName display={task.display} /> : task.name}
        </span>
        <span className="weq-long-task-meta">
          <NumericText>
            {[
              task.kind,
              task.note,
              outgoing?.counts,
              !pageLink && task.createdAt ? taskCreatedLabel(task.createdAt) : undefined,
            ]
              .filter(Boolean)
              .join(' · ')}
          </NumericText>
        </span>
        {showProgress ? (
          <TaskProgressBar value={progress} label={`${task.name}进度`} status={task.status} />
        ) : null}
        {!pageLink && task.metrics ? (
          <span className="weq-long-task-metrics">
            <NumericText>{task.metrics}</NumericText>
          </span>
        ) : null}
      </span>
      <span className="weq-long-task-state">
        <span>
          <Icon size={14} aria-hidden />
          {outgoing?.label ?? task.statusLabel ?? LABELS[task.status]}
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
