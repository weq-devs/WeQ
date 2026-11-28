import { useExportTransferProgress } from '../../lib/transferActivity';
/**
 * 导出任务中心（重构版）。
 *
 * 顶部一排任务小卡片：图标 + 名称 + 波浪总进度（不显示百分比），点击切换
 * 下方展示哪个任务的详情；默认选中第一个任务。
 *
 * 详情区展示该任务的每个子任务进度条（右侧只显示百分比，不显示进度名称），
 * 每个子任务进度条下方挂自己的滚动日志（Docker TUI 风格）；子任务完成后日志
 * 自动收起，仍可手动展开。任务级日志（扫描摘要 / 起止 / 错误）固定在详情
 * 底部，任务完成后也可展开查看。
 */

import { NumericText } from '../../components/NumericText';
import { useEffect, useState, type ReactElement } from 'react';
import { TaskProgressBar } from '../../components/tasks/TaskProgressBar';
import { TaskQuickActions, type TaskQuickAction } from '../../components/tasks/TaskQuickActions';
import {
  Ban,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Clock,
  Download,
  Loader2,
  Pause,
  Play,
  FilePlus2,
  RefreshCw,
  FileCheck,
  ExternalLink,
  FolderOpen,
  Square,
  SkipForward,
} from 'lucide-react';
import { fmtCount } from './types';
import { TaskLogConsole as LogConsole } from '../../components/TaskLogConsole';
import '../../styles/chat-export-continuation.css';
import {
  DatabaseRecoveryPanel,
  type RecoveryDecision,
} from '../../components/tasks/DatabaseRecoveryPanel';
import {
  SKIPPABLE_STAGE_KEYS,
  type UiStage,
  type UiFailure,
  type UiTask,
  type UiLogLine,
  taskPct,
  taskTitle,
  taskTypeLabel,
  taskIcon,
  taskSaveActionLabel,
  isResourceDownload,
  taskResumeActionLabel,
  taskCanPause,
  taskCancelActionLabel,
} from './TaskList.shared';
import { exportTaskDisplay } from '@weq/service/task-display';
import { TaskName, TaskOriginalName } from '../../components/tasks/TaskName';

/** The CDN-completion stages (download missing → bundle). */
const COMPLETION_KEYS = new Set(['image', 'video', 'file', 'ptt']);
export type SkippableStage = (typeof SKIPPABLE_STAGE_KEYS)[number];

/** Aggregate completion (image/video/file) success / fail across a task's stages. */
function completionSummary(stages: UiStage[] | undefined): {
  ok: number;
  failed: number;
  failures: UiFailure[];
} {
  let ok = 0;
  let failed = 0;
  const failures: UiFailure[] = [];
  for (const s of stages ?? []) {
    if (!COMPLETION_KEYS.has(s.key)) continue;
    failed += s.failed ?? 0;
    // ok = total processed minus failed (only meaningful once the stage ran).
    if (s.status === 'completed') ok += Math.max(0, s.total - (s.failed ?? 0));
    if (s.failures) failures.push(...s.failures);
  }
  return { ok, failed, failures };
}

const STATUS_LABEL: Record<UiTask['status'], string> = {
  pending: '排队中',
  running: '导出中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** Percent for one stage's bar. */
function stagePct(s: UiStage): number {
  if (s.status === 'completed' || s.status === 'skipped') return 100;
  if (s.status === 'pending' || s.total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((s.current / s.total) * 100)));
}

/** 详情 meta 用的格式标签：`HTML + JSON`。 */
function fmtFormats(t: UiTask): string {
  if (t.resourceOnly) return '仅资源';
  return (t.formats?.length ? t.formats : [t.format]).join(' + ').toUpperCase();
}

function StatusIcon({ status }: { status: UiTask['status'] }): ReactElement {
  switch (status) {
    case 'running':
      return <Loader2 size={14} className="weq-exp-spin" />;
    case 'completed':
      return <CircleCheck size={14} />;
    case 'failed':
      return <CircleAlert size={14} />;
    case 'paused':
      return <Pause size={14} />;
    case 'cancelled':
      return <Ban size={14} />;
    default:
      return <Clock size={14} />;
  }
}

