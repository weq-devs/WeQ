import { Fragment, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { CloudDownload, Download, FolderOpen, Square, Trash2, Users } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useViewState } from '../../state/view';
import { useQQReadActivity } from '../../hooks/useQQAutoRefresh';
import { useDialog } from '../Dialog';
import { RoamingBackfillPanel } from '../RoamingBackfillPanel';
import { formatSize } from '../../lib/groupFile';
import {
  dismissCloneTask,
  getCloneTasks,
  subscribeCloneTasks,
} from '../../views/agentlab/cloneTaskStore';
import { taskIcon, taskPct, taskTypeLabel, type UiTask } from '../../views/export/TaskList';
import { LongTaskRow, orderLongTasks, type LongTaskItem } from './LongTaskRow';

export function CurrentTaskList({
  exports,
  exportError,
  loadingExports,
  renderExport,
  onOpenClone,
  onSaveAll,
  autoSelectId,
}: {
  exports: UiTask[];
  exportError?: string;
  loadingExports?: boolean;
  renderExport: (task: UiTask) => ReactNode;
  onOpenClone?: (id: string) => void;
  onSaveAll: () => void;
  autoSelectId?: string | null;
}) {
  const { enabled: active } = useQQReadActivity(true, { onlineOnly: false });
  const accountId = useViewState((state) => state.openedUin);
  const utils = trpc.useUtils();
  const showError = useDialog((state) => state.showError);
  const clones = useSyncExternalStore(subscribeCloneTasks, getCloneTasks);
  const roaming = trpc.account.roamingBackfill.list.useQuery(undefined, {
    enabled: active,
    refetchInterval: active ? 1000 : false,
  });
  const flash = trpc.account.flashListDownloadTasks.useQuery(undefined, {
    enabled: active,
    refetchInterval: active ? 2000 : false,
  });
  const cancelFlash = trpc.account.flashCancelDownloadTask.useMutation({
    onSuccess: () => void utils.account.flashListDownloadTasks.invalidate(),
    onError: (error) => showError('取消下载失败', error.message),
  });
  const revealFlash = trpc.account.flashRevealDownloadDir.useMutation({
    onError: (error) => showError('打开下载目录失败', error.message),
  });
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (autoSelectId) setSelected(`export:${autoSelectId}`);
  }, [autoSelectId]);

  const items: LongTaskItem[] = exports.map((task): LongTaskItem => {
    const saving = task.save?.status === 'saving';
    const saveFailed =
      task.status === 'completed' &&
      (task.save?.status === 'failed' || task.save?.status === 'interrupted');
    const missing = (task.generatedResources?.missing ?? task.resource?.failed ?? 0) > 0;
    return {
      id: `export:${task.id}`,
      name: task.name,
      kind: taskTypeLabel(task),
      status: saving ? 'running' : saveFailed ? 'failed' : task.status,
      statusLabel: saving
        ? '保存中'
        : saveFailed
          ? '保存未完成'
          : task.status === 'completed'
            ? missing
              ? '完成 · 资源缺失'
              : task.save?.path
                ? '已保存'
                : '待保存'
            : undefined,
      progress: saving || saveFailed ? undefined : taskPct(task),
      note: task.error || task.save?.error,
      icon: taskIcon(task),
      detail: renderExport(task),
    };
  });
  for (const task of clones.filter((item) => item.accountId === accountId)) {
    items.push({
      id: `clone:${task.personaId}`,
      name: task.name,
      kind: '好友克隆',
      status: task.status === 'done' ? 'completed' : task.status === 'error' ? 'failed' : 'running',
      progress: task.percent,
      note: task.status === 'error' ? task.error : task.phase,
      icon: <Users size={16} />,
      detail: (
        <div>
          <p role={task.status === 'error' ? 'alert' : undefined}>{task.error || task.phase}</p>
          <div className="weq-long-task-actions">
            {task.status === 'done' && onOpenClone ? (
              <button
                type="button"
                className="weq-set-btn"
                onClick={() => onOpenClone(task.personaId)}
              >
                <Users size={14} />
                查看克隆体
              </button>
            ) : null}
            <button
              type="button"
              className="weq-set-btn"
              disabled={task.status === 'running'}
              onClick={() => dismissCloneTask(task.personaId)}
            >
              <Trash2 size={14} />
              移除任务
            </button>
          </div>
        </div>
      ),
    });
  }
  for (const job of roaming.data?.jobs ?? []) {
    const status =
      job.status === 'planned'
        ? 'pending'
        : job.status === 'pausing'
          ? 'running'
          : job.status === 'partial'
            ? 'paused'
            : job.status;
    items.push({
      id: `roaming:${job.id}`,
      name: job.targets.map((target) => target.name).join('、') || '漫游消息补全',
      kind: '漫游拉取',
      status,
      statusLabel:
        job.status === 'partial'
          ? '仍有缺口'
          : job.status === 'pausing'
            ? '暂停收尾中'
            : job.status === 'completed'
              ? '候选缺口已覆盖'
              : undefined,
      // 进度只表示已实际覆盖的候选 seq，不把已尝试的请求当作成功。
      progress:
        job.plannedSeqs > 0
          ? ((job.plannedSeqs - job.remainingSeqs) / job.plannedSeqs) * 100
          : undefined,
      note: `${job.targets.length} 个会话 · 仍未确认 ${job.remainingSeqs} seq`,
      icon: <CloudDownload size={16} />,
      detail: <RoamingBackfillPanel surface="tasks" taskId={job.id} />,
    });
  }
  if (roaming.data?.scanning) {
    items.push({
      id: 'roaming:scanning',
      name: '扫描候选缺口',
      kind: '漫游拉取',
      status: 'running',
      icon: <CloudDownload size={16} />,
      detail: <p>正在扫描本地锚点，扫描完成后生成补全任务。</p>,
    });
  }
  for (const task of flash.data ?? []) {
    const running = task.status === 'resolving' || task.status === 'downloading';
    items.push({
      id: `flash:${task.id}`,
      name: task.name,
      kind: '闪传下载',
      status:
        task.status === 'done'
          ? 'completed'
          : task.status === 'resolving' || task.status === 'downloading'
            ? 'running'
            : task.status,
      statusLabel: task.status === 'resolving' ? '获取链接' : undefined,
      progress:
        task.status === 'done'
          ? 100
          : task.fileSize > 0
            ? (task.downloadedBytes / task.fileSize) * 100
            : undefined,
      note: `${formatSize(task.downloadedBytes)} / ${formatSize(task.fileSize)}`,
      icon: <Download size={16} />,
      detail: (
        <div>
          <p>
            {task.filesetName} · {task.relativePath}
          </p>
          <p>{task.targetPath}</p>
          {task.error ? <p role="alert">{task.error}</p> : null}
          <div className="weq-long-task-actions">
            <button
              type="button"
              className="weq-set-btn"
              disabled={revealFlash.isLoading}
              onClick={() => revealFlash.mutate()}
            >
              <FolderOpen size={14} />
              打开下载目录
            </button>
            {running || task.status === 'pending' ? (
              <button
                type="button"
                className="weq-set-btn"
                disabled={cancelFlash.isLoading}
                onClick={() => cancelFlash.mutate({ taskId: task.id })}
              >
                <Square size={14} />
                取消下载
              </button>
            ) : null}
          </div>
        </div>
      ),
    });
  }
  const ordered = orderLongTasks(items);
  const selectedId =
    selected === null
      ? null
      : ordered.some((item) => item.id === selected)
        ? selected
        : ordered[0]?.id;
  const running = items.filter((task) => task.status === 'running').length;
  const loading = loadingExports || roaming.isLoading || flash.isLoading;
  const hasError = exportError || roaming.error || flash.error;
  return (
    <section className="weq-current-tasks" aria-label="当前任务列表">
      <header className="weq-current-tasks-head">
        <span>
          {items.length} 项任务{running ? ` · ${running} 项进行中` : ''}
        </span>
        {exports.some((task) => task.status === 'completed') ? (
          <button type="button" className="weq-set-btn" onClick={onSaveAll}>
            <Download size={14} />
            全部保存
          </button>
        ) : null}
      </header>
      {exportError ? (
        <p role="alert" className="weq-current-tasks-notice">
          导出任务读取失败：{exportError}
        </p>
      ) : null}
      {roaming.error ? (
        <p role="alert" className="weq-current-tasks-notice">
          漫游任务读取失败：{roaming.error.message}
        </p>
      ) : null}
      {flash.error ? (
        <p role="alert" className="weq-current-tasks-notice">
          闪传任务读取失败：{flash.error.message}
        </p>
      ) : null}
      {!items.length && !hasError ? (
        <p className="weq-current-tasks-empty">{loading ? '读取任务中…' : '暂无任务'}</p>
      ) : null}
      {ordered.map((task) => (
        <Fragment key={task.id}>
          <LongTaskRow
            task={task}
            active={task.id === selectedId}
            onSelect={() => setSelected(task.id === selectedId ? null : task.id)}
          />
          {task.id === selectedId ? (
            <div className="weq-long-task-detail">{task.detail}</div>
          ) : null}
        </Fragment>
      ))}
    </section>
  );
}
