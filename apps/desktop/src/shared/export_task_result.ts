import type { ExportTask } from '@weq/service';

export function exportTaskResult(
  task: Pick<ExportTask, 'id' | 'status' | 'save'> & Partial<Pick<ExportTask, 'updatedAt'>>,
) {
  return {
    id: `export:${task.id}`,
    result: `${task.status}:${task.save?.status ?? ''}:${task.updatedAt ?? ''}`,
  };
}
