import { BackgroundTaskRegistry, type BackgroundTask } from '../../../shared/background_task';
import { client } from '../trpc/client';

/** 逐条转发、浏览器分片上传等显式后台操作的生命周期由当前窗口负责。 */
export const localBackgroundTasks = new BackgroundTaskRegistry();

const receiptPrefix = 'weq-window-task-v1:';
type UploadReceipt = { submitted: boolean; groupCode: string; albumId: string; videoId?: string };
type Saved = { task: BackgroundTask; upload?: UploadReceipt };

/** 仅保存回执，不保存发送内容、文件、上传票据或可重放的回调。 */
export function rememberWindowTask(id: string, upload?: UploadReceipt) {
  try {
    const task = localBackgroundTasks.snapshot().find((item) => item.id === id);
    if (!task?.scope?.configId || (task.kind !== 'forward' && task.kind !== 'album-upload')) return;
    const value: Saved = {
      task: { ...task, actions: [], logs: undefined, details: task.details?.slice(0, 2000) },
      upload,
    };
    localStorage.setItem(`${receiptPrefix}${id}`, JSON.stringify(value));
  } catch {
    /* 禁止存储或配额不足时保留本窗口进度。 */
  }
}

export function forgetWindowTask(id: string) {
  try {
    localStorage.removeItem(`${receiptPrefix}${id}`);
  } catch {
    /* 存储不可用。 */
  }
}

export function restoreWindowTaskReceipts(
  storage: Pick<Storage, 'getItem' | 'key' | 'length' | 'removeItem'>,
) {
  const saved: Saved[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(receiptPrefix)) continue;
    try {
      const value = JSON.parse(storage.getItem(key) ?? 'null') as Saved | null;
      const task = value?.task;
      if (
        value &&
        task?.id === key.slice(receiptPrefix.length) &&
        task.scope?.configId &&
        (task.kind === 'forward' || task.kind === 'album-upload') &&
        ['running', 'paused', 'completed', 'failed', 'cancelled'].includes(task.status)
      )
        saved.push(value);
    } catch {
      /* 单条旧回执损坏不会阻塞其余任务。 */
    }
  }
  const ended = saved
    .filter(({ task }) => task.status !== 'paused' && task.status !== 'running')
    .sort((a, b) => b.task.updatedAt - a.task.updatedAt);
  for (const { task } of ended.slice(60)) storage.removeItem(`${receiptPrefix}${task.id}`);
  const keep = new Set(ended.slice(0, 60).map(({ task }) => task.id));
  for (const { task, upload } of saved) {
    const interrupted = task.status === 'running';
    if (!interrupted && task.status !== 'paused' && !keep.has(task.id)) continue;
    if (localBackgroundTasks.snapshot().some((entry) => entry.id === task.id)) continue;
    const unknown = interrupted && !(task.kind === 'album-upload' && upload && !upload.submitted);
    const actions =
      upload?.videoId && (unknown || task.status === 'paused')
        ? [
            {
              id: 'verify',
              label: '核对上传结果',
              run: async () => {
                const scope = task.scope!;
                const current = async () => {
                  const account = await client.account.getAccountConfig.query();
                  if (account?.uin !== scope.uin || account.configId !== scope.configId)
                    throw new Error('请回到原账号和数据源核对');
                };
                await current();
                const rows = await client.account.listGroupAlbumMedia.query({
                  groupCode: upload.groupCode,
                  albumId: upload.albumId,
                  expectedAccountUin: scope.uin,
                  expectedAccountConfigId: scope.configId,
                });
                await current();
                if (
                  !rows.some(
                    (row) => row.video?.id === upload.videoId && row.uploader === scope.uin,
                  )
                )
                  throw new Error('暂未在该相册读到原视频，仍需核对，请勿重复上传');
                localBackgroundTasks.resume(task.id);
                localBackgroundTasks.finish(task.id, 'completed', {
                  note: '视频已发布到群相册并读回确认',
                });
                localBackgroundTasks.setActions(task.id, []);
                rememberWindowTask(task.id, upload);
              },
            },
          ]
        : [];
    localBackgroundTasks.project(
      {
        ...task,
        status: interrupted ? (unknown ? 'paused' : 'cancelled') : task.status,
        statusLabel: unknown ? '结果待核对' : interrupted ? '已中断，尚未提交' : task.statusLabel,
        note: unknown
          ? `上次窗口已中断，可能已提交的操作请核对；不会自动再次执行。${task.note ? ` ${task.note}` : ''}`
          : interrupted
            ? '未提交给 QQ；可重新选择视频。'
            : task.note,
        actions: [],
      },
      actions,
    );
  }
}

try {
  restoreWindowTaskReceipts(localStorage);
} catch {
  /* 无可用窗口存储。 */
}
