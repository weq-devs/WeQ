import {
  CalendarDays,
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
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useState } from 'react';
import { client, trpc } from '../../trpc/client';
import { localBackgroundTasks } from '../../state/backgroundTasks';
import { removeBackgroundTask, type BackgroundTaskEntry } from '../../hooks/useBackgroundTasks';
import type { BackgroundTaskScope } from '../../../../shared/background_task';
import { IS_WEB } from '../../lib/target';
import { useDialog } from '../Dialog';
import type { UiLogLine } from '../../views/export/TaskList';
import { TaskLogConsole as LogConsole } from '../TaskLogConsole';
import { CalendarTaskDetails } from '../CalendarTaskDetails';
import { ContactTaskStages } from './ContactTaskStages';
import '../../styles/export.css';
import '../../styles/conversation-overview-calendar.css';
import '../../styles/contact-directory-order.css';

export const BACKGROUND_TASK_LABELS = {
  calendar: '会话日历',
  contacts: '联系人缓存',
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
  const { task } = entry;
  const hostDetails = trpc.backgroundTasks.details.useQuery(
    { id: task.id, scope, updatedAt: task.updatedAt },
    {
      enabled: entry.source === 'host',
      cacheTime: 0,
    },
  );
  const details = entry.source === 'host' ? hostDetails.data : task.details;
  const taskLogs = trpc.backgroundTasks.logs.useQuery(
    { id: task.id, scope, updatedAt: task.updatedAt },
    {
      enabled: entry.source === 'host' && task.kind === 'contacts',
      cacheTime: 0,
    },
  );
  const contactLogs =
    (entry.source === 'host' ? taskLogs.data : task.logs) ?? contactLogLines(details ?? []);
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
      {task.note ? <p role={task.status === 'failed' ? 'alert' : undefined}>{task.note}</p> : null}
      {hostDetails.error && entry.source === 'host' ? (
        <p role="alert">详情读取失败：{hostDetails.error.message}</p>
      ) : null}
      {task.kind === 'contacts' ? (
        <ContactTaskLog details={details ?? []} records={contactLogs} />
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

function ContactTaskLog({ details, records }: { details: string[]; records: UiLogLine[] }) {
  const [page, setPage] = useState(0);
  const results: Array<{ key: string; name: string; content: string }> = [];
  const logs: string[] = [];
  for (const line of details) {
    if (line.startsWith('过程日志：')) continue;
    const prefix = line.startsWith('好友获取结果：')
      ? '好友获取结果：'
      : line.startsWith('群聊获取结果：')
        ? '群聊获取结果：'
        : null;
    if (!prefix) {
      logs.push(line);
      continue;
    }
    try {
      const value = JSON.parse(line.slice(prefix.length));
      const id = String(value.QQ号 ?? value.群号);
      results.push({
        key: `${prefix}${id}`,
        name: `${prefix.slice(0, 2)} ${value.昵称 || value.群名 || id}（${id}）`,
        content: JSON.stringify(value, null, 2),
      });
    } catch {
      logs.push(line);
    }
  }
  const count = Math.max(1, Math.ceil(results.length / 50)),
    current = Math.min(page, count - 1);
  return (
    <div className="weq-contact-task-log">
      <h3>获取结果 · {results.length} 个对象</h3>
      {results.slice(current * 50, current * 50 + 50).map((result) => (
        <details key={result.key} data-privacy-sensitive>
          <summary>{result.name}</summary>
          <pre>{result.content}</pre>
        </details>
      ))}
      {count > 1 && (
        <div className="weq-contact-log-pages">
          <button
            type="button"
            title="上一页结果"
            aria-label="上一页结果"
            disabled={!current}
            onClick={() => setPage(current - 1)}
          >
            <ChevronLeft size={16} />
          </button>
          <span>
            {current + 1}/{count}
          </span>
          <button
            type="button"
            title="下一页结果"
            aria-label="下一页结果"
            disabled={current === count - 1}
            onClick={() => setPage(current + 1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
      <h3>任务日志</h3>
      <LogConsole lines={records} collapsed={false} history />
      {logs.length > 0 && (
        <ul
          className="weq-background-task-results"
          role="log"
          aria-label="联系人缓存任务日志"
          data-privacy-sensitive
        >
          {logs.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function contactLogLines(details: string[]): UiLogLine[] {
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
