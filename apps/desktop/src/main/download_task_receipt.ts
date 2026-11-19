import { z } from 'zod';
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
});

export function downloadTaskSnapshot(task: BackgroundTask): z.infer<typeof downloadTaskReceipt> {
  const { id, startedAt, updatedAt, status, statusLabel, progress, note } = task;
  return { id, startedAt, updatedAt, status, statusLabel, progress, note };
}
