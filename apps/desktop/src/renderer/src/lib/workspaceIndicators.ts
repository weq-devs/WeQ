import type { ExportTask, FlashDownloadTask, RoamingJobStatus } from '@weq/service';
import type { CloneTask } from '../views/agentlab/cloneTaskStore';
import type { BackgroundTask } from '../../../shared/background_task';
import { backgroundTaskDisplay } from '../../../shared/background_task';
import { exportTaskResult } from '../../../shared/export_task_result';
import { isRoamingJobComplete } from '../../../shared/roaming_task_status';
import { roamingTaskDisplay, taskNoticeTitle } from '@weq/service/task-display';
import { navigationBadge } from './navigationBadges';

export interface WorkspaceTaskIndicator {
  id: string;
  activity: 'idle' | 'running' | 'finished';
  result: string;
  failed: boolean;
  partial?: boolean;
  notificationSummary?: string;
  name?: string;
  notificationName?: string;
  paused?: boolean;
  waiting?: boolean;
  cancelled?: boolean;
  notificationHandled?: boolean;
  showProgressNotification?: boolean;
  showRunningBadge?: boolean;
  transfer?: boolean;
  showResultBadge?: boolean;
  /** 记录与提醒照常保留，但后台步骤不抢占当前界面。 */
  autoOpenTaskList?: boolean;
}

const QUICK_SAVE_RESOURCE_KINDS = new Set<NonNullable<ExportTask['resource']>['kind']>([
  'media',
  'market-image',
  'decoration',
  'group-albums',
  'qzone-albums',
  'group-files',
  'mail-attachment',
]);

export function workspaceIndicator(running: number, finished: number) {
  return running > 0 ? 'running' : finished > 0 ? 'finished' : null;
}

export function workspaceTaskBadge(
  running: number,
  finished: number,
  unreadFailed = 0,
  transfers = 0,
) {
  const description = [
    transfers ? `${transfers} 项传输中` : '',
    running > transfers ? `${running - transfers} 项任务进行中` : '',
    finished ? `${finished} 项任务结果未查看` : '',
    unreadFailed ? `其中 ${unreadFailed} 项任务失败` : '',
  ]
    .filter(Boolean)
    .join('，');
  return workspaceIndicator(running, finished) === 'running'
    ? navigationBadge('running', running, description)
    : navigationBadge('notice', finished, description);
}

