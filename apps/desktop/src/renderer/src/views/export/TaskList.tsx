/**
 * 导出任务中心（重构版）。
 *
 * 顶部一排任务小卡片：图标 + 名称 + 波浪总进度（不显示百分比），点击切换
 * 下方展示哪个任务的详情；默认选中第一个任务。
 *
 * 详情区展示该任务的每个子任务进度条（右侧只显示百分比，不显示进度名称），
 * 每个子任务进度条下方挂自己的滚动日志（Docker TUI 风格）；子任务完成后日志
 * 自动收起。任务级日志（扫描摘要 / 起止 / 错误）固定在详情底部，同样在任务
 * 完成后自动隐藏。
 */

import { useEffect, useState, type ReactElement } from 'react';
import {
  Ban,
  Bookmark,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Clock,
  Contact,
  Download,
  Globe,
  Loader2,
  Pause,
  Play,
  RotateCw,
  FileCheck,
  ExternalLink,
  FolderOpen,
  Sticker,
  Trash2,
  Users,
  UserRound,
  X,
} from 'lucide-react';
import { fmtCount } from './types';

export type StageStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed';

/** One failed media file, surfaced from a stage's `failures`. */
export interface UiFailure {
  stage: string;
  fileName: string;
  error: string;
}

export interface UiStage {
  key: string;
  label: string;
  status: StageStatus;
  current: number;
  total: number;
  failed?: number;
  note?: string;
  failures?: UiFailure[];
}

/** 一行任务日志（后端 ExportTaskManager 环形缓冲下发）。 */
export interface UiLogLine {
  ts: number;
  seq: number;
  stage: string;
  level: 'info' | 'warn' | 'error';
  text: string;
}

/** The CDN-completion stages (download missing → bundle). */
const COMPLETION_KEYS = new Set(['image', 'video', 'file', 'ptt']);

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

