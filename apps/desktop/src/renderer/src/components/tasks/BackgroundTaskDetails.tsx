import {
  Download,
  FolderOpen,
  Pause,
  Play,
  RotateCw,
  RefreshCw,
  Square,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ContactMetricsLaneKey } from '@weq/service';
import { client, trpc } from '../../trpc/client';
import { localBackgroundTasks } from '../../state/backgroundTasks';
import { removeBackgroundTask, type BackgroundTaskEntry } from '../../hooks/useBackgroundTasks';
import type { BackgroundTaskScope } from '../../../../shared/background_task';
import { backgroundTaskDisplay } from '../../../../shared/background_task';
import { IS_WEB } from '../../lib/target.shared';
import { useDialog } from '../Dialog.shared';
import type { TaskLogLine } from '../TaskLogConsole';
import { CalendarTaskDetails } from '../CalendarTaskDetails';
import { ContactTaskStages } from './ContactTaskStages';
import { backgroundTaskNavigation } from './backgroundTaskNavigation';
import { TaskActivityLog } from './TaskActivityLog';
import { TaskProgressDetails } from './TaskProgressDetails';
import { DatabaseMaintenanceProgress } from '../DatabaseMaintenanceProgress';
import { usePageDataCache } from '../PageSnapshots.shared';
import '../../styles/export.css';
import '../../styles/conversation-overview-calendar.css';
import '../../styles/contact-directory-order.css';
import '../../styles/long-tasks.css';

export function BackgroundTaskActionIcon({ id }: { id: string }) {
  const Icon =
    id === 'stop' || id === 'cancel'
      ? Square
      : id === 'pause'
        ? Pause
        : id === 'resume' || id === 'continue'
          ? Play
          : id === 'retry'
            ? RefreshCw
            : id === 'download'
              ? Download
              : id === 'install'
                ? RotateCw
                : FolderOpen;
  return <Icon size={14} aria-hidden />;
}

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
  const canManageTask = !IS_WEB || task.kind !== 'update';
  const cache = usePageDataCache();
  const cacheKey = JSON.stringify(['background-task', task.id, scope]);
  const maintenance = trpc.dbRepair.maintenance.useQuery(
    { uin: task.scope?.uin ?? '', configId: task.scope?.configId },
    { enabled: task.destination === 'db-checkup' && !!task.scope?.uin, refetchInterval: 2000 },
  );
  const navigation = backgroundTaskNavigation(task);
  const hostDetails = trpc.backgroundTasks.details.useQuery(
    { id: task.id, scope, updatedAt: task.updatedAt },
    {
      enabled: entry.source === 'host' && task.kind !== 'contacts',
      cacheTime: 0,
      staleTime: 0,
      refetchOnMount: 'always',
      keepPreviousData: true,
      placeholderData: () => cache.read<string[]>(`${cacheKey}:details`),
      onSuccess: (data) => cache.write(`${cacheKey}:details`, data),
    },
  );
  const details = entry.source === 'host' ? hostDetails.data : task.details;
  const taskLogs = trpc.backgroundTasks.logs.useQuery(
    { id: task.id, scope, updatedAt: task.updatedAt },
    {
      enabled: entry.source === 'host' && task.kind !== 'calendar' && !task.databaseProgress,
      cacheTime: 0,
      staleTime: 0,
      refetchOnMount: 'always',
      keepPreviousData: true,
      placeholderData: () => cache.read<TaskLogLine[]>(`${cacheKey}:logs`),
      onSuccess: (data) => cache.write(`${cacheKey}:logs`, data),
    },
  );
  const retainedLogs = useRef(taskLogs.data);
  useEffect(() => {
    if (taskLogs.data) retainedLogs.current = taskLogs.data;
  }, [taskLogs.data]);
  const logs =
    (entry.source === 'host' ? (taskLogs.data ?? retainedLogs.current) : task.logs) ??
    contactLogLines(details ?? []);
  const [busy, setBusy] = useState(false);
  const showError = useDialog((state) => state.showError);
  const failureRequest = useRef(0);
  useEffect(() => {
    return () => {
      failureRequest.current++;
    };
  }, []);
  const showContactFailures = async (lane: ContactMetricsLaneKey, label: string) => {
    const request = ++failureRequest.current;
    try {
      const failures =
        entry.source === 'host'
          ? await client.backgroundTasks.contactFailures.query({ id: task.id, scope, lane })
          : (task.contactFailures?.filter((item) => item.lane === lane) ?? []);
      if (request !== failureRequest.current) return;
      showError(
        `${label}更新失败项`,
        failures.map((item) => `${item.label}：${item.error}`).join('\n') ||
          '这次任务没有保留失败明细。',
      );
    } catch (error) {
      if (request !== failureRequest.current) return;
      showError('无法读取失败明细', error instanceof Error ? error.message : String(error));
    }
  };
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
    <div className="weq-background-task-details">
      {task.databaseProgress ? (
        <DatabaseMaintenanceProgress
          progress={task.databaseProgress}
          batch={
            task.databaseBatch
              ? {
                  ...task.databaseBatch,
                  locked: maintenance.data?.state === 'waiting' && maintenance.data.locked,
                }
              : undefined
          }
          compact
        />
      ) : (
        <TaskProgressDetails
          name={task.name}
          display={backgroundTaskDisplay(task)}
          status={task.status}
          statusLabel={task.statusLabel}
          progress={task.progress}
          note={task.kind === 'contacts' && task.subtasks?.length ? undefined : task.note}
          startedAt={task.startedAt}
          finishedAt={task.finishedAt}
        />
      )}
      {task.databaseProgress && task.status !== 'running' && task.note ? <p>{task.note}</p> : null}
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
          logs={logs}
          onShowFailures={(lane, label) => void showContactFailures(lane, label)}
        />
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
      {!task.databaseProgress &&
      task.kind !== 'calendar' &&
      (task.kind !== 'contacts' || !task.subtasks?.length) ? (
        <TaskActivityLog
          lines={logs}
          loading={entry.source === 'host' && taskLogs.isLoading}
          error={taskLogs.error?.message}
        />
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
        {canManageTask &&
          task.actions.map((action) => (
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
              <BackgroundTaskActionIcon id={action.id} />
              {action.label}
            </button>
          ))}
        {canManageTask && task.status !== 'running' ? (
          <button
            data-danger="outline"
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
