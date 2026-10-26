import type { AccountServices } from '../../context/app_context';

export interface CompletedTaskSelection {
  exports: string[];
  roaming: string[];
  flash: string[];
}

/** 只处理确认时的 ID；再次核对状态，不扩展到后来完成的任务。 */
export async function clearCompletedTasks(
  services: Pick<AccountServices, 'exportManager' | 'roamingBackfill' | 'flashTransferFiles'>,
  selection: CompletedTaskSelection,
) {
  let removed = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const id of new Set(selection.exports)) {
    try {
      const task = services.exportManager.getTask(id);
      if (
        task?.status === 'completed' &&
        task.save?.status !== 'saving' &&
        task.save?.status !== 'failed' &&
        task.save?.status !== 'interrupted' &&
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
      if (
        services.roamingBackfill.list().some((job) => job.id === id && job.status === 'completed')
      ) {
        services.roamingBackfill.remove(id);
        removed += 1;
      } else skipped += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    const count = await services.flashTransferFiles.downloads.clearCompleted(selection.flash);
    removed += count;
    skipped += new Set(selection.flash).size - count;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { removed, skipped, errors };
}