export interface UiTask {
  resource?: import('@weq/service').ExportTask['resource'];
  save?: import('@weq/service').ExportSaveState;
  canResume?: boolean;
  resumeMode?: 'checkpoint' | 'restart';
  reportPath?: string;
  id: string;
  kind: 'group' | 'c2c';
  name: string;
  format: string;
  /** 多格式导出（同一任务多文件；缺省 = [format]）。 */
  formats?: string[];
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  current: number;
  total: number;
  error?: string;
  filePath?: string;
  /** Set when the output is an avatar bundle folder (saved as a folder). */
  bundleDir?: string;
  /** Number of sender avatars exported into the bundle. */
  avatarCount?: number;
  /** Per-stage progress (backfill → dress → message → media → record → image …). */
  stages?: UiStage[];
  /** 每子任务的滚动日志（后端下发）。 */
  logs?: UiLogLine[];
  /** 商城表情批量下载任务：隐藏格式标签、计数单位用「张」而非「条」。 */
  isMarketPack?: boolean;
  /** 导出表情包任务：隐藏格式标签、计数单位用「张」。 */
  isEmojiPack?: boolean;
  /** QQ 空间导出（图标 / 类型标签用）。 */
  isQzone?: boolean;
  /** 联系人导出。 */
  isContacts?: boolean;
  /** 收藏导出。 */
  isCollection?: boolean;
  /** 频道私聊导出（guild_msg.db；无漫游消息）。 */
  isGuild?: boolean;
  isGenerated?: boolean;
  generatedResources?: { total: number; copied: number; missing: number };
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

/** 卡片波浪总进度（完成 100；排队 0）。 */
function taskPct(t: UiTask): number {
  if (t.status === 'completed') return 100;
  if (t.status === 'pending') return 0;
  return Math.min(100, Math.max(0, Math.round(t.progress)));
}

/** 任务类型标签（卡片 title / 详情 meta）。 */
function taskTypeLabel(t: UiTask): string {
  if (t.resource?.kind === 'database') return '数据库明文导出';
  if (t.resource?.kind === 'assistant-artifact') return '助手报告保存';
  if (t.resource?.kind === 'market-image') return '商城单张表情保存';
  if (t.resource?.kind === 'mail-attachment') return '邮件附件保存';
  if (t.resource?.kind === 'decoration') return '装扮资源保存';
  if (t.resource?.kind === 'qzone-albums') return '空间相册导出';
  if (t.resource?.kind === 'annual-report') return '年度报告导出';
  if (t.resource) return t.resource.kind === 'group-albums' ? '群相册导出' : '群文件导出';
  if (t.isMarketPack) return '商城表情下载';
  if (t.isEmojiPack) return '导出表情包';
  if (t.isQzone) return 'QQ 空间导出';
  if (t.isContacts) return '联系人导出';
  if (t.isCollection) return '收藏导出';
  if (t.isGuild) return '消息导出 · 频道私聊';
  if (t.isGenerated) return '本地生成对话导出';
  return t.kind === 'group' ? '消息导出 · 群聊' : '消息导出 · 私聊';
}

/** 任务类型图标（消息 / 联系人 / QQ 空间 / 收藏 / 商城表情）。 */
function taskIcon(t: UiTask): ReactElement {
  if (t.resource) return <FolderOpen size={15} />;
  if (t.isMarketPack) return <Sticker size={15} />;
  if (t.isEmojiPack) return <Sticker size={15} />;
  if (t.isQzone) return <Globe size={15} />;
  if (t.isContacts) return <Contact size={15} />;
  if (t.isCollection) return <Bookmark size={15} />;
  return t.kind === 'group' ? <Users size={15} /> : <UserRound size={15} />;
}

/** 详情 meta 用的格式标签：`HTML + JSON`。 */
function fmtFormats(t: UiTask): string {
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

/** HH:MM:SS.mmm 风格时间戳（Docker TUI 观感）。 */
function fmtLogTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
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

/** 日志终端最多展示的最近行数（新的直接把旧的刷出去，不可滚动，如 docker pull）。 */
const MAX_VISIBLE_LOGS = 5;

/**
 * 终端日志：只展示最近 {@link MAX_VISIBLE_LOGS} 行，不允许滚动，新的行把旧的
 * 顶出去（docker pull 风格）；collapsed 时高度塌陷淡出。
 */
function LogConsole({
  lines,
  collapsed,
}: {
  lines: UiLogLine[];
  collapsed: boolean;
}): ReactElement {
  const visible = lines.slice(-MAX_VISIBLE_LOGS);
  return (
    <div className={`weq-exp-log${collapsed ? ' is-hidden' : ''}`} aria-hidden={collapsed}>
      {visible.length === 0 ? (
        <div className="weq-exp-log-empty">— 暂无日志 —</div>
      ) : (
        visible.map((l) => (
          <div key={l.seq} className={`weq-exp-log-line is-${l.level}`}>
            <span className="weq-exp-log-time">{fmtLogTime(l.ts)}</span>
            <span className="weq-exp-log-text">{l.text}</span>
          </div>
        ))
      )}
    </div>
  );
}

/** 一个子任务阶段：名称 + 进度条 + 右侧百分比 + 下拉按钮（展开显示最近日志）。 */
function StageRow({
  stage,
  logs,
  onShowFailures,
}: {
  stage: UiStage;
  logs: UiLogLine[];
  onShowFailures: (failures: UiFailure[]) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const pct = stagePct(stage);
  // 运行中 / 失败时可展开日志；完成 / 跳过自动收起（按钮禁用）。
  const canOpen = stage.status === 'running' || stage.status === 'failed';
  const showLog = canOpen && open;
  const failures = stage.failures ?? [];
  return (
    <div className={`weq-exp-detail-stage is-${stage.status}`}>
      <div className="weq-exp-detail-stage-head">
        <span className="weq-exp-detail-stage-label" title={stage.note}>
          {stage.label}
        </span>
        {failures.length > 0 ? (
          <button
            type="button"
            className="weq-exp-detail-stage-failures"
            title="点击查看失败详情"
            onClick={() => onShowFailures(failures)}
          >
            失败 {fmtCount(failures.length)}
          </button>
        ) : null}
        <span className="weq-exp-detail-stage-bar">
          <span
            className={`weq-exp-detail-stage-fill${stage.status === 'running' ? ' is-active' : ''}`}
            style={{ width: `${pct}%` }}
          />
        </span>
        <span className="weq-exp-detail-stage-pct">
          {stage.status === 'pending' ? '–' : `${pct}%`}
        </span>
        <button
          type="button"
          className="weq-exp-detail-stage-toggle"
          disabled={!canOpen}
          title={canOpen ? (open ? '收起日志' : '显示最近日志') : undefined}
          aria-expanded={canOpen && open}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown size={13} className={open ? 'is-open' : ''} />
        </button>
      </div>
      <LogConsole lines={logs} collapsed={!showLog} />
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
      title={`${taskTypeLabel(task)} · ${task.name}${task.generatedResources?.missing || task.resource?.failed ? ' · 部分资源缺失' : ''}`}
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
        <span className="weq-exp-card-name">{task.name}</span>
      </span>
    </button>
  );
}

/** 选中任务的详情：子任务进度条 + 每子任务日志 + 任务级日志。 */
function TaskDetail({
  task: t,
  onPause,
  onResume,
  onReport,
  onCancel,
  onDownload,
  onOpenSaved,
  onBrowserDownload,
  onDelete,
  onShowFailures,
}: {
  task: UiTask;
  onPause: (t: UiTask) => void;
  onResume?: (t: UiTask) => void;
  onReport?: (t: UiTask) => void;
  onCancel: (t: UiTask) => void;
  onDownload: (t: UiTask) => void;
  onOpenSaved?: (t: UiTask, reveal: boolean) => void;
  onBrowserDownload?: (t: UiTask) => void;
  onDelete: (t: UiTask) => void;
  onShowFailures: (t: UiTask, failures: UiFailure[]) => void;
}): ReactElement {
  const overall = t.status === 'completed' ? 100 : Math.min(100, Math.max(0, t.progress));
  const completion = completionSummary(t.stages);
  const resourceMissing = (t.generatedResources?.missing ?? t.resource?.failed ?? 0) > 0;
  const hasCompletion = completion.ok > 0 || completion.failed > 0;
  const logs = t.logs ?? [];
  const stageLogs = (key: string): UiLogLine[] => logs.filter((l) => l.stage === key);
  const taskLogs = logs.filter((l) => l.stage === 'task');
  // 任务级日志在任务收尾后隐藏（与子任务日志一致）。
  const showTaskLog = t.status === 'running' || t.status === 'paused' || t.status === 'failed';
  const [taskLogOpen, setTaskLogOpen] = useState(false);
  // 只挂载已开始的阶段（pending 不占位），多阶段并发时多行同时 running。
  const mounted = (t.stages ?? []).filter((s) => s.status !== 'pending');

  return (
    <div className={`weq-exp-detail is-${t.status}`}>
      <header className="weq-exp-detail-head">
        <span className="weq-exp-detail-kind">{taskIcon(t)}</span>
        <div className="weq-exp-detail-title">
          <strong>{t.name}</strong>
          <span className="weq-exp-detail-meta">
            {taskTypeLabel(t)}
            {t.isMarketPack || t.isEmojiPack || t.resource ? null : ` · ${fmtFormats(t)}`}
            {' · '}
            {fmtCount(t.current)}
            {t.total > 0 ? ` / ${fmtCount(t.total)}` : ''}{' '}
            {t.resource
              ? '个文件'
              : t.isMarketPack || t.isEmojiPack
                ? '张'
                : t.isContacts
                  ? '位'
                  : '条'}
            {t.avatarCount ? ` · 含头像 ${fmtCount(t.avatarCount)}` : ''}
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
          {t.status === 'paused' && (t.isContacts || t.isGenerated || t.isQzone) && !t.canResume
            ? '暂停收尾中'
            : t.status === 'completed' && resourceMissing
              ? '已完成 · 资源缺失'
              : STATUS_LABEL[t.status]}
        </span>
        <strong className="weq-exp-detail-overall">{overall}%</strong>
        <div className="weq-exp-detail-actions">
          {t.canResume && onResume ? (
            <button
              type="button"
              title={t.resumeMode === 'restart' ? '按原范围重新执行' : '继续导出'}
              aria-label={t.resumeMode === 'restart' ? '重新执行导出' : '继续导出'}
              onClick={() => onResume(t)}
            >
              {t.resumeMode === 'restart' ? <RotateCw size={15} /> : <Play size={15} />}
            </button>
          ) : null}
          {t.reportPath && onReport ? (
            <button
              type="button"
              title="完整性报告"
              aria-label="完整性报告"
              onClick={() => onReport(t)}
            >
              <FileCheck size={15} />
            </button>
          ) : null}
          {t.status === 'running' ? (
            <button type="button" title="暂停" onClick={() => onPause(t)}>
              <Pause size={15} />
            </button>
          ) : null}
          {t.status === 'completed' ? (
            <button
              type="button"
              title={t.save?.path ? '另存到其他位置' : '保存到…'}
              disabled={t.save?.status === 'saving'}
              onClick={() => onDownload(t)}
            >
              <Download size={15} />
            </button>
          ) : null}
          {t.save?.path && onOpenSaved && (
            <>
              <button
                type="button"
                title="打开保存结果"
                aria-label="打开保存结果"
                onClick={() => onOpenSaved(t, false)}
              >
                <ExternalLink size={15} />
              </button>
              <button
                type="button"
                title="在文件夹中显示"
                aria-label="在文件夹中显示"
                onClick={() => onOpenSaved(t, true)}
              >
                <FolderOpen size={15} />
              </button>
            </>
          )}
          {t.status === 'completed' && onBrowserDownload ? (
            <button
              type="button"
              title="下载到浏览器"
              aria-label="下载到浏览器"
              onClick={() => onBrowserDownload(t)}
            >
              <Download size={15} />
            </button>
          ) : null}
          {t.status === 'paused' || t.status === 'failed' ? (
            <button type="button" title="取消" onClick={() => onCancel(t)}>
              <X size={15} />
            </button>
          ) : null}
          {t.status !== 'running' ? (
            <button
              type="button"
              title="删除导出缓存"
              disabled={t.save?.status === 'saving'}
              className="is-danger"
              onClick={() => onDelete(t)}
            >
              <Trash2 size={15} />
            </button>
          ) : null}
        </div>
      </header>
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
          生成资源已保存 {fmtCount(t.generatedResources.copied)} 项
          {resourceMissing
            ? ` · 缺失 ${fmtCount(t.generatedResources.missing)} 项，正文已保留`
            : ''}
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
            媒体补全 成功 {fmtCount(completion.ok)} · 失败 {fmtCount(completion.failed)}
          </button>
        ) : (
          <span
            className={`weq-exp-detail-complete${completion.failed > 0 ? ' is-warn' : ''}`}
            title="媒体补全结果"
          >
            媒体补全 成功 {fmtCount(completion.ok)}
            {completion.failed > 0 ? ` · 失败 ${fmtCount(completion.failed)}` : ''}
          </span>
        )
      ) : null}

      <div className="weq-exp-detail-stages">
        {mounted.map((s) => (
          <StageRow
            key={s.key}
            stage={s}
            logs={stageLogs(s.key)}
            onShowFailures={(failures) => onShowFailures(t, failures)}
          />
        ))}
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
  onReport,
  onCancel,
  onDownload,
  onOpenSaved,
  onBrowserDownload,
  onDelete,
  onShowFailures,
  onSaveAll,
  autoSelectId,
  isExpanded = false,
  onToggleExpanded,
}: {
  tasks: UiTask[];
  onPause: (t: UiTask) => void;
  onResume?: (t: UiTask) => void;
  onReport?: (t: UiTask) => void;
  onCancel: (t: UiTask) => void;
  onDownload: (t: UiTask) => void;
  onOpenSaved?: (t: UiTask, reveal: boolean) => void;
  onBrowserDownload?: (t: UiTask) => void;
  onDelete: (t: UiTask) => void;
  /** Open the failure-detail lightbox for a task's media-completion failures. */
  onShowFailures: (t: UiTask, failures: UiFailure[]) => void;
  /** 一键把全部已完成任务逐个保存（每个都弹系统路径选择）。 */
  onSaveAll?: () => void;
  /** 外部强制选中的任务 id（新任务到达时由父组件设置）。 */
  autoSelectId?: string | null;
  /** 面板展开状态（由父组件控制）。 */
  isExpanded?: boolean;
  /** 切换展开/收起。 */
  onToggleExpanded?: () => void;
}): ReactElement {
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
        <span className="weq-exp-tasks-count">{tasks.length}</span>
        {/* 收拢时显示迷你进度指示 */}
        {!isExpanded && hasTasks && runningCount > 0 ? (
          <span className="weq-exp-tasks-mini-status">
            <Loader2 size={12} className="weq-exp-spin" />
            {runningCount} 个导出中…
          </span>
        ) : !isExpanded && hasTasks && completedCount === tasks.length ? (
          <span className="weq-exp-tasks-mini-status is-done">
            <CircleCheck size={12} />
            {hasMissingResources ? '已完成 · 部分资源缺失' : '全部完成'}
          </span>
        ) : !isExpanded && hasTasks ? (
          <span className="weq-exp-tasks-mini-status">{overallProgress}%</span>
        ) : null}
        {onSaveAll && completedCount > 0 ? (
          <button
            type="button"
            className="weq-exp-tasks-save-all"
            title="逐个选择路径保存全部已完成任务"
            onClick={(e) => {
              e.stopPropagation();
              onSaveAll();
            }}
          >
            <Download size={14} />
            全部保存（{completedCount}）
          </button>
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
              task={selected}
              onPause={onPause}
              onResume={onResume}
              onReport={onReport}
              onCancel={onCancel}
              onDownload={onDownload}
              onOpenSaved={onOpenSaved}
              onBrowserDownload={onBrowserDownload}
              onDelete={onDelete}
              onShowFailures={onShowFailures}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
