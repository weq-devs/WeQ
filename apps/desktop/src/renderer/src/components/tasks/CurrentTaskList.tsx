import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useTabActive } from '../RetainedTabs';
import { useWorkspaceMenu } from '../../state/workspaceMenu';
import {
  CloudDownload,
  Download,
  FolderOpen,
  ExternalLink,
  FileCheck,
  Pause,
  Play,
  RotateCw,
  Square,
  Trash2,
  Users,
} from 'lucide-react';
import { client, trpc } from '../../trpc/client';
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
import {
  taskIcon,
  taskPct,
  taskTypeLabel,
  taskSaveActionLabel,
  type UiTask,
} from '../../views/export/TaskList';
import { LongTaskRow, orderLongTasks, type LongTaskItem } from './LongTaskRow';
import '../../styles/flash-transfer.css';
import { CloneTaskLog } from '../../views/agentlab/CloneTaskLog';
import {
  useBackgroundTasks,
  backgroundTaskId,
  removeBackgroundTask,
} from '../../hooks/useBackgroundTasks';
import {
  BACKGROUND_TASK_ICONS,
  BACKGROUND_TASK_LABELS,
  BackgroundTaskDetails,
} from './BackgroundTaskDetails';
import { TaskQuickActions, type TaskQuickAction } from './TaskQuickActions';
import { localBackgroundTasks } from '../../state/backgroundTasks';
import { IS_WEB } from '../../lib/target';

export interface ExportTaskActions {
  pause: (task: UiTask) => unknown;
  resume: (task: UiTask) => unknown;
  cancel: (task: UiTask) => unknown;
  remove: (task: UiTask) => unknown;
  save?: (task: UiTask) => unknown;
  openSaved?: (task: UiTask, reveal: boolean) => unknown;
  report?: (task: UiTask) => unknown;
  browserDownload?: (task: UiTask) => unknown;
}

