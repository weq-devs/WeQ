import { z } from 'zod/v3';
import type { BackgroundTask } from '../shared/background_task';

/** 只保存可重建的任务状态，下载控制和文件校验仍由业务负责。 */
export const downloadTaskReceipt = z.object({
  id: z.string().uuid(),
  startedAt: z.number(),
  updatedAt: z.number(),
  status: z.enum(['running', 'paused', 'completed', 'failed', 'cancelled']),
  statusLabel: z.string().optional(),
  progress: z.number().optional(),
  note: z.string().optional(),
  foreground: z.boolean().optional(),
});

export function isPendingDownload(status: BackgroundTask['status']) {
  return status === 'running' || status === 'paused';
}

export function downloadTaskSnapshot(task: BackgroundTask): z.infer<typeof downloadTaskReceipt> {
  const { id, startedAt, updatedAt, status, statusLabel, progress, note, foreground } = task;
  return { id, startedAt, updatedAt, status, statusLabel, progress, note, foreground };
}
