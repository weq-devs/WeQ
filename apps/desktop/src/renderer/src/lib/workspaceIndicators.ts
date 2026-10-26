import type { ExportTask, FlashDownloadTask, RoamingJobStatus } from '@weq/service';
import type { CloneTask } from '../views/agentlab/cloneTaskStore';

export type AssistantActivity = 'idle' | 'running' | 'finished';
export interface WorkspaceTaskIndicator {
  id: string;
  activity: AssistantActivity;
  result: string;
  failed: boolean;
}

export function workspaceIndicator(running: number, finished: number) {
  return running > 0 ? 'running' : finished > 0 ? 'finished' : null;
}

/** 保存阶段沿用同一任务，不能同时贡献蓝点和红点。 */
export function summarizeWorkspaceTasks({
  exports = [],
  clones = [],
  roaming = [],
  scanning = false,
  flash = [],
}: {
  exports?: (Pick<ExportTask, 'id' | 'status' | 'save'> & Partial<Pick<ExportTask, 'updatedAt'>>)[];
  clones?: Pick<CloneTask, 'personaId' | 'status'>[];
  roaming?: { id: string; status: RoamingJobStatus; updatedAt?: number }[];
  scanning?: boolean;
  flash?: (Pick<FlashDownloadTask, 'id' | 'status'> &
    Partial<Pick<FlashDownloadTask, 'finishedAt'>>)[];
}) {
  const items: WorkspaceTaskIndicator[] = [];
  for (const task of exports) {
    const running =
      task.status === 'running' || task.status === 'pending' || task.save?.status === 'saving';
    const finished =
      ['completed', 'failed', 'cancelled'].includes(task.status) ||
      task.save?.status === 'failed' ||
      task.save?.status === 'interrupted';
    const failed =
      task.status === 'failed' ||
      task.save?.status === 'failed' ||
      task.save?.status === 'interrupted';
    items.push({
      id: `export:${task.id}`,
      activity: running ? 'running' : finished ? 'finished' : 'idle',
      result: `${task.status}:${task.save?.status ?? ''}:${task.updatedAt ?? ''}`,
      failed,
    });
  }
  for (const task of clones) {
    items.push({
      id: `clone:${task.personaId}`,
      activity: task.status === 'running' ? 'running' : 'finished',
      result: task.status,
      failed: task.status === 'error',
    });
  }
  for (const task of roaming) {
    items.push({
      id: `roaming:${task.id}`,
      activity: ['running', 'pausing'].includes(task.status)
        ? 'running'
        : ['completed', 'failed', 'cancelled'].includes(task.status)
          ? 'finished'
          : 'idle',
      result: `${task.status}:${task.updatedAt ?? ''}`,
      failed: task.status === 'failed',
    });
  }
  if (scanning)
    items.push({ id: 'roaming:scanning', activity: 'running', result: '', failed: false });
  for (const task of flash) {
    items.push({
      id: `flash:${task.id}`,
      activity: ['pending', 'resolving', 'downloading'].includes(task.status)
        ? 'running'
        : 'finished',
      result: `${task.status}:${task.finishedAt ?? ''}`,
      failed: task.status === 'failed',
    });
  }
  return {
    running: items.filter((item) => item.activity === 'running').length,
    finished: items.filter((item) => item.activity === 'finished').length,
    failed: items.filter((item) => item.failed).length,
    items,
  };
}