export function CurrentTaskList({
  exports,
  exportError,
  loadingExports,
  renderExport,
  onOpenClone,
  autoSelectId,
  layout = 'inline',
  onOpenDetail,
  cleanupBinding,
  exportActions,
}: {
  exports: UiTask[];
  exportError?: string;
  loadingExports?: boolean;
  renderExport: (task: UiTask) => ReactNode;
  onOpenClone?: (id: string) => void;
  autoSelectId?: string | null;
  layout?: 'inline' | 'compact' | 'split';
  onOpenDetail?: () => void;
  cleanupBinding?: { expectedAccountUin: string; expectedAccountConfigId: string } | null;
  exportActions?: ExportTaskActions;
}) {
  const { enabled: active } = useQQReadActivity(true, { onlineOnly: false });
  const background = useBackgroundTasks(active);
  const accountId = useViewState((state) => state.openedUin);
  const utils = trpc.useUtils();
  const showError = useDialog((state) => state.showError);
  const confirm = useDialog((state) => state.confirm);
  const showInfo = useDialog((state) => state.showInfo);
  const [clearing, setClearing] = useState(false);
  const [openingFlash, setOpeningFlash] = useState<string | null>(null);
  const openingFlashRef = useRef<string | null>(null);
  const clearingRef = useRef(false);
  const bindingRef = useRef(cleanupBinding);
  bindingRef.current = cleanupBinding;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const taskFocusId = useWorkspaceMenu((state) => state.taskFocusId);
  const taskOpenRequest = useWorkspaceMenu((state) => state.taskOpenRequest);
  const appliedFocus = useRef<string | null>(null);
  useEffect(() => {
    if (autoSelectId) setSelected(`export:${autoSelectId}`);
  }, [autoSelectId]);

  const items: LongTaskItem[] = exports.map((task): LongTaskItem => {
    const saving = task.save?.status === 'saving';
    const saveLabel = taskSaveActionLabel(task);
    const saveFailed =
      task.status === 'completed' &&
      (task.save?.status === 'failed' || task.save?.status === 'interrupted');
    const missing = (task.generatedResources?.missing ?? task.resource?.failed ?? 0) > 0;
    const actions: TaskQuickAction[] = [];
    if (exportActions) {
      if (task.save?.path && exportActions.openSaved) {
        actions.push(
          {
            id: 'open',
            label: '打开保存结果',
            icon: <ExternalLink size={14} />,
            run: () => exportActions.openSaved!(task, false),
          },
          {
            id: 'reveal',
            label: '在文件夹中显示',
            icon: <FolderOpen size={14} />,
            run: () => exportActions.openSaved!(task, true),
          },
        );
      }
      if (exportActions.save && saveLabel)
        actions.push({
          id: 'save',
          label: saveLabel,
          icon: <Download size={14} />,
          disabled: saving,
          secondary: Boolean(task.save?.path),
          run: () => exportActions.save!(task),
        });
      if (task.status === 'completed' && exportActions.browserDownload)
        actions.push({
          id: 'download',
          label: '下载到浏览器',
          icon: <Download size={14} />,
          run: () => exportActions.browserDownload!(task),
        });
      if (task.reportPath && exportActions.report)
        actions.push({
          id: 'report',
          label: '完整性报告',
          icon: <FileCheck size={14} />,
          secondary: true,
          run: () => exportActions.report!(task),
        });
      if (task.status === 'running')
        actions.push({
          id: 'pause',
          label: '暂停',
          icon: <Pause size={14} />,
          run: () => exportActions.pause(task),
        });
      if (task.canResume)
        actions.push({
          id: 'resume',
          label:
            task.status === 'completed'
              ? '补传已跳过项目'
              : task.resumeMode === 'restart'
                ? '重新执行导出'
                : '继续导出',
          icon: task.resumeMode === 'restart' ? <RotateCw size={14} /> : <Play size={14} />,
          disabled: saving || task.isFinalizing,
          run: () => exportActions.resume(task),
        });
      if (['pending', 'running', 'paused', 'failed'].includes(task.status))
        actions.push({
          id: 'cancel',
          label: '取消',
          icon: <Square size={14} />,
          disabled: task.isFinalizing,
          run: () => exportActions.cancel(task),
        });
      if (task.status !== 'running')
        actions.push({
          id: 'remove',
          label: '删除导出缓存',
          icon: <Trash2 size={14} />,
          disabled: saving || task.isFinalizing,
          run: () => exportActions.remove(task),
        });
      if (task.status !== 'completed') {
        const control = (action: TaskQuickAction) =>
          ['pause', 'resume', 'cancel'].includes(action.id);
        actions.sort((a, b) => Number(control(b)) - Number(control(a)));
      }
    }
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
      quickActions: actions.length ? <TaskQuickActions actions={actions} /> : null,
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
      quickActions:
        task.status !== 'running' ? (
          <TaskQuickActions
            actions={[
              ...(task.status === 'done' && onOpenClone
                ? [
                    {
                      id: 'open',
                      label: '查看克隆体',
                      icon: <Users size={14} />,
                      run: () => onOpenClone(task.personaId),
                    },
                  ]
                : []),
              {
                id: 'remove',
                label: '移除任务',
                icon: <Trash2 size={14} />,
                run: () => dismissCloneTask(task.personaId),
              },
            ]}
          />
        ) : null,
      detail: (
        <div>
          <p role={task.status === 'error' ? 'alert' : undefined}>{task.error || task.phase}</p>
          <CloneTaskLog key={`${task.personaId}:${task.revision}`} task={task} />
          <div className="weq-long-task-actions">
            {task.status === 'done' && onOpenClone ? (
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft"
                onClick={() => onOpenClone(task.personaId)}
              >
                <Users size={14} />
                查看克隆体
              </button>
            ) : null}
            <button
              type="button"
              className="weq-set-btn weq-set-btn-soft"
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
    const actions: TaskQuickAction[] = [];
    const refresh = () => utils.account.roamingBackfill.list.invalidate();
    const busy = Boolean(roaming.data?.activeId || roaming.data?.scanning);
    if (job.status === 'running')
      actions.push({
        id: 'pause',
        label: '暂停',
        icon: <Pause size={14} />,
        run: async () => {
          await client.account.roamingBackfill.pause.mutate({ id: job.id });
          await refresh();
        },
      });
    if (['planned', 'paused', 'failed', 'partial'].includes(job.status))
      actions.push({
        id: 'resume',
        label:
          job.status === 'planned'
            ? '开始补全'
            : job.status === 'partial'
              ? '重试未补区间'
              : '继续',
        icon: <Play size={14} />,
        disabled:
          busy ||
          roaming.data?.historyVersion !== 2 ||
          ['native500', 'sso500'].includes(job.options.transport ?? ''),
        run: async () => {
          await client.account.roamingBackfill.start.mutate({
            id: job.id,
            retryRemaining: job.status === 'partial',
          });
          await refresh();
        },
      });
    if (!['completed', 'cancelled'].includes(job.status))
      actions.push({
        id: 'cancel',
        label: '取消',
        icon: <Square size={14} />,
        disabled: job.status === 'pausing',
        run: async () => {
          await client.account.roamingBackfill.cancel.mutate({ id: job.id });
          await refresh();
        },
      });
    actions.push({
      id: 'remove',
      label: '移除补全任务',
      icon: <Trash2 size={14} />,
      disabled: busy,
      run: async () => {
        const binding = bindingRef.current;
        if (!(await confirm('移除任务？', '仅移除任务与断点，已经取得的漫游消息会保留。'))) return;
        if (
          !mounted.current ||
          bindingRef.current?.expectedAccountUin !== binding?.expectedAccountUin ||
          bindingRef.current?.expectedAccountConfigId !== binding?.expectedAccountConfigId
        )
          return;
        await client.account.roamingBackfill.remove.mutate({ id: job.id });
        await refresh();
      },
    });
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
              ? job.plannedSeqs === 0
                ? '未发现可补全的缺口'
                : '候选缺口已覆盖'
              : undefined,
      // 进度只表示已实际覆盖的候选 seq，不把已尝试的请求当作成功。
      progress:
        job.plannedSeqs > 0
          ? ((job.plannedSeqs - job.remainingSeqs) / job.plannedSeqs) * 100
          : undefined,
      note: `${job.targets.length} 个会话 · 仍未确认 ${job.remainingSeqs} seq`,
      icon: <CloudDownload size={16} />,
      detail: <RoamingBackfillPanel surface="tasks" taskId={job.id} />,
      quickActions: <TaskQuickActions actions={actions} />,
    });
  }
  if (roaming.data?.scanning) {
    items.push({
      id: 'roaming:scanning',
      name: '正在检查缺失消息',
      kind: '漫游拉取',
      status: 'running',
      icon: <CloudDownload size={16} />,
      detail: <p>正在检查所选范围内的本地记录与候选缺口。</p>,
    });
  }
  for (const task of flash.data ?? []) {
    const running = task.status === 'resolving' || task.status === 'downloading';
    const single = (task.files?.length ?? 1) === 1;
    const openFlash = async (mode: 'file' | 'directory' | 'reveal') => {
      if (!cleanupBinding || openingFlashRef.current) return;
      openingFlashRef.current = task.id;
      setOpeningFlash(task.id);
      try {
        await client.account.flashOpenDownloadOutput.mutate({
          ...cleanupBinding,
          taskId: task.id,
          mode,
        });
      } finally {
        openingFlashRef.current = null;
        if (mounted.current) setOpeningFlash(null);
      }
    };
    const actions: TaskQuickAction[] =
      running || task.status === 'pending'
        ? [
            {
              id: 'cancel',
              label: '取消下载',
              icon: <Square size={14} />,
              run: async () => {
                await client.account.flashCancelDownloadTask.mutate({ taskId: task.id });
                await utils.account.flashListDownloadTasks.invalidate();
              },
            },
          ]
        : [
            {
              id: 'remove',
              label: '移除任务',
              icon: <Trash2 size={14} />,
              disabled: !cleanupBinding,
              run: async () => {
                if (!cleanupBinding) return;
                const result = await client.account.clearFinishedTasks.mutate({
                  ...cleanupBinding,
                  exports: [],
                  roaming: [],
                  flash: [task.id],
                });
                await utils.account.flashListDownloadTasks.invalidate();
                if (result.errors.length) throw new Error(result.errors.join('\n'));
                if (!result.removed)
                  showInfo('暂时无法移除', '任务状态已变化，请查看最新任务状态。');
              },
            },
          ];
    if (!IS_WEB) {
      if (single && task.status === 'done')
        actions.unshift({
          id: 'open',
          label: '打开文件',
          icon: <ExternalLink size={14} />,
          disabled: !cleanupBinding || Boolean(openingFlash),
          run: () => openFlash('file'),
        });
      actions.splice(single && task.status === 'done' ? 1 : 0, 0, {
        id: 'reveal',
        label: single ? '在文件夹中显示' : '打开下载目录',
        icon: <FolderOpen size={14} />,
        disabled: !cleanupBinding || Boolean(openingFlash),
        secondary: running || task.status === 'pending',
        run: () => openFlash(single ? 'reveal' : 'directory'),
      });
    }
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
      note: `${task.files?.length ?? 1} 个文件 · ${formatSize(task.downloadedBytes)} / ${formatSize(task.fileSize)}`,
      icon: <Download size={16} />,
      quickActions: <TaskQuickActions actions={actions} />,
      detail: (
        <div>
          <p>
            {task.filesetName} · 已完成{' '}
            {task.files?.filter((file) => file.status === 'done').length ??
              (task.status === 'done' ? 1 : 0)}{' '}
            / {task.files?.length ?? 1} 个文件
          </p>
          {(task.files?.length ?? 1) === 1 ? <p>{task.targetPath}</p> : null}
          {task.error ? <p role="alert">{task.error}</p> : null}
          <ul className="weq-flash-task-files" aria-label="下载文件">
            {(task.files ?? [task]).map((file) => (
              <li key={file.id}>
                <span title={file.targetPath}>{file.relativePath}</span>
                <span>
                  {
                    {
                      pending: '等待中',
                      resolving: '获取链接',
                      downloading: '下载中',
                      done: '已完成',
                      failed: '失败',
                      cancelled: '已取消',
                    }[file.status]
                  }{' '}
                  · {formatSize(file.downloadedBytes)} / {formatSize(file.fileSize)}
                </span>
                {file.error ? <p role="alert">{file.error}</p> : null}
              </li>
            ))}
          </ul>
          <div className="weq-long-task-actions">
            {!IS_WEB && single && task.status === 'done' ? (
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft"
                disabled={!cleanupBinding || Boolean(openingFlash)}
                onClick={() =>
                  void openFlash('file').catch((error) =>
                    showError(
                      '打开文件失败',
                      error instanceof Error ? error.message : String(error),
                    ),
                  )
                }
              >
                <ExternalLink size={14} />
                打开文件
              </button>
            ) : null}
            {!IS_WEB ? (
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft"
                disabled={!cleanupBinding || Boolean(openingFlash)}
                onClick={() =>
                  void openFlash(single ? 'reveal' : 'directory').catch((error) =>
                    showError(
                      '打开下载目录失败',
                      error instanceof Error ? error.message : String(error),
                    ),
                  )
                }
              >
                <FolderOpen size={14} />
                打开下载目录
              </button>
            ) : null}
            {running || task.status === 'pending' ? (
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft"
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
  for (const entry of background.tasks) {
    const task = entry.task;
    const Icon = BACKGROUND_TASK_ICONS[task.kind];
    const actions: TaskQuickAction[] = task.actions.map((action) => ({
      id: action.id,
      label: action.label,
      icon:
        action.id === 'stop' || action.id === 'cancel' ? (
          <Square size={14} />
        ) : action.id === 'pause' ? (
          <Pause size={14} />
        ) : action.id === 'resume' || action.id === 'retry' ? (
          <Play size={14} />
        ) : (
          <FolderOpen size={14} />
        ),
      run: async () => {
        if (action.id === 'view-report' && task.reportId) {
          window.dispatchEvent(
            new CustomEvent('weq:open-saved-analysis', { detail: task.reportId }),
          );
          return;
        }
        if (entry.source === 'window') await localBackgroundTasks.act(task.id, action.id);
        else
          await client.backgroundTasks.act.mutate({
            id: task.id,
            action: action.id,
            scope: background.scope,
          });
        await background.query.refetch();
      },
    }));
    if (task.status !== 'running')
      actions.push({
        id: 'remove',
        label: '移除任务',
        icon: <Trash2 size={14} />,
        run: async () => {
          const removed = await removeBackgroundTask(entry, background.scope);
          await background.query.refetch();
          if (!removed) showInfo('暂时无法移除', '任务状态已变化，请查看最新任务状态。');
        },
      });
    items.push({
      id: backgroundTaskId(entry),
      name: task.name,
      kind: BACKGROUND_TASK_LABELS[task.kind],
      status: task.status,
      statusLabel: task.statusLabel,
      progress: task.progress,
      note: task.note,
      icon: <Icon size={16} />,
      quickActions: actions.length ? <TaskQuickActions actions={actions} /> : null,
      detail: (
        <BackgroundTaskDetails
          key={task.id}
          entry={entry}
          scope={background.scope}
          refresh={() => background.query.refetch()}
        />
      ),
    });
  }
  const ordered = orderLongTasks(items);
  useEffect(() => {
    const request = `${taskOpenRequest}:${taskFocusId}`;
    if (
      appliedFocus.current !== request &&
      taskFocusId &&
      items.some((task) => task.id === taskFocusId)
    ) {
      appliedFocus.current = request;
      setSelected(taskFocusId);
    }
  }, [taskFocusId, taskOpenRequest, items]);
  useEffect(() => {
    if (selected !== null && !ordered.some((task) => task.id === selected) && ordered[0])
      setSelected(ordered[0].id);
  }, [selected, ordered]);
  const selectedId =
    selected === null
      ? null
      : ordered.some((item) => item.id === selected)
        ? selected
        : ordered[0]?.id;
  const running = items.filter((task) => task.status === 'running').length;
  const loading =
    loadingExports || roaming.isLoading || flash.isLoading || background.query.isLoading;
  const visible = useTabActive();
  const unreadResults = useWorkspaceMenu((state) => state.finished);
  const readTasks = useWorkspaceMenu((state) => state.readTasks);
  useLayoutEffect(() => {
    if (visible && active && !loading && unreadResults > 0) readTasks();
  }, [visible, active, loading, unreadResults, readTasks]);
  const hasError = exportError || roaming.error || flash.error || background.query.error;
  /** 已结束的任务都可移除；进行中、等待和可续传的暂停任务保留。 */
  const finished = items.filter(
    (task) =>
      task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled',
  );
  const clearFinished = async (): Promise<void> => {
    if (clearingRef.current || !cleanupBinding || !finished.length) return;
    clearingRef.current = true;
    setClearing(true);
    const binding = { ...cleanupBinding };
    const current = () =>
      mounted.current &&
      bindingRef.current?.expectedAccountUin === binding.expectedAccountUin &&
      bindingRef.current?.expectedAccountConfigId === binding.expectedAccountConfigId;
    const ids = new Set(finished.map((task) => task.id));
    // 只提醒仍可取回、值得先保存的完成结果；失败任务本就无法从列表取回。
    const unsaved = exports.filter(
      (task) =>
        ids.has(`export:${task.id}`) &&
        task.status === 'completed' &&
        task.save?.status !== 'saved',
    ).length;
    const cloneSelection = clones.filter(
      (task) => task.accountId === accountId && ids.has(`clone:${task.personaId}`),
    );
    try {
      const ok = await confirm(
        '清理已结束任务',
        `确定清除 ${finished.length} 项已结束任务？只移除任务记录和导出缓存，不删除已保存的文件、克隆体或聊天记录。${unsaved ? `其中 ${unsaved} 项导出尚未保存，清除后将无法从任务列表取回结果。` : ''}`,
        { okLabel: `清除 ${finished.length} 项`, cancelLabel: '保留' },
      );
      if (!ok || !current()) return;
      const result = await client.account.clearFinishedTasks.mutate({
        ...binding,
        exports: exports.filter((task) => ids.has(`export:${task.id}`)).map((task) => task.id),
        roaming: (roaming.data?.jobs ?? [])
          .filter((job) => ids.has(`roaming:${job.id}`))
          .map((job) => job.id),
        flash: (flash.data ?? [])
          .filter((task) => ids.has(`flash:${task.id}`))
          .map((task) => task.id),
      });
      let removed = result.removed;
      for (const task of cloneSelection) {
        // 同一克隆体可能已重新构建；只移除确认时的那条结束记录。
        if (getCloneTasks().includes(task) && task.status !== 'running') {
          dismissCloneTask(task.personaId);
          removed += 1;
        }
      }
      for (const entry of background.tasks.filter((entry) => ids.has(backgroundTaskId(entry)))) {
        try {
          if (await removeBackgroundTask(entry, background.scope)) removed++;
        } catch (error) {
          result.errors.push(
            `${entry.task.name}：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      await Promise.all([
        background.query.refetch(),
        utils.account.listExportTasks.invalidate(),
        utils.account.getExportOutputReceipt.invalidate(),
        utils.account.roamingBackfill.list.invalidate(),
        utils.account.flashListDownloadTasks.invalidate(),
      ]);
      if (current()) {
        const summary = `已清除 ${removed} 项任务。${finished.length - removed > 0 ? `其余 ${finished.length - removed} 项未清除，请查看最新任务状态。` : ''}`;
        if (result.errors.length)
          showError('部分任务未清除', `${summary}\n${result.errors.join('\n')}`);
        else showInfo('清除完成', summary);
      }
    } catch (error) {
      if (current()) showError('清除失败', error instanceof Error ? error.message : String(error));
    } finally {
      clearingRef.current = false;
      if (mounted.current) setClearing(false);
    }
  };
  return (
    <section className={`weq-current-tasks is-${layout}`} aria-label="当前任务列表">
      <header className="weq-current-tasks-head">
        <span>
          {items.length} 项任务{running ? ` · ${running} 项进行中` : ''}
        </span>
        <div className="weq-current-tasks-actions">
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft"
            title="清理已结束任务"
            aria-label="清理已结束任务"
            disabled={clearing || loading || !cleanupBinding || !finished.length}
            onClick={() => void clearFinished()}
          >
            <Trash2 size={14} />
            清理已结束任务
          </button>
        </div>
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
      {background.query.error ? (
        <p role="alert" className="weq-current-tasks-notice">
          后台任务读取失败：{background.query.error.message}
        </p>
      ) : null}
      {!items.length && !hasError ? (
        <p className="weq-current-tasks-empty">{loading ? '读取任务中…' : '暂无任务'}</p>
      ) : null}
      <div className="weq-current-task-columns">
        <div className="weq-current-task-list">
          {ordered.map((task) => (
            <Fragment
              key={`${cleanupBinding?.expectedAccountUin ?? accountId}:${cleanupBinding?.expectedAccountConfigId ?? ''}:${task.id}`}
            >
              <LongTaskRow
                task={task}
                active={task.id === selectedId}
                showQuickActions={layout === 'compact'}
                onSelect={() => {
                  setSelected(layout === 'inline' && task.id === selectedId ? null : task.id);
                  if (layout === 'compact') onOpenDetail?.();
                }}
              />
              {layout === 'inline' && task.id === selectedId ? (
                <div className="weq-long-task-detail">{task.detail}</div>
              ) : null}
            </Fragment>
          ))}
        </div>
        {layout === 'split' ? (
          <div className="weq-current-task-details" aria-label="任务步骤详情">
            {ordered.find((task) => task.id === selectedId)?.detail ?? (
              <p className="weq-workspace-empty">请选择任务</p>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
