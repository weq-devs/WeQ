import type { ExportTask, FlashDownloadTask, RoamingJobStatus } from '@weq/service';
import type { CloneTask } from '../views/agentlab/cloneTaskStore';

export type AssistantActivity = 'idle' | 'running' | 'finished';

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
  exports?: Pick<ExportTask, 'status' | 'save'>[];
  clones?: Pick<CloneTask, 'status'>[];
  roaming?: { status: RoamingJobStatus }[];
  scanning?: boolean;
  flash?: Pick<FlashDownloadTask, 'status'>[];
}) {
  let running = scanning ? 1 : 0;
  let finished = 0;
  let failed = 0;
  for (const task of exports) {
    if (task.status === 'running' || task.status === 'pending' || task.save?.status === 'saving')
      running++;
    else if (
      ['completed', 'failed', 'cancelled'].includes(task.status) ||
      task.save?.status === 'failed' ||
      task.save?.status === 'interrupted'
    )
      finished++;
    if (
      task.status === 'failed' ||
      task.save?.status === 'failed' ||
      task.save?.status === 'interrupted'
    )
      failed++;
  }
  for (const task of clones) {
    if (task.status === 'running') running++;
    else finished++;
    if (task.status === 'error') failed++;
  }
  for (const task of roaming) {
    if (['running', 'pausing'].includes(task.status)) running++;
    else if (['completed', 'failed', 'cancelled'].includes(task.status)) finished++;
    if (task.status === 'failed') failed++;
  }
  for (const task of flash) {
    if (['pending', 'resolving', 'downloading'].includes(task.status)) running++;
    else finished++;
    if (task.status === 'failed') failed++;
  }
  return { running, finished, failed };
}
