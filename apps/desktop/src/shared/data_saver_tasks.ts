import type { ExportTask, FlashDownloadTask, RoamingJobStatus } from '@weq/service';
import type { BackgroundTask } from './background_task';

/** 与当前任务列表的终态一致；暂停、排队及完成后的保存仍需等待。 */
export function unfinishedDataSaverTasks(input: {
  exports?: (Pick<ExportTask, 'status' | 'save'> & { isFinalizing?: boolean })[];
  roaming?: { status: RoamingJobStatus }[];
  scanning?: boolean;
  flash?: Pick<FlashDownloadTask, 'status'>[];
  background?: Pick<BackgroundTask, 'status'>[];
}) {
  const ended = new Set(['completed', 'failed', 'cancelled']);
  return (
    (input.exports ?? []).filter(
      (task) =>
        !ended.has(task.status) ||
        task.isFinalizing ||
        ['pending', 'saving'].includes(task.save?.status ?? ''),
    ).length +
    (input.roaming ?? []).filter((task) => !ended.has(task.status)).length +
    Number(Boolean(input.scanning)) +
    (input.flash ?? []).filter((task) => task.status !== 'done' && !ended.has(task.status)).length +
    (input.background ?? []).filter((task) => !ended.has(task.status)).length
  );
}