/**
 * 波浪填充（viewBox 0 0 32 300，元素高度 = 父级 300%，动画竖向平移一个波长
 * 即 66.67%，无缝循环）。右缘为平滑正弦曲线：波峰探出填充边界、波谷切回
 * 填充内部，整体随进度向右推进；100% 时由卡片切换为完全实色填充。
 */
const WAVE_BODY_PATH =
  'M0 0 H32 C32.5 8.3 34 16.7 34 25 C34 33.3 32.5 41.7 32 50 ' +
  'C31.5 58.3 30 66.7 30 75 C30 83.3 31.5 91.7 32 100 ' +
  'C32.5 108.3 34 116.7 34 125 C34 133.3 32.5 141.7 32 150 ' +
  'C31.5 158.3 30 166.7 30 175 C30 183.3 31.5 191.7 32 200 ' +
  'C32.5 208.3 34 216.7 34 225 C34 233.3 32.5 241.7 32 250 ' +
  'C31.5 258.3 30 266.7 30 275 C30 283.3 31.5 291.7 32 300 L0 300 Z';
/** 右缘波浪线（浪花白线）。 */
const WAVE_LINE_A_PATH =
  'M32 0 C32.5 8.3 34 16.7 34 25 C34 33.3 32.5 41.7 32 50 ' +
  'C31.5 58.3 30 66.7 30 75 C30 83.3 31.5 91.7 32 100 ' +
  'C32.5 108.3 34 116.7 34 125 C34 133.3 32.5 141.7 32 150 ' +
  'C31.5 158.3 30 166.7 30 175 C30 183.3 31.5 191.7 32 200 ' +
  'C32.5 208.3 34 216.7 34 225 C34 233.3 32.5 241.7 32 250 ' +
  'C31.5 258.3 30 266.7 30 275 C30 283.3 31.5 291.7 32 300';
/** 波浪内侧 1.5px 的并行浪线，给水面加一点层次。 */
const WAVE_LINE_B_PATH =
  'M30.5 0 C31 8.3 32.5 16.7 32.5 25 C32.5 33.3 31 41.7 30.5 50 ' +
  'C30 58.3 28.5 66.7 28.5 75 C28.5 83.3 30 91.7 30.5 100 ' +
  'C31 108.3 32.5 116.7 32.5 125 C32.5 133.3 31 141.7 30.5 150 ' +
  'C30 158.3 28.5 166.7 28.5 175 C28.5 183.3 30 191.7 30.5 200 ' +
  'C31 208.3 32.5 216.7 32.5 225 C32.5 233.3 31 241.7 30.5 250 ' +
  'C30 258.3 28.5 266.7 28.5 275 C28.5 283.3 30 291.7 30.5 300';

/** 一个子任务阶段：名称 + 进度条 + 右侧百分比 + 下拉按钮（展开显示最近日志）。 */
export function StageRow({
  stage,
  logs,
  onShowFailures,
  onSkip,
  paused = false,
  logMode = 'preview',
  failureCount = stage.failures?.length ?? 0,
}: {
  stage: UiStage;
  logs: UiLogLine[];
  onShowFailures: (failures: UiFailure[]) => void;
  onSkip?: () => void;
  paused?: boolean;
  logMode?: 'preview' | 'expanded';
  failureCount?: number;
}): ReactElement {
  const [open, setOpen] = useState(logMode === 'expanded');
  const pct = stagePct(stage);
  // 完成 / 跳过时自动收起，但保留手动展开入口。
  const canOpen = stage.status !== 'pending';
  useEffect(() => {
    if (logMode === 'preview' && (stage.status === 'completed' || stage.status === 'skipped'))
      setOpen(false);
  }, [stage.status, logMode]);
  const showLog = canOpen && open;
  const failures = stage.failures ?? [];
  return (
    <div className={`weq-exp-detail-stage is-${stage.status}`}>
      <div className="weq-exp-detail-stage-head">
        <span className="weq-exp-detail-stage-label" title={stage.note}>
          {stage.label}
        </span>
        {failureCount > 0 ? (
          <button
            type="button"
            className="weq-exp-detail-stage-failures"
            title="点击查看失败详情"
            onClick={() => onShowFailures(failures)}
          >
            失败 <span className="weq-number weq-number-inherit">{fmtCount(failureCount)}</span>
          </button>
        ) : null}
        <TaskProgressBar
          className="weq-exp-detail-stage-bar"
          value={stage.status === 'running' && !stage.total ? undefined : pct}
          label={`${stage.label}进度`}
          status={paused && stage.status === 'running' ? 'paused' : stage.status}
        />
        <span className="weq-exp-detail-stage-pct">
          {stage.status === 'pending' ? (
            '–'
          ) : stage.status === 'running' && !stage.total ? (
            '处理中'
          ) : (
            <NumericText>{`${pct}%`}</NumericText>
          )}
        </span>
        <span className="weq-exp-detail-stage-actions">
          {onSkip ? (
            <button
              type="button"
              className="weq-exp-detail-stage-toggle"
              title={`跳过${stage.label}`}
              aria-label={`跳过${stage.label}`}
              onClick={onSkip}
            >
              <SkipForward size={13} />
            </button>
          ) : null}
          <button
            type="button"
            className="weq-exp-detail-stage-toggle"
            disabled={!canOpen}
            title={canOpen ? (open ? '收起日志' : '显示最近日志') : undefined}
            aria-expanded={canOpen && open}
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronDown size={13} className={showLog ? 'is-open' : ''} />
          </button>
        </span>
      </div>
      <LogConsole
        lines={logs}
        collapsed={!showLog}
        appearance={logMode === 'expanded' ? 'export' : 'default'}
      />
    </div>
  );
}

