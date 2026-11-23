import { ToolbarLabel } from '../CompactToolbar';
import { observeCompactToolbar } from '../CompactToolbar.shared';
import { NumericText } from '../NumericText';
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useTabActive } from '../RetainedTabs.shared';
import { useWorkspaceMenu } from '../../state/workspaceMenu';
import {
  CloudDownload,
  Download,
  Ellipsis,
  FolderOpen,
  ExternalLink,
  FileCheck,
  ListTodo,
  Pause,
  Play,
  RefreshCw,
  Square,
  Trash2,
  Users,
} from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { useViewState } from '../../state/view';
import { useQQReadActivity } from '../../hooks/useQQAutoRefresh';
import { useDialog } from '../Dialog.shared';
import { useToast } from '../Toast.shared';
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
  taskResumeActionLabel,
  taskCancelActionLabel,
  taskCanPause,
} from '../../views/export/TaskList.shared';
import type { UiTask } from '../../views/export/TaskList';
import { LongTaskRow, type LongTaskItem } from './LongTaskRow';
import { orderLongTasks } from './LongTaskRow.shared';
import '../../styles/flash-transfer.css';
import { CloneTaskLog } from '../../views/agentlab/CloneTaskLog';
import {
  useBackgroundTasks,
  backgroundTaskId,
  removeBackgroundTask,
} from '../../hooks/useBackgroundTasks';
import { BACKGROUND_TASK_ICONS, BACKGROUND_TASK_LABELS } from './BackgroundTaskDetails.shared';
import { BackgroundTaskActionIcon, BackgroundTaskDetails } from './BackgroundTaskDetails';
import { TaskQuickActions, type TaskQuickAction } from './TaskQuickActions';
import { localBackgroundTasks } from '../../state/backgroundTasks';
import { IS_WEB } from '../../lib/target.shared';
import { downloadFlashToDevice } from '../../lib/flashDownload';
import { backgroundTaskNavigation } from './backgroundTaskNavigation';
import { EmptyState } from '../EmptyState';
import { TaskProgressDetails } from './TaskProgressDetails';
import { FlashTaskLog } from './FlashTaskLog';
import { TaskProgressBar } from './TaskProgressBar';
import {
  exportTaskDisplay,
  roamingTaskDisplay,
  taskDisplayTitle,
  taskDate,
} from '@weq/service/task-display';
import { backgroundTaskDisplay } from '../../../../shared/background_task';
import { isRoamingJobComplete, roamingJobProgress } from '../../../../shared/roaming_task_status';
import { TaskName } from './TaskName';
import { ConversationActionsMenu } from '../ConversationActionsMenu';
import { RetainedTabs } from '../RetainedTabs';
import { TaskDetailPage } from './TaskDetailPage';

export type TaskLayout = 'inline' | 'compact' | 'split' | 'page';

