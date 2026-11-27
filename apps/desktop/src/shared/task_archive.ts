import type { ExportTask, FlashDownloadBatch, RoamingJobStatus } from '@weq/service';
import type { BackgroundTask } from './background_task';

export interface TaskArchiveEntry {
  result: string;
  archivedAt?: number;
  seen?: boolean;
  /** 恢复后的本次结果由用户决定何时再次归档。 */
  restored?: boolean;
  delivered?: boolean;
  verified?: boolean;
  deleted?: boolean;
  snapshot?: BackgroundTask;
}

export type TaskArchive = Record<string, TaskArchiveEntry>;
export type TaskArchivePatch = Record<string, TaskArchiveEntry | null>;
export type TaskArchiveVersion = { generation: string; revision: number };
export type TaskArchiveChange = TaskArchiveVersion & { patch?: TaskArchivePatch };
export type TaskArchiveSummaries = TaskArchiveVersion & { entries: TaskArchive };

export function isTaskArchived(entry: TaskArchiveEntry | undefined, result: string) {
  return entry?.result === result && entry.archivedAt !== undefined;
}

export function exportArchivePolicy(
  task: Pick<ExportTask, 'status' | 'save' | 'databaseRecovery'> &
    Partial<Pick<ExportTask, 'resource' | 'databaseRecoveryRecords'>> & {
      isFinalizing?: boolean;
      generatedResources?: { missing: number };
      generatedResourceReport?: ExportTask['generatedResourceReport'];
    },
) {
  const saved = task.save?.status === 'saved';
  const complete = task.status === 'completed';
  const manual =
    task.status !== 'pending' &&
    task.status !== 'running' &&
    task.save?.status !== 'saving' &&
    !task.isFinalizing;
  const light =
    task.resource?.kind === 'media' ||
    task.resource?.kind === 'market-image' ||
    task.resource?.kind === 'decoration' ||
    task.resource?.kind === 'mail-attachment';
  return {
    manual,
    auto:
      manual &&
      complete &&
      saved &&
      light &&
      !task.databaseRecovery &&
      !task.databaseRecoveryRecords?.length &&
      !(
        task.generatedResources?.missing ||
        task.resource?.failed ||
        task.generatedResourceReport?.entries.some(
          (entry) => entry.status === 'missing' || entry.offline?.complete === false,
        )
      ),
    // 浏览器产物先交给浏览器，此后由用户确认是否归档。
    canConfirmDelivery:
      complete &&
      !saved &&
      !task.databaseRecovery &&
      (!task.save || task.save.status === 'pending'),
  };
}

export function flashArchivePolicy(
  task: Pick<FlashDownloadBatch, 'interrupted' | 'status' | 'files' | 'resolutionErrors'>,
) {
  return {
    manual: ['done', 'failed', 'cancelled'].includes(task.status),
    auto:
      !task.interrupted &&
      task.status === 'done' &&
      task.files.length === 1 &&
      task.files[0]?.status === 'done' &&
      !task.resolutionErrors?.length,
  };
}

export function roamingArchivePolicy(status: RoamingJobStatus) {
  return status !== 'running' && status !== 'pausing';
}

export function backgroundArchivePolicy(
  task: Pick<BackgroundTask, 'status' | 'kind' | 'reportId' | 'subtasks' | 'needsConfirmation'>,
) {
  return {
    manual: task.status !== 'running',
    auto:
      !task.needsConfirmation &&
      task.status === 'completed' &&
      (task.kind === 'forward' ||
        task.kind === 'qzone-share' ||
        (task.kind === 'analysis' && Boolean(task.reportId))) &&
      !task.subtasks?.some((part) => part.failed),
  };
}

export function backgroundResumeAction(task: Pick<BackgroundTask, 'status' | 'actions'>) {
  return task.status === 'paused'
    ? task.actions.find((action) => action.id === 'resume' || action.id === 'continue')
    : undefined;
}

export function backgroundResult(task: Pick<BackgroundTask, 'status' | 'updatedAt'>) {
  return `${task.status}:${task.updatedAt}`;
}

export function flashResult(task: Pick<FlashDownloadBatch, 'status' | 'finishedAt'>) {
  return `${task.status}:${task.finishedAt ?? ''}`;
}

export function roamingResult(task: { status: RoamingJobStatus; updatedAt?: number }) {
  return `${task.status}:${task.updatedAt ?? ''}`;
}
