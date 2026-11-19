import type { AccountServices } from '../../context/app_context';
import { isRoamingJobComplete } from '../../../shared/roaming_task_status';

export interface FinishedTaskSelection {
  exports: string[];
  roaming: string[];
  flash: string[];
}

/** 已结束且不会自行继续的状态；等待、运行、暂停（可续传）都保留。 */
const FINISHED_EXPORT_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** 只处理确认时的 ID；再次核对状态，不扩展到后来结束的任务。 */
export async function clearFinishedTasks(
  services: Pick<AccountServices, 'exportManager' | 'roamingBackfill' | 'flashTransferFiles'>,
  selection: FinishedTaskSelection,
) {
  let removed = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const id of new Set(selection.exports)) {
    try {
      const task = services.exportManager.getTask(id);
      if (
        task &&
        FINISHED_EXPORT_STATUSES.has(task.status) &&
        task.save?.status !== 'saving' &&
        services.exportManager.deleteTask(id)
      )
        removed += 1;
      else skipped += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const id of new Set(selection.roaming)) {
    try {
      const job = services.roamingBackfill.list().find((job) => job.id === id);
      if (
        job &&
        (isRoamingJobComplete(job.status) || job.status === 'failed' || job.status === 'cancelled')
      ) {
        services.roamingBackfill.remove(id);
        removed += 1;
      } else skipped += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    const count = await services.flashTransferFiles.downloads.clearFinishedSelection(
      selection.flash,
    );
    removed += count;
    skipped += new Set(selection.flash).size - count;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { removed, skipped, errors };
}
