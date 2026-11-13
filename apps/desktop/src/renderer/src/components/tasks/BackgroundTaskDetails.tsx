import {
  CalendarDays,
  BarChart3,
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
  Users,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { client, trpc } from '../../trpc/client';
import { localBackgroundTasks } from '../../state/backgroundTasks';
import { removeBackgroundTask, type BackgroundTaskEntry } from '../../hooks/useBackgroundTasks';
import type { BackgroundTaskScope } from '../../../../shared/background_task';
import { IS_WEB } from '../../lib/target';
import { useDialog } from '../Dialog';
import type { TaskLogLine } from '../TaskLogConsole';
import { CalendarTaskDetails } from '../CalendarTaskDetails';
import { ContactTaskStages } from './ContactTaskStages';
import { backgroundTaskNavigation } from './backgroundTaskNavigation';
import '../../styles/export.css';
import '../../styles/conversation-overview-calendar.css';
import '../../styles/contact-directory-order.css';

export const BACKGROUND_TASK_LABELS = {
  analysis: '分析报告',
  calendar: '会话日历',
  contacts: '好友/群信息缓存',
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
  analysis: BarChart3,
  calendar: CalendarDays,
  contacts: Users,
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
  return (
    <TaskDetails
      key={JSON.stringify([entry.source, entry.task.id, scope?.uin, scope?.configId])}
      entry={entry}
      scope={scope}
      refresh={refresh}
    />
  );
}

function TaskDetails({
  entry,
  scope,
  refresh,
}: {
  entry: BackgroundTaskEntry;
  scope: BackgroundTaskScope | null;
  refresh: () => Promise<unknown>;
}) {
  const { task } = entry;
  const navigation = backgroundTaskNavigation(task);
  const hostDetails = trpc.backgroundTasks.details.useQuery(
    { id: task.id, scope, updatedAt: task.updatedAt },
    {
      enabled: entry.source === 'host' && task.kind !== 'contacts',
      cacheTime: 0,
      keepPreviousData: true,
    },
  );
  const details = entry.source === 'host' ? hostDetails.data : task.details;
  const taskLogs = trpc.backgroundTasks.logs.useQuery(
    { id: task.id, scope, updatedAt: task.updatedAt },
    {
      enabled: entry.source === 'host' && task.kind === 'contacts',
      cacheTime: 0,
      keepPreviousData: true,
    },
  );
  const retainedLogs = useRef(taskLogs.data);
  useEffect(() => {
    if (taskLogs.data) retainedLogs.current = taskLogs.data;
  }, [taskLogs.data]);
  const contactLogs =
    (entry.source === 'host' ? (taskLogs.data ?? retainedLogs.current) : task.logs) ??
    contactLogLines(details ?? []);
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
      {task.kind === 'calendar' ? (
        <CalendarTaskDetails
          key={task.id}
          taskId={task.id}
          scope={scope}
          running={task.status === 'running'}
        />
      ) : null}
      {task.kind === 'contacts' ? (
        <ContactTaskStages
          task={task}
          logs={contactLogs}
          onShowFailures={(label, items) =>
            showError(`${label}读取失败`, items.map((item) => item.error).join('\n'))
          }
        />
      ) : null}
      {task.note &&
      (task.kind !== 'contacts' || (task.status === 'failed' && !task.subtasks?.length)) ? (
        <p role={task.status === 'failed' ? 'alert' : undefined}>{task.note}</p>
      ) : null}
      {hostDetails.error && entry.source === 'host' ? (
        <p role="alert">详情读取失败：{hostDetails.error.message}</p>
      ) : null}
      {task.kind === 'contacts' ? (
        taskLogs.error ? (
          <p role="alert">日志读取失败：{taskLogs.error.message}</p>
        ) : null
      ) : details?.length ? (
        <div>
          <ul className="weq-background-task-results">
            {[...new Set(details)].map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="weq-long-task-actions">
        {navigation ? (
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft"
            onClick={() => navigation.run()}
          >
            {navigation.icon}
            {navigation.label}
          </button>
        ) : null}
        {task.download ? (
          <a
            className="weq-set-btn weq-set-btn-soft"
            href={task.download.url}
            download={task.download.name}
          >
            <Download size={14} />
            下载到浏览器
          </a>
        ) : null}
        {task.actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className="weq-set-btn weq-set-btn-soft"
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
            className="weq-set-btn weq-set-btn-soft"
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
            className="weq-set-btn weq-set-btn-soft"
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

function contactLogLines(details: string[]): TaskLogLine[] {
  return details.flatMap((line) => {
    if (!line.startsWith('过程日志：')) return [];
    try {
      const data = JSON.parse(line.slice('过程日志：'.length));
      if (
        typeof data.ts !== 'number' ||
        typeof data.seq !== 'number' ||
        typeof data.stage !== 'string' ||
        typeof data.text !== 'string' ||
        !['info', 'warn', 'error'].includes(data.level)
      )
        return [];
      return [
        { ts: data.ts, seq: data.seq, stage: data.stage, text: data.text, level: data.level },
      ];
    } catch {
      return [];
    }
  });
}
