import type { ReactNode } from 'react';
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
  display?: import('@weq/service/task-display').TaskDisplay;
  createdAt?: number;
  kind: string;
  status: LongTaskStatus;
  statusLabel?: string;
  progress?: number;
  note?: string;
  metrics?: string;
  icon: ReactNode;
  detail: ReactNode;
  quickActions?: ReactNode;
}

export const LABELS: Record<LongTaskStatus, string> = {
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

export const longTaskStatusLabel = (status: LongTaskStatus) => LABELS[status];
export const longTaskProgress = (progress?: number) =>
  progress !== undefined && Number.isFinite(progress)
    ? Math.max(0, Math.min(100, Math.round(progress)))
    : undefined;

export function orderLongTasks(items: LongTaskItem[]): LongTaskItem[] {
  return [...items].sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status]);
}
