import type { ReactNode } from 'react';
import { Ban, CircleAlert, CircleCheck, Clock, Loader2, Pause } from 'lucide-react';
import '../../styles/long-tasks.css';

export type LongTaskStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface LongTaskItem {
  id: string;
  name: string;
  kind: string;
  status: LongTaskStatus;
  statusLabel?: string;
  progress?: number;
  note?: string;
  icon: ReactNode;
  detail: ReactNode;
}

const LABELS: Record<LongTaskStatus, string> = {
  pending: '待开始',
  running: '进行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
const PRIORITY: Record<LongTaskStatus, number> = {
  running: 0,
  pending: 1,
  paused: 2,
  failed: 3,
  completed: 4,
  cancelled: 5,
};

export function orderLongTasks(items: LongTaskItem[]): LongTaskItem[] {
  return [...items].sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status]);
}

export function LongTaskRow({
  task,
  active,
  onSelect,
}: {
  task: LongTaskItem;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = {
    pending: Clock,
    running: Loader2,
    paused: Pause,
    completed: CircleCheck,
    failed: CircleAlert,
    cancelled: Ban,
  }[task.status];
  const progress =
    task.progress !== undefined && Number.isFinite(task.progress)
      ? Math.max(0, Math.min(100, Math.round(task.progress)))
      : undefined;
  return (
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
          {task.note ? ` · ${task.note}` : ''}
        </span>
        {task.status === 'running' || task.status === 'paused' ? (
          <progress max={100} value={progress} aria-label={`${task.name}进度`} />
        ) : null}
      </span>
      <span className="weq-long-task-state">
        <span>
          <Icon size={14} aria-hidden />
          {task.statusLabel ?? LABELS[task.status]}
        </span>
        {progress !== undefined ? <small>{progress}%</small> : null}
      </span>
    </button>
  );
}