/**
 * 顶部任务小卡片：图标 + 名称同一行，边框颜色代表状态；卡片背景就是进度条
 * （主题色向右填充，右缘波浪动画，不显示百分比）。还没跑出进度的任务（排队 /
 * 刚启动）用 skeleton 占位 + shimmer 动画。
 */
function TaskCard({
  task,
  active,
  onSelect,
}: {
  task: UiTask;
  active: boolean;
  onSelect: () => void;
}): ReactElement {
  const pct = taskPct(task);
  const idle = task.status === 'pending' || (task.status === 'running' && pct <= 0);
  return (
    <button
      type="button"
      className={`weq-exp-card is-${task.status}${active ? ' is-active' : ''}`}
      onClick={onSelect}
      title={`${taskTitle(task)}${task.generatedResources?.missing || task.resource?.failed ? ' · 部分资源缺失' : ''}`}
    >
      {idle ? (
        <span className="weq-exp-card-skeleton" aria-hidden />
      ) : (
        <span
          className={`weq-exp-card-progress is-${task.status}${pct >= 100 ? ' is-full' : ''}`}
          style={{ width: `${pct}%` }}
          aria-hidden
        >
          {pct < 100 ? (
            <svg className="weq-exp-card-wavefill" viewBox="0 0 32 300" preserveAspectRatio="none">
              <path className="weq-exp-card-wavefill-body" d={WAVE_BODY_PATH} />
              <path className="weq-exp-card-wavefill-line is-a" d={WAVE_LINE_A_PATH} />
              <path className="weq-exp-card-wavefill-line is-b" d={WAVE_LINE_B_PATH} />
            </svg>
          ) : null}
        </span>
      )}
      <span className="weq-exp-card-top">
        <span className="weq-exp-card-icon">{taskIcon(task)}</span>
        <span className="weq-exp-card-name">
          <TaskName display={exportTaskDisplay(task)} />
        </span>
      </span>
    </button>
  );
}

