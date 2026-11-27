import { ToolbarLabel } from '../CompactToolbar';
import { observeCompactToolbar } from '../CompactToolbar.shared';
import { NumericText } from '../NumericText';
import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTabActive } from '../RetainedTabs.shared';
import { useWorkspaceMenu } from '../../state/workspaceMenu';
import {
  Archive,
  ArchiveRestore,
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
import { useBackgroundTasks, backgroundTaskId } from '../../hooks/useBackgroundTasks';
import { BACKGROUND_TASK_ICONS, BACKGROUND_TASK_LABELS } from './BackgroundTaskDetails.shared';
import { BackgroundTaskActionIcon, BackgroundTaskDetails } from './BackgroundTaskDetails';
import { TaskQuickActions, type TaskQuickAction } from './TaskQuickActions';
import { forgetWindowTask, localBackgroundTasks } from '../../state/backgroundTasks';
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
import { useTaskArchive, type TaskArchiveRef } from '../../hooks/useTaskArchive';
import {
  backgroundArchivePolicy,
  backgroundResumeAction,
  backgroundResult,
  exportArchivePolicy,
  flashArchivePolicy,
  flashResult,
  isTaskArchived,
  roamingArchivePolicy,
  roamingResult,
} from '../../../../shared/task_archive';
import { exportTaskResult } from '../../../../shared/export_task_result';
import { cloneTaskResult } from '../../lib/workspaceIndicators';
import { taskNotificationForeground } from '../../lib/taskNotificationPresentation';

export type TaskLayout = 'inline' | 'compact' | 'split' | 'page';

function isEnded(task: LongTaskItem) {
  return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
}

export interface ExportTaskActions {
  pause: (task: UiTask) => unknown;
  resume: (task: UiTask) => unknown;
  cancel: (task: UiTask) => unknown;
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
  archived = false,
}: {
  exports: UiTask[];
  exportError?: string;
  loadingExports?: boolean;
  renderExport: (task: UiTask, actions: TaskQuickAction[], archived: boolean) => ReactNode;
  onOpenClone?: (id: string) => void;
  autoSelectId?: string | null;
  selection?: readonly [string | null | undefined, (id: string | null) => void];
  layout?: TaskLayout;
  onOpenDetail?: () => void;
  toolbarAction?: ReactNode;
  cleanupBinding?: { expectedAccountUin: string; expectedAccountConfigId: string } | null;
  exportActions?: ExportTaskActions;
  archived?: boolean;
}) {
  const { enabled: active } = useQQReadActivity(true, { onlineOnly: false });
  const archive = useTaskArchive(cleanupBinding, active);
  const background = useBackgroundTasks(active, archive.entries);
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

  const visible = useTabActive();
  const heldResult = useRef<{ id: string; result: string } | null>(null);
  const scope = cleanupBinding
    ? JSON.stringify([cleanupBinding.expectedAccountUin, cleanupBinding.expectedAccountConfigId])
    : '';
  const scopeIsCurrent = () =>
    mounted.current &&
    bindingRef.current?.expectedAccountUin === cleanupBinding?.expectedAccountUin &&
    bindingRef.current?.expectedAccountConfigId === cleanupBinding?.expectedAccountConfigId;

  const management = new Map<
    string,
    {
      ref: TaskArchiveRef;
      isArchived: boolean;
      manual: boolean;
      auto: boolean;
    }
  >();
  const manage = (
    ref: TaskArchiveRef,
    name: string,
    policy: {
      manual: boolean;
      auto?: boolean;
      needsConfirmation?: boolean;
    },
    options: {
      onRemoved?: () => void;
      hasCachedOutput?: boolean;
      canRemove?: boolean;
      resume?: Pick<TaskQuickAction, 'label' | 'icon' | 'disabled'> & {
        refresh: () => Promise<unknown>;
      };
    } = {},
  ) => {
    const { onRemoved, hasCachedOutput, canRemove = true, resume } = options;
    const saved = archive.entries[ref.id];
    const isArchived = isTaskArchived(saved, ref.result);
    const manual = policy.manual;
    const auto = Boolean(policy.auto && !(saved?.result === ref.result && saved.restored));
    management.set(ref.id, { ref, isArchived, manual, auto });
    const actions: TaskQuickAction[] = [];
    if (!cleanupBinding || !archive.ready) return { isArchived, actions };
    if (policy.needsConfirmation && !isArchived) {
      actions.push({
        id: 'verify',
        label: '已核对结果',
        icon: <FileCheck size={14} />,
        secondary: true,
        run: async () => {
          if (!scopeIsCurrent()) return;
          if (!(await archive.change('verify', [ref])))
            showInfo('暂时无法确认', '任务状态已变化，请查看最新任务状态。');
        },
      });
    }
    if (isArchived && archived) {
      if (resume)
        actions.push({
          id: 'resume',
          label: resume.label,
          icon: resume.icon,
          disabled: resume.disabled,
          run: async () => {
            if (!scopeIsCurrent()) return;
            const resumed = await archive.resume(ref);
            if (!scopeIsCurrent()) return;
            await resume.refresh();
            if (!resumed && scopeIsCurrent())
              showInfo('暂时无法继续', '任务仍在收尾或状态已变化，请查看最新任务状态。');
          },
        });
      actions.push({
        id: 'restore',
        label: '取消归档',
        icon: <ArchiveRestore size={14} />,
        secondary: true,
        run: async () => {
          if (!scopeIsCurrent()) return;
          if (!(await archive.change('restore', [ref])))
            showInfo('暂时无法取消归档', '任务状态已变化，请查看最新任务状态。');
        },
      });
      if (canRemove)
        actions.push({
          id: 'delete',
          label: '彻底删除',
          icon: <Trash2 size={14} />,
          danger: 'outline',
          secondary: true,
          run: async () => {
            if (
              !(await confirm(
                '彻底删除任务？',
                `将删除「${name}」的记录及其专属缓存。已保存的文件和业务结果会保留。${hasCachedOutput ? ' 此任务的结果仍保存在缓存，删除后将无法从任务列表取回。' : ''}`,
                { danger: 'solid', okLabel: '彻底删除', cancelLabel: '保留' },
              )) ||
              !scopeIsCurrent()
            )
              return;
            if (!(await archive.remove(ref))) {
              if (scopeIsCurrent())
                showInfo('暂时无法删除', '任务状态已变化，请查看最新任务状态。');
              return;
            }
            onRemoved?.();
            await Promise.all([
              background.query.refetch(),
              utils.account.listExportTasks.invalidate(),
              utils.account.getExportOutputReceipt.invalidate(),
              utils.account.roamingBackfill.list.invalidate(),
              utils.account.flashListDownloadTasks.invalidate(),
            ]);
          },
        });
    } else if (!isArchived && manual) {
      actions.push({
        id: 'archive',
        label: '归档',
        icon: <Archive size={14} />,
        secondary: true,
        run: async () => {
          if (!scopeIsCurrent()) return;
          if (!(await archive.change('archive', [ref]))) {
            if (scopeIsCurrent()) showInfo('暂时无法归档', '任务状态已变化，请查看最新任务状态。');
            return;
          }
          if (scopeIsCurrent()) useWorkspaceMenu.getState().readTask(scope, ref.id, ref.result);
        },
      });
    }
    return { isArchived, actions };
  };

  const items: LongTaskItem[] = exports.map((task): LongTaskItem => {
    const display = exportTaskDisplay(task);
    const saving = task.save?.status === 'saving';
    const saveLabel = taskSaveActionLabel(task);
    const saveFailed =
      task.status === 'completed' &&
      (task.save?.status === 'failed' || task.save?.status === 'interrupted');
    const missing = (task.generatedResources?.missing ?? task.resource?.failed ?? 0) > 0;
    const resumeAction = task.canResume && {
      id: 'resume',
      label: taskResumeActionLabel(task),
      icon:
        task.resumeMode === 'restart' ? <RefreshCw size={14} aria-hidden /> : <Play size={14} />,
      disabled: saving || task.isFinalizing,
    };
    const archiveState = manage(
      exportTaskResult(task),
      taskDisplayTitle(display),
      exportArchivePolicy(task),
      {
        hasCachedOutput: task.status === 'completed' && task.save?.status !== 'saved',
        canRemove: !task.databaseRecovery,
        resume:
          task.status === 'paused' && resumeAction
            ? { ...resumeAction, refresh: () => utils.account.listExportTasks.invalidate() }
            : undefined,
      },
    );
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
      if (!archiveState.isArchived && exportActions.save && saveLabel)
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
      if (resumeAction)
        actions.push({
          ...resumeAction,
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
      detail: renderExport(task, archiveState.actions, archived || archiveState.isArchived),
      quickActions:
        actions.length || archiveState.actions.length ? (
          <TaskQuickActions
            actions={[
              ...(archived || archiveState.isArchived
                ? actions.filter((action) => !['pause', 'resume', 'cancel'].includes(action.id))
                : actions),
              ...archiveState.actions,
            ]}
          />
        ) : null,
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
    const status =
      task.status === 'done' ? 'completed' : task.status === 'error' ? 'failed' : 'running';
    const clone = manage(
      {
        id: `clone:${task.personaId}`,
        result: cloneTaskResult(task),
        receipt:
          status !== 'running'
            ? {
                id: task.personaId,
                kind: 'clone',
                name: task.name,
                display,
                status,
                note: task.error || task.phase,
                clonePersonaId: task.personaId,
                startedAt: 0,
                updatedAt: task.revision ?? 0,
              }
            : undefined,
      },
      task.name,
      { manual: status !== 'running' },
      {
        onRemoved: () => {
          if (getCloneTasks().includes(task)) dismissCloneTask(task.personaId);
        },
      },
    );
    actions.push(...clone.actions);
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
    const resumeAction = ['planned', 'paused', 'failed', 'partial', 'cancelled'].includes(
      job.status,
    )
      ? {
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
        }
      : undefined;
    if (resumeAction) actions.push(resumeAction);
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
    const jobArchive = manage(
      { id: `roaming:${job.id}`, result: roamingResult(job) },
      taskDisplayTitle(display),
      { manual: roamingArchivePolicy(job.status) },
      {
        resume: job.status === 'paused' && resumeAction ? { ...resumeAction, refresh } : undefined,
      },
    );
    const rowActions =
      archived || jobArchive.isArchived ? jobArchive.actions : [...actions, ...jobArchive.actions];
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
          <RoamingBackfillPanel
            surface="tasks"
            taskId={job.id}
            managementActions={jobArchive.actions}
            archived={archived || jobArchive.isArchived}
          />
        </div>
      ),
      quickActions: <TaskQuickActions actions={rowActions} />,
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
    const flashRef = { id: `flash:${task.id}`, result: flashResult(task) };
    const downloadPolicy = flashArchivePolicy(task);
    const needsDevice = (IS_WEB || task.browserOutput) && task.status === 'done';
    const retryAction = {
      id: 'retry',
      label: retryLabel,
      icon: <RefreshCw size={14} aria-hidden />,
      disabled: !cleanupBinding,
      run: retryFlash,
    };
    const flashArchive = manage(
      flashRef,
      taskDisplayTitle(display),
      { ...downloadPolicy, auto: downloadPolicy.auto && !needsDevice },
      {
        canRemove: !task.interrupted,
        resume:
          task.interrupted && task.canRetry
            ? { ...retryAction, refresh: () => utils.account.flashListDownloadTasks.invalidate() }
            : undefined,
      },
    );
    const takeFlash = async (fileId?: string) => {
      if (!cleanupBinding || openingFlashRef.current) return;
      openingFlashRef.current = task.id;
      setOpeningFlash(task.id);
      const isCurrent = () =>
        mounted.current &&
        bindingRef.current?.expectedAccountUin === cleanupBinding.expectedAccountUin &&
        bindingRef.current?.expectedAccountConfigId === cleanupBinding.expectedAccountConfigId;
      try {
        if (
          await downloadFlashToDevice({ ...cleanupBinding, taskId: task.id, fileId }, isCurrent)
        ) {
          if (!fileId && isCurrent())
            void archive.change('deliver', [flashRef]).catch(() => undefined);
        }
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
      !flashArchive.isArchived && (running || task.status === 'pending' || task.interrupted)
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
        : [];
    if (task.canRetry && !archived && !flashArchive.isArchived) actions.unshift(retryAction);
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
    actions.push(...flashArchive.actions);
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
  for (const entry of background.tasks) {
    const task = entry.task;
    const canManageTask = !IS_WEB || task.kind !== 'update';
    const display = backgroundTaskDisplay(task);
    const Icon = BACKGROUND_TASK_ICONS[task.kind];
    const taskRef = {
      id: backgroundTaskId(entry),
      result: backgroundResult(task),
      receipt:
        entry.source === 'window' &&
        (task.kind === 'forward' || task.kind === 'album-upload' || task.kind === 'send-media') &&
        task.status !== 'running'
          ? {
              ...task,
              kind: task.kind,
              status: task.status,
              logs: task.logs?.slice(-200),
              details: task.details?.slice(0, 2000).map((line) => line.slice(0, 4000)),
            }
          : undefined,
    };
    const resume = entry.source === 'host' ? backgroundResumeAction(task) : undefined;
    const taskArchive = canManageTask
      ? manage(
          taskRef,
          taskDisplayTitle(display),
          {
            ...backgroundArchivePolicy(task),
            needsConfirmation: task.needsConfirmation,
          },
          {
            resume: resume && {
              label: resume.label,
              icon: <BackgroundTaskActionIcon id={resume.id} />,
              refresh: () => background.query.refetch(),
            },
            onRemoved: () => {
              if (entry.source === 'window' && localBackgroundTasks.remove(task.id))
                forgetWindowTask(task.id);
              if (task.clonePersonaId) dismissCloneTask(task.clonePersonaId);
            },
          },
        )
      : { actions: [], isArchived: false };
    const canRun = !archived && !taskArchive.isArchived;
    const actions: TaskQuickAction[] = (canManageTask ? task.actions : [])
      .filter(
        (action) =>
          canRun ||
          ['open', 'reveal', 'view-report', 'view-clone', 'download', 'open-message'].includes(
            action.id,
          ),
      )
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
          else if (entry.source === 'host')
            await client.backgroundTasks.act.mutate({
              id: task.id,
              action: action.id,
              scope: background.scope,
            });
          await background.query.refetch();
        },
      }));
    const navigation = backgroundTaskNavigation(task);
    if (
      navigation &&
      (entry.source !== 'window' ||
        !actions.some((action) => action.id === 'open' || action.id === navigation.id))
    )
      actions.unshift(navigation);
    actions.push(...taskArchive.actions);
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
      outgoingTransfer: task.outgoingTransfer,
      transfer: task.kind === 'send-media',
      note: display.context,
      metrics:
        task.kind === 'forward' || (task.kind === 'contacts' && task.status !== 'failed')
          ? task.note
          : undefined,
      icon: <Icon size={16} />,
      quickActions: actions.length ? <TaskQuickActions actions={actions} /> : null,
      detail: (
        <BackgroundTaskDetails
          key={task.id}
          entry={entry}
          scope={background.scope}
          refresh={() => background.query.refetch()}
          onOpenClone={onOpenClone}
          managementActions={taskArchive.actions}
          archived={!canRun}
          cloneLog={
            clone ? (
              <CloneTaskLog key={`${clone.personaId}:${clone.revision}`} task={clone} />
            ) : undefined
          }
        />
      ),
    });
  }
  const visibleItems = items.filter((task) => {
    const row = management.get(task.id);
    if (
      row &&
      archive.entries[task.id]?.deleted &&
      archive.entries[task.id]?.result === row.ref.result
    )
      return false;
    return archived
      ? Boolean(row?.isArchived)
      : !row?.isArchived ||
          (task.id === selected &&
            heldResult.current?.id === task.id &&
            heldResult.current.result === row.ref.result);
  });
  const ordered = orderLongTasks(visibleItems);
  useEffect(() => {
    const request = `${taskOpenRequest}:${taskFocusId}`;
    if (
      layout !== 'compact' &&
      appliedFocus.current !== request &&
      taskFocusId &&
      ordered.some((task) => task.id === taskFocusId)
    ) {
      appliedFocus.current = request;
      setSelected(taskFocusId);
      setCleanupMenu(null);
      useWorkspaceMenu.setState({ taskFocusId: null });
    }
  }, [taskFocusId, taskOpenRequest, ordered, layout, setSelected]);
  const loading =
    loadingExports ||
    roaming.isLoading ||
    flash.isLoading ||
    background.query.isLoading ||
    !archive.ready;
  const selectedId = ordered.some((item) => item.id === selected) ? selected : null;
  const missingFocusedTask =
    layout !== 'compact' &&
    Boolean(taskFocusId && !selectedId && !items.some((task) => task.id === taskFocusId));
  const running = visibleItems.filter((task) => task.status === 'running').length;
  const selectedResult = selectedId ? management.get(selectedId) : undefined;
  const indicator = useWorkspaceMenu((state) =>
    state.taskScope === scope
      ? state.taskItems.find(
          (item) => item.id === selectedId && item.activity === 'finished' && !item.waiting,
        )?.result
      : undefined,
  );
  const acknowledge = useRef<() => void>(() => {});
  acknowledge.current = () => {
    if (!selectedResult || !scopeIsCurrent() || !taskNotificationForeground()) return;
    const { ref, auto, isArchived } = selectedResult;
    useWorkspaceMenu.getState().readTask(scope, ref.id, ref.result);
    if (
      !auto ||
      isArchived ||
      (heldResult.current?.id === ref.id && heldResult.current.result === ref.result)
    )
      return;
    heldResult.current = { id: ref.id, result: ref.result };
    void archive.change('auto', [ref]).catch((error) => {
      if (scopeIsCurrent())
        showError('未能自动归档', error instanceof Error ? error.message : String(error));
    });
  };
  useEffect(() => {
    if (
      !visible ||
      !active ||
      loading ||
      layout === 'compact' ||
      archived ||
      !selectedId ||
      !indicator ||
      indicator !== selectedResult?.ref.result
    )
      return;
    const onVisible = () => acknowledge.current();
    onVisible();
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [
    visible,
    active,
    loading,
    layout,
    archived,
    selectedId,
    indicator,
    selectedResult?.ref.result,
  ]);
  const hasError = exportError || roaming.error || flash.error || background.error || archive.error;
  const archivable = visibleItems.flatMap((task) => {
    const row = management.get(task.id);
    return isEnded(task) && row?.manual && !row.isArchived ? [row] : [];
  });
  const cleanupDisabled = clearing || loading || !cleanupBinding || !archivable.length;
  const clearFinished = async () => {
    if (clearingRef.current || cleanupDisabled) return;
    clearingRef.current = true;
    setClearing(true);
    try {
      const changed = await archive.change(
        'archive',
        archivable.map(({ ref }) => ref),
      );
      if (!scopeIsCurrent()) return;
      useToast.getState().push({
        tone: 'success',
        title: `已归档 ${changed} 项任务`,
        ...(changed < archivable.length ? { detail: '其余任务状态已变化，请查看当前任务。' } : {}),
      });
    } catch (error) {
      if (scopeIsCurrent())
        showError('归档失败', error instanceof Error ? error.message : String(error));
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
          heldResult.current = null;
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
  const transfers = ordered.filter((task) => task.transfer);
  const otherTasks = ordered.filter((task) => !task.transfer);
  const ended = paged && !archived ? otherTasks.filter(isEnded) : [];
  const list = (
    <section
      className={`weq-current-tasks is-${layout}${!visibleItems.length ? ' is-empty' : ''}`}
      aria-label={archived ? '已归档任务列表' : '当前任务列表'}
    >
      {!paged ? (
        <header ref={observeCompactToolbar} className="weq-current-tasks-head">
          <div className="weq-current-tasks-summary">
            <span>
              <span className="weq-number weq-number-inherit">{visibleItems.length}</span> 项任务
              <NumericText>{running ? ` · ${running} 项进行中` : ''}</NumericText>
            </span>
            {toolbarAction}
          </div>
          {!archived ? (
            <div className="weq-current-tasks-actions" data-toolbar-group="">
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft"
                title="归档已结束任务"
                aria-label="归档已结束任务"
                disabled={cleanupDisabled}
                onClick={() => void clearFinished()}
              >
                <Archive size={14} />
                <ToolbarLabel>归档已结束任务</ToolbarLabel>
              </button>
            </div>
          ) : null}
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
      {archive.error ? (
        <p role="alert" className="weq-current-tasks-notice">
          任务归档读取失败：{archive.error.message}
        </p>
      ) : null}
      {!visibleItems.length && !hasError ? (
        <EmptyState
          compact
          icon={<ListTodo />}
          title={loading ? '读取任务中…' : archived ? '暂无已归档任务' : '暂无任务'}
        />
      ) : null}
      {visibleItems.length ? (
        <div className="weq-current-task-columns">
          <div className="weq-current-task-list">
            {transfers.length ? (
              <section aria-label="传输">
                <header className="weq-task-ended-head">
                  <h3>传输</h3>
                </header>
                {transfers.map(renderRow)}
              </section>
            ) : null}
            {(paged && !archived ? otherTasks.filter((task) => !isEnded(task)) : otherTasks).map(
              renderRow,
            )}
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
      {!paged && !archived ? (
        <div className="weq-current-tasks-results" role="group" aria-label="已结束任务">
          <span>
            <NumericText>{`${visibleItems.filter(isEnded).length} 项已结束`}</NumericText>
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
              label: '归档已结束任务',
              icon: <Archive size={16} aria-hidden />,
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
      backLabel={archived ? '返回已归档任务' : '返回当前任务'}
      onBack={() => {
        heldResult.current = null;
        setSelected(null);
      }}
    >
      {selectedTask.detail}
    </TaskDetailPage>
  ) : (
    <RetainedTabs snapshotKey="current-task-page" activeKey="list">
      {list}
    </RetainedTabs>
  );
}
