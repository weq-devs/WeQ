import {
  ArchiveRestore,
  Database,
  Download,
  FolderOpen,
  Forward,
  HardDrive,
  RotateCw,
  SmilePlus,
  Square,
  Trash2,
  Upload,
} from 'lucide-react';
import { useState } from 'react';
import { client, trpc } from '../../trpc/client';
import { localBackgroundTasks } from '../../state/backgroundTasks';
import { removeBackgroundTask, type BackgroundTaskEntry } from '../../hooks/useBackgroundTasks';
import type { BackgroundTaskScope } from '../../../../shared/background_task';
import { IS_WEB } from '../../lib/target';
import { useDialog } from '../Dialog';

export const BACKGROUND_TASK_LABELS = {
  model: '模型下载',
  update: '软件更新',
  database: '数据库维护',
  backup: '备份与恢复',
  'favorite-import': '收藏表情导入',
  forward: '逐条转发',
  'album-upload': '群相册上传',
  resource: '资源管理',
};

export const BACKGROUND_TASK_ICONS = {
  model: Download,
  update: RotateCw,
  database: Database,
  backup: ArchiveRestore,
  'favorite-import': SmilePlus,
  forward: Forward,
  'album-upload': Upload,
  resource: HardDrive,
};

export function BackgroundTaskDetails({
  entry,
  scope,
  refresh,
}: {
  entry: BackgroundTaskEntry;
  scope: BackgroundTaskScope | null;
  refresh: () => Promise<unknown>;
}) {
  const { task } = entry;
  const hostDetails = trpc.backgroundTasks.details.useQuery(
    { id: task.id, scope, updatedAt: task.updatedAt },
    {
      enabled: entry.source === 'host',
      cacheTime: 0,
    },
  );
  const details = entry.source === 'host' ? hostDetails.data : task.details;
  const [busy, setBusy] = useState(false);
  const showError = useDialog((state) => state.showError);
  const act = async (run: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await run();
      await refresh();
    } catch (error) {
      showError('任务操作失败', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      {task.note ? <p role={task.status === 'failed' ? 'alert' : undefined}>{task.note}</p> : null}
      {hostDetails.error && entry.source === 'host' ? (
        <p role="alert">详情读取失败：{hostDetails.error.message}</p>
      ) : null}
      {details?.length ? (
        <ul className="weq-background-task-results">
          {[...new Set(details)].map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      <div className="weq-long-task-actions">
        {task.download ? (
          <a className="weq-set-btn" href={task.download.url} download={task.download.name}>
            <Download size={14} />
            下载到浏览器
          </a>
        ) : null}
        {task.actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className="weq-set-btn"
            disabled={busy}
            onClick={() =>
              void act(() =>
                entry.source === 'window'
                  ? localBackgroundTasks.act(task.id, action.id)
                  : client.backgroundTasks.act.mutate({ id: task.id, action: action.id, scope }),
              )
            }
          >
            {action.id === 'stop' ? (
              <Square size={14} />
            ) : action.id === 'download' ? (
              <Download size={14} />
            ) : (
              <FolderOpen size={14} />
            )}
            {action.label}
          </button>
        ))}
        {task.kind === 'update' && task.status === 'completed' && !IS_WEB ? (
          <button
            type="button"
            className="weq-set-btn"
            disabled={busy}
            onClick={() => void act(() => client.update.install.mutate())}
          >
            <RotateCw size={14} />
            重启并安装
          </button>
        ) : null}
        {task.status !== 'running' ? (
          <button
            type="button"
            className="weq-set-btn"
            disabled={busy}
            onClick={() => void act(() => removeBackgroundTask(entry, scope))}
          >
            <Trash2 size={14} />
            移除任务
          </button>
        ) : null}
      </div>
    </div>
  );
}