/** 选中任务的详情：子任务进度条 + 每子任务日志 + 任务级日志。 */
function TaskDetail({
  task: t,
  onPause,
  onResume,
  onFinalize,
  onIncremental,
  onSkipStage,
  onReport,
  onCancel,
  onDownload,
  onOpenSaved,
  onBrowserDownload,
  managementActions,
  archived,
  onShowFailures,
  onDatabaseRecovery,
  foldCompletedStages = false,
}: {
  task: UiTask;
  onPause: (t: UiTask) => void;
  onResume?: (t: UiTask) => void;
  onFinalize?: (t: UiTask) => void;
  onIncremental?: (t: UiTask) => void;
  onSkipStage?: (t: UiTask, stage: SkippableStage) => void;
  onReport?: (t: UiTask) => void;
  onCancel: (t: UiTask) => void;
  onDownload: (t: UiTask) => void;
  onOpenSaved?: (t: UiTask, reveal: boolean) => void;
  onBrowserDownload?: (t: UiTask) => void;
  managementActions?: TaskQuickAction[];
  archived?: boolean;
  onShowFailures: (t: UiTask, failures: UiFailure[]) => void;
  foldCompletedStages?: boolean;
  onDatabaseRecovery?: (
    t: UiTask,
    decision: RecoveryDecision,
    skipRemaining: boolean,
  ) => Promise<void>;
}): ReactElement {
  const saving = t.save?.status === 'saving';
  const transfer = useExportTransferProgress(
    saving || (t.resource && t.status === 'running') ? t.id : undefined,
  );
  const overall = transfer
    ? transfer.percent
    : saving
      ? undefined
      : t.status === 'completed'
        ? 100
        : Math.min(100, Math.max(0, t.progress));
  const completion = completionSummary(t.stages);
  const resourceMissing = (t.generatedResources?.missing ?? t.resource?.failed ?? 0) > 0;
  const saveLabel = taskSaveActionLabel(t);
  const pauseDraining =
    t.canResume === false &&
    !t.resource &&
    !t.isMarketPack &&
    !t.isEmojiPack &&
    !t.isCollection &&
    !t.isGuild;
  const hasCompletion = completion.ok > 0 || completion.failed > 0;
  const logs = t.logs ?? [];
  const stageLogs = (key: string): UiLogLine[] => logs.filter((l) => l.stage === key);
  const taskLogs = logs.filter((l) => l.stage === 'task');
  const showTaskLog =
    t.status === 'running' ||
    t.status === 'paused' ||
    t.status === 'failed' ||
    t.status === 'completed';
  const [taskLogOpen, setTaskLogOpen] = useState(false);
  useEffect(() => {
    if (t.status === 'completed' || t.status === 'cancelled') setTaskLogOpen(false);
  }, [t.status]);
  // 待执行的可跳过阶段也显示，让用户能提前略过它。
  const mounted = (t.stages ?? []).filter(
    (s) =>
      s.status !== 'pending' ||
      (onSkipStage &&
        ['running', 'paused', 'failed'].includes(t.status) &&
        (SKIPPABLE_STAGE_KEYS as readonly string[]).includes(s.key)),
  );
  const foldStage = (stage: UiStage) =>
    foldCompletedStages &&
    (stage.status === 'completed' || stage.status === 'skipped') &&
    !stage.failed &&
    !stage.failures?.length;
  const foldedStages = mounted.filter(foldStage);
  const renderStage = (s: UiStage) => (
    <StageRow
      key={s.key}
      stage={s}
      logs={stageLogs(s.key)}
      onShowFailures={(failures) => onShowFailures(t, failures)}
      onSkip={
        onSkipStage &&
        !t.isFinalizing &&
        !t.isContacts &&
        !t.isQzone &&
        !t.isGenerated &&
        !t.resource &&
        ['running', 'paused', 'failed'].includes(t.status) &&
        ['pending', 'running', 'failed'].includes(s.status) &&
        (SKIPPABLE_STAGE_KEYS as readonly string[]).includes(s.key)
          ? () => onSkipStage(t, s.key as SkippableStage)
          : undefined
      }
    />
  );

  const actions: TaskQuickAction[] = [];
  if (t.status === 'running' && taskCanPause(t)) {
    actions.push({
      id: 'pause',
      label: '暂停',
      icon: <Pause size={15} />,
      disabled: t.isFinalizing,
      run: () => onPause(t),
    });
  }
  if (t.save?.path && onOpenSaved) {
    actions.push({
      id: 'open',
      label: '打开保存结果',
      icon: <ExternalLink size={15} />,
      run: () => onOpenSaved(t, false),
    });
  }
  if (saveLabel) {
    actions.push({
      id: 'save',
      label: saveLabel,
      icon: <Download size={15} />,
      disabled: t.save?.status === 'saving',
      secondary: Boolean(t.save?.path),
      run: () => onDownload(t),
    });
  }
  if (t.canResume && onResume) {
    const resume: TaskQuickAction = {
      id: 'resume',
      label: taskResumeActionLabel(t),
      tooltip:
        t.resumeMode === 'restart' && t.status !== 'completed'
          ? isResourceDownload(t)
            ? '按原选择重新下载文件'
            : '按原范围重新执行'
          : undefined,
      icon: t.resumeMode === 'restart' ? <RefreshCw size={15} /> : <Play size={15} />,
      run: () => onResume(t),
    };
    if (t.status === 'completed') actions.push(resume);
    else actions.unshift(resume);
  }
  if (t.status === 'completed' && onBrowserDownload) {
    actions.push({
      id: 'download',
      label: '下载到浏览器',
      icon: <Download size={15} />,
      run: () => onBrowserDownload(t),
    });
  }
  if (t.status === 'paused' && (t.canFinalize || t.journalPath) && onFinalize) {
    actions.push({
      id: 'finalize',
      label: t.isFinalizing ? '收尾中' : t.partialReady ? '已收尾' : '收尾',
      icon: t.isFinalizing ? <Loader2 size={15} className="weq-exp-spin" /> : <Check size={15} />,
      disabled: !t.canResume || t.isFinalizing || t.partialReady,
      run: () => onFinalize(t),
    });
  }
  if (
    t.status === 'paused' ||
    t.status === 'failed' ||
    (!taskCanPause(t) && ['pending', 'running'].includes(t.status))
  ) {
    actions.push({
      id: 'cancel',
      label: taskCancelActionLabel(t),
      icon: <Square size={15} />,
      disabled: t.isFinalizing,
      run: () => onCancel(t),
    });
  }
  if (t.reportPath && onReport) {
    actions.push({
      id: 'report',
      label: '完整性报告',
      icon: <FileCheck size={15} />,
      run: () => onReport(t),
    });
  }
  if (t.status === 'completed' && (t.canIncremental || t.journalPath) && onIncremental) {
    actions.push({
      id: 'incremental',
      label: '增量导出',
      icon: <FilePlus2 size={15} />,
      disabled: t.save?.status === 'saving',
      run: () => onIncremental(t),
    });
  }
  if (t.save?.path && onOpenSaved) {
    actions.push({
      id: 'reveal',
      label: '在文件夹中显示',
      icon: <FolderOpen size={15} />,
      run: () => onOpenSaved(t, true),
    });
  }
  if (t.status !== 'running') {
  }

  return (
    <div className={`weq-exp-detail is-${t.status}`}>
      <header className="weq-exp-detail-head">
        <span className="weq-exp-detail-kind">{taskIcon(t)}</span>
        <div className="weq-exp-detail-title">
          <strong>
            <TaskName display={exportTaskDisplay(t)} />
          </strong>
          <TaskOriginalName name={t.name} display={exportTaskDisplay(t)} />
          <span className="weq-exp-detail-meta">
            {taskTypeLabel(t)}
            {t.isMarketPack || t.isEmojiPack || t.resource || t.resourceOnly ? null : (
              <NumericText>{` · ${fmtFormats(t)}`}</NumericText>
            )}
            {' · '}
            <span className="weq-number weq-number-inherit">{fmtCount(t.current)}</span>
            {t.total > 0 ? <NumericText>{` / ${fmtCount(t.total)}`}</NumericText> : ''}{' '}
            {t.resource
              ? '个文件'
              : t.isMarketPack || t.isEmojiPack
                ? '张'
                : t.isContacts
                  ? '位'
                  : '条'}
            {t.avatarCount ? (
              <NumericText>{` · 含头像 ${fmtCount(t.avatarCount)}`}</NumericText>
            ) : (
              ''
            )}
          </span>
        </div>
        <span
          className={`weq-exp-detail-status is-${resourceMissing && t.status === 'completed' ? 'failed' : t.status}`}
        >
          {resourceMissing && t.status === 'completed' ? (
            <CircleAlert size={14} />
          ) : (
            <StatusIcon status={t.status} />
          )}
          {transfer?.label ??
            (saving
              ? '保存中'
              : t.databaseRecovery
                ? '等待处理'
                : t.networkPaused
                  ? '省流量模式已暂停'
                  : t.isFinalizing
                    ? '收尾中'
                    : t.status === 'paused' && t.partialReady
                      ? '已收尾'
                      : t.status === 'paused' && !t.canResume
                        ? pauseDraining
                          ? '暂停收尾中'
                          : '暂停中'
                        : t.status === 'completed' && t.databaseRecoveryRecords?.length
                          ? '部分完成'
                          : t.status === 'completed' && resourceMissing
                            ? '已完成 · 资源缺失'
                            : STATUS_LABEL[t.status])}
        </span>
        {overall !== undefined ? (
          <strong className="weq-exp-detail-overall">
            <span className="weq-number weq-number-inherit">{overall}</span>%
          </strong>
        ) : null}
      </header>
      <TaskQuickActions
        variant="detail"
        actions={[
          ...(archived
            ? actions.filter(
                (action) =>
                  !['pause', 'resume', 'cancel', 'incremental', 'finalize', 'save'].includes(
                    action.id,
                  ),
              )
            : actions),
          ...(managementActions ?? []),
        ]}
      />
      <TaskProgressBar
        value={overall}
        label={`${taskTitle(t)}总进度`}
        status={t.networkPaused ? 'paused' : saving ? 'running' : t.status}
      />
      {transfer?.detail ? (
        <p>
          <NumericText>{transfer.detail}</NumericText>
        </p>
      ) : null}
      {t.databaseRecovery && onDatabaseRecovery && (
        <DatabaseRecoveryPanel
          key={t.databaseRecovery.id}
          request={t.databaseRecovery}
          name={t.name}
          onDecision={(decision, skipRemaining) => onDatabaseRecovery(t, decision, skipRemaining)}
        />
      )}
      {t.databaseRecoveryRecords?.length ? (
        <p className="weq-exp-detail-complete is-warn" role="status">
          本次导出已跳过无法读取的内容，结果不完整；未读范围见任务日志与完整性报告。
        </p>
      ) : null}
      {t.status === 'completed' ? (
        <p className="weq-export-save-status" role="status">
          {t.save?.status === 'saved'
            ? `已保存：${t.save.path}`
            : t.save?.status === 'saving'
              ? '导出已完成，正在保存并校验结果…'
              : t.save?.status === 'failed' || t.save?.status === 'interrupted'
                ? t.save.path
                  ? `本次另存未完成：${t.save.error}；上次保存：${t.save.path}`
                  : `导出已完成，尚未保存：${t.save.error}`
                : '导出已完成，结果保留在任务中，等待选择保存位置'}
        </p>
      ) : null}

      {t.status === 'completed' && t.generatedResources && t.generatedResources.total > 0 ? (
        <p
          className={`weq-exp-detail-complete${resourceMissing ? ' is-warn' : ''}`}
          role={resourceMissing ? 'alert' : 'status'}
        >
          生成资源已保存{' '}
          <span className="weq-number weq-number-inherit">
            {fmtCount(t.generatedResources.copied)}
          </span>{' '}
          项
          {resourceMissing ? (
            <NumericText>{` · 缺失 ${fmtCount(t.generatedResources.missing)} 项，正文已保留`}</NumericText>
          ) : (
            ''
          )}
        </p>
      ) : null}

      {t.mergeWarnings &&
      (t.mergeWarnings.conflictingMessages > 0 || t.mergeWarnings.sequenceGapCount > 0) ? (
        <p className="weq-exp-detail-complete is-warn" role="status">
          保留原消息，未覆盖内容不同的{' '}
          <span className="weq-number weq-number-inherit">
            {t.mergeWarnings.conflictingMessages}
          </span>{' '}
          条记录；发现{' '}
          <span className="weq-number weq-number-inherit">{t.mergeWarnings.sequenceGapCount}</span>{' '}
          段可疑序号缺口
          {t.reportPath ? '，详见完整性报告。' : '。'}
        </p>
      ) : null}
      {t.status === 'failed' && t.error ? (
        <div className="weq-exp-detail-err" title={t.error}>
          {t.error}
        </div>
      ) : null}
      {t.status === 'pending' ? (
        <div className="weq-exp-detail-queued">排队中：等待当前任务完成后再开始</div>
      ) : null}
      {hasCompletion ? (
        completion.failed > 0 && completion.failures.length > 0 ? (
          <button
            type="button"
            className="weq-exp-detail-complete is-clickable"
            title="点击查看失败详情"
            onClick={() => onShowFailures(t, completion.failures)}
          >
            媒体补全 成功{' '}
            <span className="weq-number weq-number-inherit">{fmtCount(completion.ok)}</span> · 失败{' '}
            <span className="weq-number weq-number-inherit">{fmtCount(completion.failed)}</span>
          </button>
        ) : (
          <span
            className={`weq-exp-detail-complete${completion.failed > 0 ? ' is-warn' : ''}`}
            title="媒体补全结果"
          >
            媒体补全 成功{' '}
            <span className="weq-number weq-number-inherit">{fmtCount(completion.ok)}</span>
            {completion.failed > 0 ? (
              <NumericText>{` · 失败 ${fmtCount(completion.failed)}`}</NumericText>
            ) : (
              ''
            )}
          </span>
        )
      ) : null}

      <div className="weq-exp-detail-stages">
        {mounted.filter((s) => !foldStage(s)).map(renderStage)}
        {foldedStages.length ? (
          <details className="weq-task-finished-stages">
            <summary>
              <NumericText>{`已完成或跳过 ${foldedStages.length} 个步骤`}</NumericText>
            </summary>
            {foldedStages.map(renderStage)}
          </details>
        ) : null}
      </div>

      {showTaskLog ? (
        <div className="weq-exp-detail-tasklog">
          <button
            type="button"
            className="weq-exp-detail-tasklog-head"
            aria-expanded={taskLogOpen}
            onClick={() => setTaskLogOpen((v) => !v)}
          >
            <span className="weq-exp-detail-tasklog-title">任务日志</span>
            <ChevronDown size={12} className={taskLogOpen ? 'is-open' : ''} />
          </button>
          <LogConsole lines={taskLogs} collapsed={!taskLogOpen} />
        </div>
      ) : null}
    </div>
  );
}