function isEnded(task: LongTaskItem) {
  return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
}

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
  selection,
  layout = 'inline',
  onOpenDetail,
  toolbarAction,
  cleanupBinding,
  exportActions,
}: {
  exports: UiTask[];
  exportError?: string;
  loadingExports?: boolean;
  renderExport: (task: UiTask) => ReactNode;
  onOpenClone?: (id: string) => void;
  autoSelectId?: string | null;
  selection?: readonly [string | null | undefined, (id: string | null) => void];
  layout?: TaskLayout;
  onOpenDetail?: () => void;
  toolbarAction?: ReactNode;
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
  const [cleanupMenu, setCleanupMenu] = useState<{ x: number; y: number } | null>(null);
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
  const paged = layout === 'page';
  const localSelection = useState<string | null>();
  const [selected, setSelected] = selection ?? localSelection;
  const taskFocusId = useWorkspaceMenu((state) => state.taskFocusId);
  const taskOpenRequest = useWorkspaceMenu((state) => state.taskOpenRequest);
  const appliedFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!paged && autoSelectId) setSelected(`export:${autoSelectId}`);
  }, [autoSelectId, paged, setSelected]);

  const items: LongTaskItem[] = exports.map((task): LongTaskItem => {
    const display = exportTaskDisplay(task);
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
      if (taskCanPause(task) && (task.status === 'running' || task.networkPaused))
        actions.push({
          id: 'pause',
          label: task.networkPaused ? '保持暂停' : '暂停',
          icon: <Pause size={14} />,
          disabled: task.isFinalizing,
          run: () => exportActions.pause(task),
        });
      if (task.canResume)
        actions.push({
          id: 'resume',
          label: taskResumeActionLabel(task),
          icon:
            task.resumeMode === 'restart' ? (
              <RefreshCw size={14} aria-hidden />
            ) : (
              <Play size={14} />
            ),
          disabled: saving || task.isFinalizing,
          run: () => exportActions.resume(task),
        });
      if (['pending', 'running', 'paused', 'failed'].includes(task.status))
        actions.push({
          id: 'cancel',
          label: taskCancelActionLabel(task),
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
      name: taskDisplayTitle(display),
      display,
      createdAt: task.createdAt,
      kind: task.resource ? (display.category ?? '') : taskTypeLabel(task),
      status: saving ? 'running' : saveFailed ? 'failed' : task.status,
      statusLabel: task.databaseRecovery
        ? '等待处理'
        : task.networkPaused
          ? '省流量模式已暂停'
          : saving
            ? '保存中'
            : saveFailed
              ? '保存未完成'
              : task.status === 'completed'
                ? task.databaseRecoveryRecords?.length
                  ? '部分完成'
                  : missing
                    ? '完成 · 资源缺失'
                    : task.save?.path
                      ? '已保存'
                      : '待保存'
                : undefined,
      progress: saving || saveFailed ? undefined : taskPct(task),
      note:
        [
          display.context,
          !task.resource && !task.isMarketPack && !task.isEmojiPack
            ? (task.formats ?? [task.format]).join(' / ').toUpperCase()
            : undefined,
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
      icon: taskIcon(task),
      detail: renderExport(task),
      quickActions: actions.length ? <TaskQuickActions actions={actions} /> : null,
    };
  });
  const hostClones = new Set(background.tasks.map(({ task }) => task.clonePersonaId));
  for (const task of clones.filter(
    (item) => item.accountId === accountId && !hostClones.has(item.personaId),
  )) {
    const display = {
      action: task.operation === 'update' ? '更新好友克隆' : '创建好友克隆',
      subject: task.name,
    };
    const actions: TaskQuickAction[] = [];
    if (task.status === 'done' && onOpenClone) {
      actions.push({
        id: 'open',
        label: '查看克隆体',
        icon: <Users size={14} />,
        run: () => onOpenClone(task.personaId),
      });
    }
    actions.push({
      id: 'remove',
      label: '移除任务',
      icon: <Trash2 size={14} />,
      disabled: task.status === 'running',
      run: () => dismissCloneTask(task.personaId),
    });
    items.push({
      id: `clone:${task.personaId}`,
      name: taskDisplayTitle(display),
      display,
      kind: '好友克隆',
      status: task.status === 'done' ? 'completed' : task.status === 'error' ? 'failed' : 'running',
      progress: task.percent,
      icon: <Users size={16} />,
      quickActions: task.status !== 'running' ? <TaskQuickActions actions={actions} /> : null,
      detail: (
        <div>
          <TaskProgressDetails
            name={task.name}
            display={display}
            status={
              task.status === 'done' ? 'completed' : task.status === 'error' ? 'failed' : 'running'
            }
            progress={task.percent}
            note={task.error || task.phase}
            actions={<TaskQuickActions variant="detail" actions={actions} />}
          />
          <CloneTaskLog key={`${task.personaId}:${task.revision}`} task={task} />
        </div>
      ),
    });
  }
  for (const job of roaming.data?.jobs ?? []) {
    const targets = job.planning ? job.options.targets : job.targets;
    const display = roamingTaskDisplay(targets);
    const complete = isRoamingJobComplete(job.status);
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
    if (['planned', 'paused', 'failed', 'partial', 'cancelled'].includes(job.status))
      actions.push({
        id: 'resume',
        label: job.planning
          ? '继续检查'
          : job.status === 'planned'
            ? '开始补全'
            : job.status === 'partial' || job.status === 'cancelled'
              ? '重试未补区间'
              : '继续',
        icon:
          job.status === 'cancelled' || job.status === 'partial' ? (
            <RefreshCw size={14} aria-hidden />
          ) : (
            <Play size={14} />
          ),
        disabled:
          busy ||
          roaming.data?.historyVersion !== 2 ||
          ['native500', 'sso500'].includes(job.options.transport ?? ''),
        run: async () => {
          await client.account.roamingBackfill.start.mutate({
            id: job.id,
            retryRemaining: job.status === 'partial' || job.status === 'cancelled',
          });
          await refresh();
        },
      });
    if (!complete && job.status !== 'cancelled')
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
        if (
          !(await confirm('移除任务？', '仅移除任务与断点，已经取得的漫游消息会保留。', {
            danger: 'outline',
          }))
        )
          return;
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
            ? 'completed'
            : job.status;
    items.push({
      id: `roaming:${job.id}`,
      name: taskDisplayTitle(display),
      display,
      createdAt: job.createdAt,
      kind: targets.length === 1 ? (targets[0]!.kind === 'group' ? '群聊' : '私聊') : '多个会话',
      status,
      statusLabel:
        job.planning && job.status === 'running'
          ? '检查缺失消息'
          : job.status === 'partial'
            ? '已完成 · 仍有缺口'
            : job.status === 'pausing'
              ? '暂停收尾中'
              : job.status === 'completed'
                ? job.plannedSeqs === 0
                  ? '未发现可补全的缺口'
                  : '候选缺口已覆盖'
                : undefined,
      progress: roamingJobProgress(job),
      note: job.options.range
        ? `${job.options.range.start ? taskDate(job.options.range.start * 1000) : '不限起始'} 至 ${job.options.range.end ? taskDate(job.options.range.end * 1000) : '不限结束'}`
        : undefined,
      icon: <CloudDownload size={16} />,
      detail: (
        <div>
          <h3 className="weq-task-detail-name">
            <TaskName display={display} />
          </h3>
          <RoamingBackfillPanel surface="tasks" taskId={job.id} />
        </div>
      ),
      quickActions: <TaskQuickActions actions={actions} />,
    });
  }
  if (roaming.data?.scanning && !roaming.data.jobs.some((job) => job.planning)) {
    items.push({
      id: 'roaming:scanning',
      name: '拉取漫游消息',
      kind: '漫游拉取',
      status: 'running',
      statusLabel: '检查缺失消息',
      icon: <CloudDownload size={16} />,
      detail: (
        <TaskProgressDetails
          name="拉取漫游消息"
          status="running"
          statusLabel="检查缺失消息"
          note="正在检查所选范围内的本地记录与候选缺口。"
        />
      ),
    });
  }
  for (const task of flash.data ?? []) {
    const running = task.status === 'resolving' || task.status === 'downloading';
    const status = task.interrupted
      ? 'paused'
      : task.status === 'done'
        ? 'completed'
        : task.status === 'resolving' || task.status === 'downloading'
          ? 'running'
          : task.status;
    const statusLabel = task.interrupted
      ? task.pausedByUser
        ? '已暂停'
        : '已中断'
      : task.status === 'resolving'
        ? '获取链接'
        : undefined;
    const retryLabel = task.pausedByUser
      ? '继续剩余文件'
      : task.interrupted
        ? '重试未完成文件'
        : '重试下载';
    const single = (task.files?.length ?? 1) === 1;
    const display = {
      action: '下载闪传文件',
      subject: single ? task.name : `${task.files!.length} 个文件`,
      numericSubject: !single,
      fileName: single,
    };
    const retryFlash = async () => {
      if (!cleanupBinding) return;
      const retried = await client.account.flashRetryDownloadTask.mutate({
        ...cleanupBinding,
        taskId: task.id,
      });
      await utils.account.flashListDownloadTasks.invalidate();
      if (!retried) showInfo('暂时无法重试', '下载仍在收尾或任务状态已变化，请查看最新任务状态。');
    };
    const flashFiles = task.files ?? [task];
    const takeFlash = async (fileId?: string) => {
      if (!cleanupBinding || openingFlashRef.current) return;
      openingFlashRef.current = task.id;
      setOpeningFlash(task.id);
      const isCurrent = () =>
        mounted.current &&
        bindingRef.current?.expectedAccountUin === cleanupBinding.expectedAccountUin &&
        bindingRef.current?.expectedAccountConfigId === cleanupBinding.expectedAccountConfigId;
      try {
        await downloadFlashToDevice({ ...cleanupBinding, taskId: task.id, fileId }, isCurrent);
      } catch (error) {
        if (isCurrent())
          showInfo('下载失败', error instanceof Error ? error.message : String(error));
      } finally {
        openingFlashRef.current = null;
        if (mounted.current) setOpeningFlash(null);
      }
    };
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
      running || task.status === 'pending' || task.interrupted
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
    if (task.canRetry)
      actions.unshift({
        id: 'retry',
        label: retryLabel,
        icon: <RefreshCw size={14} aria-hidden />,
        disabled: !cleanupBinding,
        run: retryFlash,
      });
    if (running || task.status === 'pending')
      actions.unshift({
        id: 'pause',
        label: '暂停下载',
        icon: <Pause size={14} />,
        disabled: !cleanupBinding,
        run: async () => {
          if (!cleanupBinding) return;
          await client.account.flashPauseDownloadTask.mutate({
            ...cleanupBinding,
            taskId: task.id,
          });
          await utils.account.flashListDownloadTasks.invalidate();
        },
      });
    if (IS_WEB && flashFiles.some((file) => file.status === 'done'))
      actions.unshift({
        id: 'download',
        label: single ? '下载到此设备' : '下载已完成文件',
        icon: <Download size={14} />,
        disabled: !cleanupBinding || Boolean(openingFlash),
        run: () => takeFlash(),
      });
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
      name: taskDisplayTitle(display),
      display,
      createdAt: task.createdAt,
      kind: '闪传下载',
      status,
      statusLabel,
      progress:
        task.status === 'done'
          ? 100
          : task.fileSize > 0
            ? (task.downloadedBytes / task.fileSize) * 100
            : undefined,
      note: single ? task.filesetName : `${task.filesetName} · ${formatSize(task.fileSize)}`,
      metrics: `${formatSize(task.downloadedBytes)} / ${formatSize(task.fileSize)}`,
      icon: <Download size={16} />,
      quickActions: <TaskQuickActions actions={actions} />,
      detail: (
        <div>
          <TaskProgressDetails
            name={task.name}
            display={display}
            status={status}
            statusLabel={statusLabel}
            progress={
              task.status === 'done'
                ? 100
                : task.fileSize > 0
                  ? (task.downloadedBytes / task.fileSize) * 100
                  : undefined
            }
            note={task.error ? '下载未完成，原因见下方明细。' : undefined}
            startedAt={task.createdAt}
            finishedAt={task.finishedAt}
            actions={
              <TaskQuickActions
                variant="detail"
                actions={actions.map((action) =>
                  action.id === 'reveal' && task.canRetry ? { ...action, secondary: true } : action,
                )}
              />
            }
          />
          <p>
            {task.filesetName} · 已完成{' '}
            <span className="weq-number weq-number-inherit">
              {task.files?.filter((file) => file.status === 'done').length ??
                (task.status === 'done' ? 1 : 0)}
            </span>{' '}
            / <span className="weq-number weq-number-inherit">{task.files?.length ?? 1}</span>{' '}
            个文件
          </p>
          {(task.files?.length ?? 1) === 1 ? <p>{task.targetPath}</p> : null}
          <ul className="weq-flash-task-files" aria-label="下载文件">
            {flashFiles.map((file) => (
              <li key={file.id}>
                <span title={file.targetPath}>{file.relativePath}</span>
                {IS_WEB && !single && file.status === 'done' && (
                  <button
                    type="button"
                    className="weq-set-btn"
                    disabled={!cleanupBinding || Boolean(openingFlash)}
                    aria-label={`下载 ${file.relativePath} 到此设备`}
                    onClick={() => void takeFlash(file.id)}
                  >
                    <Download size={14} aria-hidden />
                  </button>
                )}
                <span>
                  {file.interrupted
                    ? file.pausedByUser
                      ? '已暂停'
                      : '已中断'
                    : {
                        pending: '等待中',
                        resolving: '获取链接',
                        downloading: '下载中',
                        done: '已完成',
                        failed: '失败',
                        cancelled: '已取消',
                      }[file.status]}{' '}
                  ·{' '}
                  <span className="weq-number weq-number-inherit">
                    {formatSize(file.downloadedBytes)}
                  </span>{' '}
                  /{' '}
                  <span className="weq-number weq-number-inherit">{formatSize(file.fileSize)}</span>
                </span>
                <TaskProgressBar
                  value={
                    file.status === 'done'
                      ? 100
                      : file.fileSize > 0
                        ? Math.min(100, (file.downloadedBytes / file.fileSize) * 100)
                        : undefined
                  }
                  label={`${file.relativePath}下载进度`}
                  status={
                    file.interrupted
                      ? 'paused'
                      : file.status === 'downloading' || file.status === 'resolving'
                        ? 'running'
                        : file.status
                  }
                />
                {[...new Set([...(file.resolutionErrors ?? []), file.error].filter(Boolean))].map(
                  (message) => (
                    <p role="alert" key={message}>
                      {message}
                    </p>
                  ),
                )}
              </li>
            ))}
          </ul>
          <FlashTaskLog
            key={`${cleanupBinding?.expectedAccountUin}:${cleanupBinding?.expectedAccountConfigId}:${task.id}`}
            taskId={task.id}
            version={task.logVersion}
            binding={cleanupBinding}
          />
        </div>
      ),
    });
  }
  const desktopOnlyIds = new Set<string>();
  for (const entry of background.tasks) {
    const task = entry.task;
    const canManageTask = !IS_WEB || task.kind !== 'update';
    if (!canManageTask) desktopOnlyIds.add(backgroundTaskId(entry));
    const display = backgroundTaskDisplay(task);
    const Icon = BACKGROUND_TASK_ICONS[task.kind];
    const actions: TaskQuickAction[] = (canManageTask ? task.actions : [])
      .filter((action) => action.id !== 'view-clone' || Boolean(onOpenClone))
      .map((action) => ({
        id: action.id,
        label: action.label,
        icon: <BackgroundTaskActionIcon id={action.id} />,
        run: async () => {
          if (action.id === 'view-clone' && task.clonePersonaId)
            return onOpenClone?.(task.clonePersonaId);
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
    const navigation = backgroundTaskNavigation(task);
    if (navigation) actions.unshift(navigation);
    if (canManageTask && task.status !== 'running')
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
    const clone = clones.find(
      (item) =>
        item.accountId === accountId &&
        item.personaId === task.clonePersonaId &&
        (task.status === 'running'
          ? item.status === 'running'
          : task.status === 'completed'
            ? item.status === 'done'
            : item.status === 'error'),
    );
    items.push({
      id: backgroundTaskId(entry),
      name: taskDisplayTitle(display),
      display,
      createdAt: task.startedAt,
      kind:
        display.category ??
        (task.kind === 'model' && task.destination === 'enhancement-packs'
          ? '增强包'
          : BACKGROUND_TASK_LABELS[task.kind]),
      status: task.status,
      statusLabel: task.statusLabel,
      progress: task.progress,
      note: display.context,
      metrics: task.kind === 'contacts' && task.status !== 'failed' ? task.note : undefined,
      icon: <Icon size={16} />,
      quickActions: actions.length ? <TaskQuickActions actions={actions} /> : null,
      detail: (
        <BackgroundTaskDetails
          key={task.id}
          entry={entry}
          scope={background.scope}
          refresh={() => background.query.refetch()}
          onOpenClone={onOpenClone}
          cloneLog={
            clone ? (
              <CloneTaskLog key={`${clone.personaId}:${clone.revision}`} task={clone} />
            ) : undefined
          }
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
      if (paged) {
        setCleanupMenu(null);
        useWorkspaceMenu.setState({ taskFocusId: null });
      }
    }
  }, [taskFocusId, taskOpenRequest, items, paged, setSelected]);
  const loading =
    loadingExports || roaming.isLoading || flash.isLoading || background.query.isLoading;
  useEffect(() => {
    if (ordered.some((task) => task.id === selected)) return;
    if (paged) {
      if (selected && !loading && !ordered.some((task) => task.id === taskFocusId))
        setSelected(null);
    } else if (selected !== null && ordered[0]) setSelected(ordered[0].id);
  }, [selected, ordered, paged, loading, taskFocusId, setSelected]);
  const missingFocusedTask = Boolean(taskFocusId && !items.some((task) => task.id === taskFocusId));
  const selectedId =
    missingFocusedTask || selected === null
      ? null
      : ordered.some((item) => item.id === selected)
        ? selected
        : paged
          ? null
          : ordered[0]?.id;
  const running = items.filter((task) => task.status === 'running').length;
  const visible = useTabActive();
  const unreadResults = useWorkspaceMenu((state) => state.finished);
  const readTasks = useWorkspaceMenu((state) => state.readTasks);
  useLayoutEffect(() => {
    if (visible && active && !loading && unreadResults > 0) readTasks();
  }, [visible, active, loading, unreadResults, readTasks]);
  const hasError = exportError || roaming.error || flash.error || background.error;
  /** 已结束的任务都可移除；进行中、等待和可续传的暂停任务保留。 */
  const finished = items.filter((task) => !desktopOnlyIds.has(task.id) && isEnded(task));
  const cleanupDisabled = clearing || loading || !cleanupBinding || !finished.length;
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
        {
          danger: unsaved ? 'solid' : 'outline',
          okLabel: `清除 ${finished.length} 项`,
          cancelLabel: '保留',
        },
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
        else useToast.getState().push({ tone: 'success', title: summary });
      }
    } catch (error) {
      if (current()) showError('清除失败', error instanceof Error ? error.message : String(error));
    } finally {
      clearingRef.current = false;
      if (mounted.current) setClearing(false);
    }
  };
  const renderRow = (task: LongTaskItem) => (
    <Fragment
      key={`${cleanupBinding?.expectedAccountUin ?? accountId}:${cleanupBinding?.expectedAccountConfigId ?? ''}:${task.id}`}
    >
      <LongTaskRow
        task={task}
        active={task.id === selectedId}
        pageLink={paged}
        showQuickActions={layout === 'compact'}
        onSelect={() => {
          useWorkspaceMenu.setState({ taskFocusId: null });
          setSelected(layout === 'inline' && task.id === selectedId ? null : task.id);
          if (layout === 'compact') onOpenDetail?.();
        }}
      />
      {layout === 'inline' && task.id === selectedId ? (
        <div className="weq-long-task-detail">{task.detail}</div>
      ) : null}
    </Fragment>
  );
  const selectedTask = ordered.find((task) => task.id === selectedId);
  const ended = paged ? ordered.filter(isEnded) : [];
  const list = (
    <section
      className={`weq-current-tasks is-${layout}${!items.length ? ' is-empty' : ''}`}
      aria-label="当前任务列表"
    >
      {!paged ? (
        <header ref={observeCompactToolbar} className="weq-current-tasks-head">
          <div className="weq-current-tasks-summary">
            <span>
              <span className="weq-number weq-number-inherit">{items.length}</span> 项任务
              <NumericText>{running ? ` · ${running} 项进行中` : ''}</NumericText>
            </span>
            {toolbarAction}
          </div>
          <div className="weq-current-tasks-actions" data-toolbar-group="">
            <button
              data-danger="outline"
              type="button"
              className="weq-set-btn weq-set-btn-soft"
              title="清理已结束任务"
              aria-label="清理已结束任务"
              disabled={cleanupDisabled}
              onClick={() => void clearFinished()}
            >
              <Trash2 size={14} />
              <ToolbarLabel>清理已结束任务</ToolbarLabel>
            </button>
          </div>
        </header>
      ) : null}
      {exportError ? (
        <p role="alert" className="weq-current-tasks-notice">
          导出任务读取失败：{exportError}
        </p>
      ) : null}
      {missingFocusedTask ? (
        <p role="status" className="weq-current-tasks-notice">
          正在查找通知对应的任务；若记录已清理，可在下方查看其余任务。
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
      {background.error ? (
        <p role="alert" className="weq-current-tasks-notice">
          后台任务读取失败：{background.error.message}
        </p>
      ) : null}
      {!items.length && !hasError ? (
        <EmptyState compact icon={<ListTodo />} title={loading ? '读取任务中…' : '暂无任务'} />
      ) : null}
      {items.length ? (
        <div className="weq-current-task-columns">
          <div className="weq-current-task-list">
            {(paged ? ordered.filter((task) => !isEnded(task)) : ordered).map(renderRow)}
            {ended.length ? (
              <section aria-label="已结束任务">
                <header className="weq-task-ended-head">
                  <h3>
                    已结束 <NumericText>{String(ended.length)}</NumericText>
                  </h3>
                  {!cleanupDisabled ? (
                    <button
                      type="button"
                      className="weq-page-back"
                      aria-label="已结束任务操作"
                      aria-haspopup="menu"
                      aria-expanded={Boolean(cleanupMenu)}
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        setCleanupMenu({ x: rect.right, y: rect.bottom });
                      }}
                    >
                      <Ellipsis size={20} aria-hidden />
                    </button>
                  ) : null}
                </header>
                {ended.map(renderRow)}
              </section>
            ) : null}
          </div>
          {layout === 'split' ? (
            <div key={selectedId} className="weq-current-task-details" aria-label="任务步骤详情">
              {selectedTask?.detail ?? (
                <EmptyState compact icon={<ListTodo />} title="请选择任务" />
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {!paged ? (
        <div className="weq-current-tasks-results" role="group" aria-label="已结束任务">
          <span>
            <NumericText>{`${finished.length} 项已结束`}</NumericText>
          </span>
        </div>
      ) : null}
      {paged && cleanupMenu ? (
        <ConversationActionsMenu
          {...cleanupMenu}
          dropdown
          label="已结束任务操作"
          onClose={() => setCleanupMenu(null)}
          actions={[
            {
              label: '清理已结束任务',
              icon: <Trash2 size={16} aria-hidden />,
              danger: 'outline',
              disabled: cleanupDisabled,
              action: () => void clearFinished(),
            },
          ]}
        />
      ) : null}
    </section>
  );
  if (!paged) return list;
  return selectedTask ? (
    <TaskDetailPage
      key={selectedTask.id}
      title="任务详情"
      backLabel="返回当前任务"
      onBack={() => setSelected(null)}
    >
      {selectedTask.detail}
    </TaskDetailPage>
  ) : (
    <RetainedTabs snapshotKey="current-task-page" activeKey="list">
      {list}
    </RetainedTabs>
  );
}