/** 保存阶段沿用同一任务，不能同时贡献蓝点和红点。 */
export function summarizeWorkspaceTasks({
  exports = [],
  clones = [],
  roaming = [],
  scanning = false,
  flash = [],
  background = [],
}: {
  exports?: (Pick<ExportTask, 'id' | 'status' | 'save'> &
    Partial<
      Pick<
        ExportTask,
        | 'updatedAt'
        | 'resource'
        | 'display'
        | 'autoOpenTaskList'
        | 'databaseRecovery'
        | 'databaseRecoveryRecords'
      >
    >)[];
  clones?: (Pick<CloneTask, 'personaId' | 'status'> &
    Partial<Pick<CloneTask, 'name' | 'operation'>>)[];
  roaming?: {
    id: string;
    status: RoamingJobStatus;
    planning?: { startImmediately: boolean };
    updatedAt?: number;
    targets?: { name: string }[];
    options?: { targets: { name: string }[] };
  }[];
  scanning?: boolean;
  flash?: (Pick<FlashDownloadTask, 'id' | 'status'> &
    Partial<Pick<FlashDownloadTask, 'finishedAt' | 'name' | 'interrupted'>> & {
      files?: readonly unknown[];
    })[];
  background?: (Pick<BackgroundTask, 'id' | 'status' | 'updatedAt'> &
    Partial<
      Pick<
        BackgroundTask,
        | 'name'
        | 'kind'
        | 'destination'
        | 'subtasks'
        | 'display'
        | 'clonePersonaId'
        | 'automaticUpdate'
        | 'statusLabel'
        | 'outgoingTransfer'
      >
    >)[];
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
      (task.status === 'completed' && Boolean(task.databaseRecoveryRecords?.length)) ||
      task.save?.status === 'failed' ||
      task.save?.status === 'interrupted';
    items.push({
      ...exportTaskResult(task),
      name: '导出任务',
      notificationName: task.display ? taskNoticeTitle(task.display) : undefined,
      paused: task.status === 'paused',
      waiting: Boolean(task.databaseRecovery),
      cancelled: task.status === 'cancelled',
      activity: running ? 'running' : finished ? 'finished' : 'idle',
      failed,
      partial: task.status === 'completed' && Boolean(task.databaseRecoveryRecords?.length),
      autoOpenTaskList:
        task.autoOpenTaskList !== false &&
        !(task.resource?.output && QUICK_SAVE_RESOURCE_KINDS.has(task.resource.kind)),
    });
  }
  for (const task of clones) {
    if (background.some((entry) => entry.clonePersonaId === task.personaId)) continue;
    items.push({
      id: `clone:${task.personaId}`,
      name: '克隆构建',
      notificationName: task.name
        ? taskNoticeTitle({
            action: task.operation === 'update' ? '更新好友克隆' : '创建好友克隆',
            subject: task.name,
          })
        : undefined,
      activity: task.status === 'running' ? 'running' : 'finished',
      result: task.status,
      failed: task.status === 'error',
      autoOpenTaskList: false, // 创建和更新会主动打开任务列表。
    });
  }
  for (const task of roaming) {
    const targets = task.planning ? task.options?.targets : task.targets;
    items.push({
      id: `roaming:${task.id}`,
      name: '消息加载任务',
      notificationName: targets ? taskNoticeTitle(roamingTaskDisplay(targets)) : '拉取漫游消息',
      paused: task.status === 'paused',
      cancelled: task.status === 'cancelled',
      activity: ['running', 'pausing'].includes(task.status)
        ? 'running'
        : isRoamingJobComplete(task.status) ||
            task.status === 'failed' ||
            task.status === 'cancelled'
          ? 'finished'
          : 'idle',
      result: `${task.status}:${task.updatedAt ?? ''}`,
      failed: task.status === 'failed',
      autoOpenTaskList: false,
    });
  }
  if (scanning && !roaming.some((job) => job.planning))
    items.push({
      id: 'roaming:scanning',
      notificationHandled: true,
      activity: 'running',
      result: '',
      failed: false,
      autoOpenTaskList: false,
    });
  for (const task of flash) {
    items.push({
      id: `flash:${task.id}`,
      name: '闪传下载任务',
      notificationName: taskNoticeTitle({
        action: '下载闪传文件',
        subject: (task.files?.length ?? 0) > 1 ? `${task.files!.length} 个文件` : task.name,
      }),
      cancelled: task.status === 'cancelled',
      paused: task.interrupted,
      activity: task.interrupted
        ? 'idle'
        : ['pending', 'resolving', 'downloading'].includes(task.status)
          ? 'running'
          : 'finished',
      result: `${task.status}:${task.finishedAt ?? ''}`,
      failed: !task.interrupted && task.status === 'failed',
    });
  }
  for (const task of background) {
    const failedItems = task.subtasks?.reduce((total, part) => total + part.failed, 0) ?? 0;
    const failed = task.status === 'failed' || failedItems > 0;
    items.push({
      id: task.id,
      name: task.name,
      notificationName:
        task.name && task.kind
          ? taskNoticeTitle(
              backgroundTaskDisplay({
                kind: task.kind,
                name: task.name,
                destination: task.destination,
                display: task.display,
              }),
            )
          : undefined,
      notificationHandled:
        task.kind === 'forward' ||
        task.kind === 'send-media' ||
        task.destination === 'db-checkup' ||
        (!!task.automaticUpdate && ['completed', 'cancelled'].includes(task.status) && !failed),
      showRunningBadge:
        task.automaticUpdate || task.outgoingTransfer?.inConversation ? false : undefined,
      transfer: task.kind === 'send-media',
      showResultBadge: task.kind !== 'update' && (!task.automaticUpdate || failed),
      paused: task.status === 'paused',
      waiting: task.automaticUpdate && task.status === 'paused' && task.statusLabel === '等待继续',
      cancelled: task.status === 'cancelled',
      activity:
        task.status === 'running' ? 'running' : task.status === 'paused' ? 'idle' : 'finished',
      result: `${task.status}:${task.updatedAt}`,
      failed,
      partial: task.status === 'completed' && failedItems > 0,
      notificationSummary: failedItems ? `${failedItems} 项未完成` : undefined,
      autoOpenTaskList: false,
    });
  }
  return {
    running: items.filter((item) => item.activity === 'running' && item.showRunningBadge !== false)
      .length,
    finished: items.filter((item) => item.activity === 'finished' && item.showResultBadge !== false)
      .length,
    failed: items.filter((item) => item.failed && item.showResultBadge !== false).length,
    // 可从任务入口找回的进度统一留在任务中。
    items: items.map((item) => ({ ...item, showProgressNotification: false })),
  };
}