export function TaskList({
  tasks,
  onPause,
  onResume,
  onFinalize,
  onIncremental,
  onSkipStage,
  onReport,
  onCancel,
  onDatabaseRecovery,
  onDownload,
  onOpenSaved,
  onBrowserDownload,
  managementActions,
  archived,
  onShowFailures,
  autoSelectId,
  isExpanded = false,
  onToggleExpanded,
  detailOnly = false,
  foldCompletedStages = false,
}: {
  tasks: UiTask[];
  onPause: (t: UiTask) => void;
  onResume?: (t: UiTask) => void;
  onFinalize?: (t: UiTask) => void;
  onIncremental?: (t: UiTask) => void;
  onSkipStage?: (t: UiTask, stage: SkippableStage) => void;
  onReport?: (t: UiTask) => void;
  onCancel: (t: UiTask) => void;
  onDatabaseRecovery?: (
    t: UiTask,
    decision: RecoveryDecision,
    skipRemaining: boolean,
  ) => Promise<void>;
  onDownload: (t: UiTask) => void;
  onOpenSaved?: (t: UiTask, reveal: boolean) => void;
  onBrowserDownload?: (t: UiTask) => void;
  managementActions?: TaskQuickAction[];
  archived?: boolean;
  /** Open the failure-detail lightbox for a task's media-completion failures. */
  onShowFailures: (t: UiTask, failures: UiFailure[]) => void;
  /** 外部强制选中的任务 id（新任务到达时由父组件设置）。 */
  autoSelectId?: string | null;
  /** 面板展开状态（由父组件控制）。 */
  isExpanded?: boolean;
  /** 切换展开/收起。 */
  onToggleExpanded?: () => void;
  detailOnly?: boolean;
  foldCompletedStages?: boolean;
}): ReactElement | null {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 默认选中第一个任务；选中项被删除 / 不存在时回落到第一个。
  useEffect(() => {
    if (tasks.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !tasks.some((t) => t.id === selectedId)) setSelectedId(tasks[0]!.id);
  }, [tasks, selectedId]);

  // 外部指定新任务时，切换到该任务。
  useEffect(() => {
    if (autoSelectId && tasks.some((t) => t.id === autoSelectId)) {
      setSelectedId(autoSelectId);
    }
  }, [autoSelectId, tasks]);

  const selected = tasks.find((t) => t.id === selectedId) ?? tasks[0];
  const completedCount = tasks.filter((t) => t.status === 'completed').length;
  const hasMissingResources = tasks.some(
    (task) =>
      task.status === 'completed' &&
      (task.generatedResources?.missing ?? task.resource?.failed ?? 0) > 0,
  );
  const hasTasks = tasks.length > 0;

  // 收拢时的总进度条（所有任务的加权平均）
  const overallProgress = hasTasks
    ? Math.min(100, Math.round(tasks.reduce((sum, t) => sum + taskPct(t), 0) / tasks.length))
    : 0;
  const runningCount = tasks.filter((t) => t.status === 'running').length;

  if (detailOnly) {
    return selected ? (
      <TaskDetail
        onDatabaseRecovery={onDatabaseRecovery}
        key={selected.id}
        task={selected}
        foldCompletedStages={foldCompletedStages}
        onPause={onPause}
        onResume={onResume}
        onFinalize={onFinalize}
        onIncremental={onIncremental}
        onSkipStage={onSkipStage}
        onReport={onReport}
        onCancel={onCancel}
        onDownload={onDownload}
        onOpenSaved={onOpenSaved}
        onBrowserDownload={onBrowserDownload}
        managementActions={managementActions}
        archived={archived}
        onShowFailures={onShowFailures}
      />
    ) : null;
  }

  return (
    <section
      className={`weq-exp-tasks${isExpanded ? ' is-expanded' : ''}${!hasTasks ? ' is-empty-state' : ''}`}
    >
      <header
        className="weq-exp-tasks-head"
        onClick={onToggleExpanded}
        role={onToggleExpanded ? 'button' : undefined}
        aria-expanded={hasTasks ? isExpanded : undefined}
      >
        <span className="weq-exp-tasks-title">导出任务</span>
        <span className="weq-exp-tasks-count">
          <span className="weq-number weq-number-inherit">{tasks.length}</span>
        </span>
        {/* 收拢时显示迷你进度指示 */}
        {!isExpanded && hasTasks && runningCount > 0 ? (
          <span className="weq-exp-tasks-mini-status">
            <Loader2 size={12} className="weq-exp-spin" />
            <span className="weq-number weq-number-inherit">{runningCount}</span> 个导出中…
          </span>
        ) : !isExpanded && hasTasks && completedCount === tasks.length ? (
          <span className="weq-exp-tasks-mini-status is-done">
            <CircleCheck size={12} />
            {hasMissingResources ? '已完成 · 部分资源缺失' : '全部完成'}
          </span>
        ) : !isExpanded && hasTasks ? (
          <span className="weq-exp-tasks-mini-status">
            <span className="weq-number weq-number-inherit">{overallProgress}</span>%
          </span>
        ) : null}
        {hasTasks && onToggleExpanded ? (
          <button
            type="button"
            className="weq-exp-tasks-toggle"
            title={isExpanded ? '收起任务栏' : '展开任务栏'}
            aria-label={isExpanded ? '收起任务栏' : '展开任务栏'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpanded();
            }}
          >
            <ChevronUp size={14} />
          </button>
        ) : null}
        {/* 收拢时底部细进度条 */}
        {!isExpanded && hasTasks ? (
          <span className="weq-exp-tasks-mini-bar">
            <span
              className="weq-exp-tasks-mini-bar-fill"
              style={{ width: `${overallProgress}%` }}
            />
          </span>
        ) : null}
      </header>

      {tasks.length === 0 ? (
        <div className="weq-exp-tasks-empty">
          <Download size={26} strokeWidth={1.6} />
          <span>暂无导出任务</span>
          <small>在上方选择会话并开始导出后，任务会出现在这里</small>
        </div>
      ) : (
        <>
          <div className="weq-exp-cards">
            {tasks.map((t) => (
              <TaskCard
                key={t.id}
                task={t}
                active={t.id === selected?.id}
                onSelect={() => setSelectedId(t.id)}
              />
            ))}
          </div>
          {selected ? (
            <TaskDetail
              onDatabaseRecovery={onDatabaseRecovery}
              task={selected}
              onPause={onPause}
              onResume={onResume}
              onFinalize={onFinalize}
              onIncremental={onIncremental}
              onSkipStage={onSkipStage}
              onReport={onReport}
              onCancel={onCancel}
              onDownload={onDownload}
              onOpenSaved={onOpenSaved}
              onBrowserDownload={onBrowserDownload}
              managementActions={managementActions}
              archived={archived}
              onShowFailures={onShowFailures}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
export type { UiTask, UiStage, UiLogLine, StageStatus, UiFailure } from './TaskList.shared';
