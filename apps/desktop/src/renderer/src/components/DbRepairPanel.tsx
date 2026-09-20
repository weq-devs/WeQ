/**
 * 妙妙工具 → 数据库修复。
 *
 * 把「库坏了怎么办」收成一条自己走得完的路：**体检 → 修复**，回滚与记录另开一张灯箱卡片。
 * 后端是 `client.dbRepair.*`，编排在 `@weq/service` 的 `account/db_repair/`。
 *
 * 几条刻意的取舍：
 *
 *   1. **打开即体检，跳过只需一行小字**。用户回答不了「我的库坏没坏」，而体检是只读的，
 *      所以一进来就替他跑一遍；不想等的人点那行小字直接去选库。结论里**有问题的库**在
 *      修复页排在前面，其余收在「其他数据库」后面 —— 体检全过 / 压根没体检（跳过的）时
 *      没有「问题库」，那就全部直接铺出来，别让人连「能修哪个」都看不到。
 *   2. **一个库都没坏，就不给主按钮**。「一切健康」那一页只留一枚克制的「仍要修复」——
 *      修一个完好的库会白花一次替换（还会关掉账号），不该是一眼就能点到的主按钮。
 *   3. **库名是渲染层唯一的目标标识**。目录、密钥、算法都在主进程解析 —— 一旦接受路径，
 *      这个接口就变成任意路径写入器。
 *   4. **进度不是装饰**：一次修复约 5 秒、八个阶段，没有它就等于「点了按钮之后卡死」。
 *      阶段名用主进程报的 `message`（本来就是中文），百分比直接用 `percent`，另外把 native
 *      报的 phase 画成一条阶段轨 —— 卡住时能看出卡在哪一步。
 *   5. **中途失败必须说清源库没被动过**。服务层是「备份 → 产物 → 校验 → 替换」，任何一步
 *      失败都发生在替换之前，所以源库一个字节都没动 —— 这决定了重试是零成本的。
 *   6. **替换会先关掉正在打开的这个账号**。那一刻主进程里账号已经关了、渲染层却还停在主
 *      界面上（有会话列表、没头像、点不开消息），所以修完（或替换阶段失败）由全局的
 *      `<DbRepairReturnOverlay>` 倒数几秒回首页，面板的结果卡里同时把这句话写明。
 *   7. **颜色一律走主题 token**（警示用 `--weq-warn-*`，它本身从主题强调色派生），不另配
 *      一套颜色；按钮直接复用 `.weq-set-btn` 家族。这里只加 `weq-rp-*` 这一套面板专有的
 *      样式：结论徽章、指标格、QQ 状态条、进度轨、灯箱卡片。
 *
 * 视图类型在这里重新声明（而不是从主进程 import），与 `DatabaseDamagedDialog` 的
 * `DatabaseDamagedEvent` 同一套做法：渲染层只认「主进程答应给的那个形状」。
 */

import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  Database,
  DatabaseZap,
  FileText,
  FolderOpen,
  HardDrive,
  History,
  Info,
  KeyRound,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Square,
  Stethoscope,
  Trash2,
  Waves,
  X,
  XCircle,
} from 'lucide-react';
import { closeFromScrim } from '../im-template/template/modalUtils';
import { useOverlayLayer } from '../lib/overlayStack';
import { useDbRepairReturn } from '../state/dbRepairReturn';
import { client, trpc } from '../trpc/client';
import { QqAvatar } from './QqAvatar';
import { useToast } from './Toast';

/** 展示当前账号用的最小信息（父级已有一份，不再重复探测）。 */
export interface DbRepairAccountOption {
  uin: string;
  name: string;
  avatarUrl: string;
}

// ────────────────────────── 主进程契约的渲染层视图 ──────────────────────────

/** 与主进程 `DbRepairRecordSummary` 对齐。 */
interface DbRepairRecordView {
  id: string;
  at: string;
  dbName: string;
  state: 'applied' | 'aborted' | 'apply-failed' | 'rolled-back';
  badPages: number[];
  durationMs: number;
  beforeBytes: number;
  afterBytes: number | null;
  strictPages: boolean;
  error?: string;
  reportPath: string | null;
  canRestore: boolean;
  purgedAt?: string;
}

interface DbRepairDatabaseRowView {
  dbName: string;
  dbPath: string;
  exists: boolean;
  bytes: number | null;
  lastRecord: DbRepairRecordView | null;
}

/** 与主进程 `DbRepairAccountStatus` 对齐。 */
interface DbRepairStatusView {
  uin: string;
  dataDir: string | null;
  dbDir: string;
  keyPresent: boolean;
  qqPid: number | null;
  qqPids: number[];
  busy: boolean;
  databases: DbRepairDatabaseRowView[];
  error: string | null;
}

type DbRepairReadiness = 'ready' | 'blocked-by-qq' | 'blocked-by-other' | 'unknown-lock';

/** 与主进程 `DbRepairPreflight` 对齐（只列展示用到的字段）。 */
interface DbRepairPreflightView {
  readiness: DbRepairReadiness;
  holders: Array<{ pid: number; name: string }>;
  qqHolders: Array<{ pid: number; name: string }>;
  otherHolders: Array<{ pid: number; name: string }>;
  dbPath: string;
  dbBytes: number;
  freeBytes: number | null;
  requiredBytes: number;
  keyPresent: boolean;
  backupsKept: number;
  pendingWalBytes: number;
}

/** 与主进程 `DbRepairRestorePreview` 对齐。 */
interface DbRepairRestorePreviewView {
  backupExists: boolean;
  currentSha: string | null;
  matchesAfter: boolean;
}

/** 与主进程 `DbRepairErrorCode` 对齐（会被展示的那几种）。 */
type DbRepairFailureCode =
  | 'not-found'
  | 'no-credentials'
  | 'blocked'
  | 'insufficient-space'
  | 'busy'
  | 'changed-during-repair'
  | 'needs-confirm'
  | 'no-backup'
  | 'verify-failed'
  | 'recover-failed';

/**
 * 一次修复 / 回滚的结局。失败也是返回值（不是 throw）—— 因为只有主进程知道
 * **失败之前账号是不是已经被关掉了**（见主进程 `DbRepairTaskResult` 的长注释）。
 */
type DbRepairTaskResultView =
  | {
      ok: true;
      record: {
        id: string;
        state: DbRepairRecordView['state'];
        dbName: string;
        backupPath: string | null;
        reportPath: string | null;
        durationMs: number;
        badPages: number[];
        verification: { healthy: boolean; tables: number; indexes: number } | null;
      };
      closedAccount: boolean;
    }
  | {
      ok: false;
      code: DbRepairFailureCode;
      error: string;
      closedAccount: boolean;
    };

/** 失败标题：主进程给的是**原因**，标题只说清「这是哪一类事」。 */
const FAILURE_TITLES: Record<DbRepairFailureCode, string> = {
  blocked: '数据库还被占着，已中止',
  'changed-during-repair': '修复期间库被改动，已中止',
  'verify-failed': '修复产物自检未通过',
  'insufficient-space': '磁盘空间不够',
  'no-credentials': '拿不到数据库密钥',
  'not-found': '找不到这个数据库',
  busy: '已有修复任务在跑',
  'needs-confirm': '这个库修复后又被改过',
  'no-backup': '备份不在了',
  'recover-failed': '重建失败',
};

/** 这两类失败一定发生在替换**之前**，所以可以说「替换还没开始」（别的不能这么说）。 */
const PRE_SWAP_FAILURES: ReadonlySet<DbRepairFailureCode> = new Set([
  'blocked',
  'changed-during-repair',
] as const);

/** 与 `@weq/service` 的 `BadPageScanReport` 对齐（与设置页那份同一形状）。 */
interface BadPageScanReportView {
  dbName: string;
  dbPath: string;
  pageSize: number;
  pageCount: number;
  badPages: number[];
  zeroPages: number[];
  plaintext: boolean;
  trailingBytes: number;
  usedHmac: boolean;
  headerOffset: number;
  affected: Array<{ name: string; pagetype: string; badPageCount: number; samplePages: number[] }>;
}

/** 与主进程 `DbRepairCheckup` 对齐（一次体检的结论）。 */
interface DbRepairCheckupView {
  dbName: string;
  dbPath: string;
  bytes: number;
  /** 结构检查（`PRAGMA integrity_check`）。 */
  integrity:
    | { ran: true; healthy: boolean; corruptedTables: string[] }
    | { ran: false; error: string };
  /** 页级检查（坏页地图）。`usedHmac === false` = 跑成了但**没法判**。 */
  pages: { ran: true; report: BadPageScanReportView } | { ran: false; error: string };
  verdict: 'healthy' | 'healthy-unverified' | 'pages-bad' | 'corrupted' | 'error';
  /** 一句话结论，口径在主进程（`concludeCheckup`），这里只负责展示。 */
  summary: string;
}

// ────────────────────────── 展示用的小工具 ──────────────────────────

/** 坏页清单只显示前若干个：整份可能上千个，铺满屏幕反而看不见结论。 */
const BAD_PAGE_PREVIEW = 24;

/** 任务跑着时的轮询间隔（锁状态、QQ pid 会变）。 */
const POLL_MS = 2000;

/** 语气。没有结论的那一档是 `muted`（既不是「好」也不是「坏」），`run` 则是「正在跑」。 */
type Tone = 'ok' | 'warn' | 'muted' | 'run';

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function shortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${stamp} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 记录状态 → 徽章。`aborted` / `apply-failed` 不等于「坏了」：源库没被动过。 */
const STATE_BADGES: Record<
  DbRepairRecordView['state'],
  { label: string; tone: Tone; hint: string }
> = {
  applied: { label: '已修复', tone: 'ok', hint: '当前库就是修复产物。' },
  'rolled-back': { label: '已回滚', tone: 'muted', hint: '已经换回修复前那一份。' },
  aborted: {
    label: '已中止',
    tone: 'warn',
    hint: '替换之前就停下了（期间被写入 / 仍被占用），源库一个字节都没改，直接重试即可。',
  },
  'apply-failed': {
    label: '修复失败',
    tone: 'warn',
    hint: '重建或自检没过，发生在替换之前，源库一个字节都没改。',
  },
};

/** 体检结论 → 徽章（文案就是结论本身）。 */
function checkupBadge(row: DbRepairCheckupView): { label: string; tone: Tone } {
  switch (row.verdict) {
    case 'healthy':
      return { label: '完好', tone: 'ok' };
    case 'healthy-unverified':
      return { label: '完好 · 页未校验', tone: 'muted' };
    case 'pages-bad': {
      const count = row.pages.ran ? row.pages.report.badPages.length : 0;
      return { label: count > 0 ? `${count} 个坏页` : '有坏页', tone: 'warn' };
    }
    case 'corrupted':
      return { label: '结构损坏', tone: 'warn' };
    default:
      return { label: '无法检查', tone: 'muted' };
  }
}

/** 「这个库有问题」的唯一口径：坏页 / 结构损坏 / 检查失败。 */
function isProblemCheckup(row: DbRepairCheckupView): boolean {
  return row.verdict === 'pages-bad' || row.verdict === 'corrupted' || row.verdict === 'error';
}

/**
 * 体检调用本身失败（IPC / 账号解析不了 / 文件消失）时合成一行。
 * 列表照常渲染，不让一个库的失败把整张体检表变成一句 toast。
 */
function failedCheckup(dbName: string, error: string): DbRepairCheckupView {
  return {
    dbName,
    dbPath: '',
    bytes: 0,
    integrity: { ran: false, error },
    pages: { ran: false, error },
    verdict: 'error',
    summary: `检查没跑起来：${error}`,
  };
}

/**
 * 已经自动体检过的账号（模块级，不是组件状态）。
 *
 * 组件会在切工具页签时卸载（`activeTool` 一变就换人），用组件内的标记会在切回来时又整库
 * 读一遁。一个账号自动跑过一次就够 —— 想拿新结论自己点「重新体检」。
 */
const autoCheckedUins = new Set<string>();

/**
 * 预检结论 → 界面措辞。
 *
 * `blocked-by-qq` 才给「结束 QQ」：`blocked-by-other` 的持有者通常是 WeQ 自己
 * （当前打开着这个账号），替换前会自动关掉，不需要用户动手。
 */
const READINESS_COPY: Record<DbRepairReadiness, { label: string; tone: Tone; short: string }> = {
  ready: { label: '可以开始', tone: 'ok', short: '没有进程占用这个库，随时可以修。' },
  'blocked-by-qq': {
    label: 'QQ 正开着这个账号',
    tone: 'warn',
    short: '修复要一边解密一边读，QQ 同时写会读出撕裂的页 —— 先结束这个账号的 QQ。',
  },
  'blocked-by-other': {
    label: '有进程占用',
    tone: 'warn',
    short: '通常是 WeQ 自己打开着这个账号：替换那一步会先关掉它，修完回启动页重开即可。',
  },
  'unknown-lock': {
    label: '占用情况不明',
    tone: 'muted',
    short: '这个平台探测不到锁（权限或平台不支持）。不阻断修复，替换前会再查一次。',
  },
};

/**
 * native 报上来的修复阶段（`RecoverPhase`）加上 TS 侧补的几条，按执行顺序排。
 * 只用来画阶段轨 —— **不做百分比换算**，进度轴的唯一真相是主进程给的 `percent`。
 */
const REPAIR_STAGES: readonly { phase: string; label: string }[] = [
  { phase: 'backup', label: '备份' },
  { phase: 'Scan', label: '扫描' },
  { phase: 'Decrypt', label: '解密' },
  { phase: 'Repair', label: '重建' },
  { phase: 'Encrypt', label: '加密' },
  { phase: 'Restore', label: '回写' },
  { phase: 'Verify', label: '自检' },
  { phase: 'swapping', label: '替换' },
];

/** 一条进度推送（阶段 + 整体百分比 + 中文消息，与服务层 `emit` 一一对应）。 */
interface ProgressView {
  phase: string;
  percent: number;
  message: string;
}

/** 体检跑到哪了（进度条 + 「正在看哪个库」）。 */
interface ScanView {
  done: number;
  total: number;
  current: string | null;
}

/** 面板上的结果卡：成功 / 失败 + 账号是不是已经被关掉。 */
interface OutcomeView {
  tone: 'ok' | 'warn';
  title: string;
  detail: string;
  closedAccount: boolean;
}

// ────────────────────────── 版面零件 ──────────────────────────

/** 一枚结论徽章。语气靠底色深浅区分，不另起色相。 */
function Chip({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }): ReactElement {
  return <span className={`weq-rp-chip is-${tone}`}>{children}</span>;
}

/** 一句话提示条：语气靠左边框重量与底色区分。 */
function Note({
  tone = 'muted',
  icon,
  children,
  action,
}: {
  tone?: Tone;
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}): ReactElement {
  return (
    <div className={`weq-rp-note is-${tone}`}>
      <span className="weq-rp-note-icon" aria-hidden>
        {icon ??
          (tone === 'ok' ? (
            <CheckCircle2 size={14} strokeWidth={2} />
          ) : tone === 'warn' ? (
            <AlertTriangle size={14} strokeWidth={2} />
          ) : (
            <Info size={14} strokeWidth={2} />
          ))}
      </span>
      <span className="weq-rp-note-text">{children}</span>
      {action ? <span className="weq-rp-note-action">{action}</span> : null}
    </div>
  );
}

/** 环境检查的一格指标：标签 + 结论值 + 可选的补充。 */
function Metric({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
}): ReactElement {
  return (
    <div className={`weq-rp-metric${tone ? ` is-${tone}` : ''}`}>
      <span className="weq-rp-metric-label" aria-hidden>
        {icon}
        {label}
      </span>
      <span className="weq-rp-metric-value" title={value}>
        {value}
      </span>
      {hint ? <span className="weq-rp-metric-hint">{hint}</span> : null}
    </div>
  );
}

/** 默认收起的说明块：重点步骤保持清爽，解释文字点开再看。 */
function Disclosure({ summary, children }: { summary: string; children: ReactNode }): ReactElement {
  return (
    <details className="weq-rp-details">
      <summary>
        <ChevronDown size={13} strokeWidth={2.2} aria-hidden />
        {summary}
      </summary>
      <div className="weq-rp-details-body">{children}</div>
    </details>
  );
}

/** 顶部流程条：两页，当前页高亮、走过的打勾。 */
function Steps({ stage }: { stage: 'scan' | 'repair' }): ReactElement {
  const index = stage === 'scan' ? 0 : 1;
  const items = [
    { key: 'scan', title: '体检数据库', sub: '只读，找出坏库' },
    { key: 'repair', title: '修复', sub: '重建后替换 · 可回滚' },
  ] as const;
  return (
    <ol className="weq-rp-steps">
      {items.map((item, i) => (
        <li
          key={item.key}
          className={`weq-rp-step${i === index ? ' is-active' : i < index ? ' is-done' : ''}`}
        >
          <span className="weq-rp-step-dot" aria-hidden>
            {i < index ? <Check size={12} strokeWidth={2.8} /> : i + 1}
          </span>
          <span className="weq-rp-step-text">
            <strong>{item.title}</strong>
            <em>{item.sub}</em>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** 修复进度：当前阶段 + 百分比 + 一条轨道 + 阶段轨（卡住时能看出卡在哪一步）。 */
function RepairProgress({ progress }: { progress: ProgressView }): ReactElement {
  const activeIndex = REPAIR_STAGES.findIndex((stage) => stage.phase === progress.phase);
  return (
    <div className="weq-rp-progress" aria-live="polite">
      <div className="weq-rp-progress-head">
        <span className="weq-rp-progress-msg">
          <Loader2 size={13} strokeWidth={2.4} className="weq-spin" aria-hidden />
          {progress.message || progress.phase}
        </span>
        <span className="weq-rp-progress-pct">{progress.percent}%</span>
      </div>
      <div className="weq-rp-track">
        <div className="weq-rp-fill" style={{ width: `${progress.percent}%` }} />
      </div>
      {activeIndex >= 0 ? (
        <ol className="weq-rp-stages">
          {REPAIR_STAGES.map((stage, index) => (
            <li
              key={stage.phase}
              className={
                index < activeIndex ? 'is-done' : index === activeIndex ? 'is-active' : 'is-todo'
              }
            >
              <span className="weq-rp-stage-dot" aria-hidden />
              {stage.label}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

// ────────────────────────── 修复记录 / 回滚：灯箱卡片 ──────────────────────────

/**
 * 「修复记录 · 回滚」灯箱。
 *
 * 它刻意**不挂在修复主线里**：这条路的每一步都指向「把库修好」，而回滚与记录是回头看的
 * 东西 —— 铺在主线下面只会把主按钮挤下去。面板标题栏那枚小按钮打开它。
 *
 * 卡片 portal 到 body（`.weq-wtools-layer` 自己是一层 stacking context，留在里面反而会
 * 被后面的层盖住），z-index 走 `useOverlayLayer`，永远压在最后打开的那层之上。
 */
function HistoryLightbox({
  open,
  onClose,
  records,
  busy,
  confirming,
  preview,
  onAskRestore,
  onRestore,
  onDelete,
  onAskDelete,
  onCancelConfirm,
  onReveal,
}: {
  open: boolean;
  onClose: () => void;
  records: DbRepairRecordView[];
  busy: boolean;
  confirming: { id: string; action: 'restore' | 'delete' } | null;
  preview: DbRepairRestorePreviewView | null;
  onAskRestore: (record: DbRepairRecordView) => void;
  onRestore: (record: DbRepairRecordView, force: boolean) => void;
  onDelete: (record: DbRepairRecordView) => void;
  onAskDelete: (record: DbRepairRecordView) => void;
  onCancelConfirm: () => void;
  onReveal: (record: DbRepairRecordView, what: 'report' | 'backup') => void;
}): ReactElement | null {
  const layer = useOverlayLayer(open);

  /*
   * Escape 只关这一层：在捕获阶段吃掉，否则妙妙工具弹窗那份 document 监听会把整个工具
   * 弹窗一起关掉（两层同时响应同一个按键）。
   */
  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="weq-rp-lb-layer"
      style={{ zIndex: layer }}
      role="presentation"
      onMouseDown={closeFromScrim(onClose)}
    >
      <section
        className="weq-rp-lb"
        role="dialog"
        aria-modal="true"
        aria-label="修复记录与回滚"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="weq-rp-lb-head">
          <span className="weq-rp-lb-icon" aria-hidden>
            <History size={16} strokeWidth={1.9} />
          </span>
          <span className="weq-rp-lb-title">
            <strong>修复记录</strong>
            <em>回滚到任意一次修复之前</em>
          </span>
          {records.length > 0 ? <Chip>{records.length}</Chip> : null}
          <button type="button" className="weq-rp-x" title="关闭" onClick={onClose}>
            <X size={16} strokeWidth={2} aria-hidden />
          </button>
        </header>

        <div className="weq-rp-lb-body">
          {records.length === 0 ? (
            <div className="weq-rp-lb-empty">
              <History size={22} strokeWidth={1.6} aria-hidden />
              <span>还没有修复记录。</span>
              <em>修过之后每一次的结果都会列在这里，可以随时回滚。</em>
            </div>
          ) : (
            <ol className="weq-rp-recs">
              {records.map((record) => {
                const badge = STATE_BADGES[record.state];
                const isConfirming = confirming?.id === record.id;
                return (
                  <li
                    key={record.id}
                    className={`weq-rp-rec is-${badge.tone}${isConfirming ? ' is-confirming' : ''}`}
                  >
                    <span className="weq-rp-rec-dot" aria-hidden />
                    <div className="weq-rp-rec-main">
                      <div className="weq-rp-rec-head">
                        <span className="weq-rp-mono">{record.dbName}</span>
                        <Chip tone={badge.tone}>{badge.label}</Chip>
                        <span className="weq-rp-rec-time">{shortTime(record.at)}</span>
                      </div>
                      <div className="weq-rp-rec-meta">
                        <span>
                          {formatBytes(record.beforeBytes)} → {formatBytes(record.afterBytes)}
                        </span>
                        <span className="weq-rp-sep" aria-hidden />
                        <span>{(record.durationMs / 1000).toFixed(1)}s</span>
                        {record.badPages.length > 0 ? (
                          <>
                            <span className="weq-rp-sep" aria-hidden />
                            <span>坏页 {record.badPages.length}</span>
                          </>
                        ) : null}
                        {record.strictPages ? (
                          <>
                            <span className="weq-rp-sep" aria-hidden />
                            <span>坏页已清零</span>
                          </>
                        ) : null}
                      </div>
                      <p className="weq-rp-hint">{record.error ?? badge.hint}</p>

                      {/* 确认一律内联在这一行里 —— 位置与操作对象永远一致。 */}
                      {isConfirming && confirming?.action === 'restore' ? (
                        <div className="weq-rp-confirm">
                          {!preview?.backupExists ? (
                            <span>这条记录的备份已经被清理了，回滚不了。</span>
                          ) : preview.matchesAfter ? (
                            <span>库现在还是修复后的那一份，可以安全回滚到修复前。</span>
                          ) : (
                            <span className="is-warn">
                              警告：库在这之后又被写过（QQ 进了新消息）。回滚会把这些新内容一起 丢掉
                              —— 确认要这么做再继续。
                            </span>
                          )}
                          <div className="weq-rp-actions">
                            <button
                              type="button"
                              className="weq-set-btn weq-set-btn-sm weq-set-btn-danger"
                              disabled={!preview?.backupExists || busy}
                              onClick={() => onRestore(record, preview?.matchesAfter === false)}
                            >
                              {preview?.matchesAfter === false ? '丢弃新内容并回滚' : '确认回滚'}
                            </button>
                            <button
                              type="button"
                              className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
                              onClick={onCancelConfirm}
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : null}

                      {isConfirming && confirming?.action === 'delete' ? (
                        <div className="weq-rp-confirm">
                          <span className="is-warn">
                            删掉这条修复记录？记录与它的备份会一起被清理，之后不能再回滚到这一条。
                          </span>
                          <div className="weq-rp-actions">
                            <button
                              type="button"
                              className="weq-set-btn weq-set-btn-sm weq-set-btn-danger"
                              disabled={busy}
                              onClick={() => onDelete(record)}
                            >
                              确认删除
                            </button>
                            <button
                              type="button"
                              className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
                              onClick={onCancelConfirm}
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : null}

                      {!isConfirming ? (
                        <div className="weq-rp-actions">
                          {record.state === 'applied' && record.canRestore ? (
                            <button
                              type="button"
                              className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
                              disabled={busy}
                              onClick={() => onAskRestore(record)}
                            >
                              <RotateCcw size={12} strokeWidth={2} aria-hidden />
                              回滚
                            </button>
                          ) : null}
                          {record.reportPath ? (
                            <button
                              type="button"
                              className="weq-rp-icon-btn"
                              title="打开修复报告"
                              aria-label="打开修复报告"
                              onClick={() => onReveal(record, 'report')}
                            >
                              <FileText size={13} strokeWidth={2} aria-hidden />
                            </button>
                          ) : null}
                          {record.canRestore ? (
                            <button
                              type="button"
                              className="weq-rp-icon-btn"
                              title="打开备份所在目录"
                              aria-label="打开备份所在目录"
                              onClick={() => onReveal(record, 'backup')}
                            >
                              <FolderOpen size={13} strokeWidth={2} aria-hidden />
                            </button>
                          ) : (
                            <span className="weq-rp-hint">
                              {record.purgedAt
                                ? `备份已于 ${shortTime(record.purgedAt)} 被保留策略清理`
                                : '这条记录没有备份'}
                            </span>
                          )}
                          <button
                            type="button"
                            className="weq-rp-icon-btn is-danger"
                            disabled={busy}
                            title="删除这条记录（连同它的备份）"
                            aria-label="删除这条记录"
                            onClick={() => onAskDelete(record)}
                          >
                            <Trash2 size={13} strokeWidth={2} aria-hidden />
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

// ────────────────────────── 主面板 ──────────────────────────

export function DbRepairPanel({
  currentUin,
  accounts,
  onRefreshAccounts,
}: {
  /** 当前登录的账号 —— 这一屏**只修它**，不提供切换账号的入口。 */
  currentUin: string | null;
  /** 账号列表（只用来查当前账号的昵称 / 头像，不用于选择）。 */
  accounts: DbRepairAccountOption[];
  /** 刷新左侧那份账号列表（修复会关掉账号，pid 与在线状态都可能变）。 */
  onRefreshAccounts: () => void;
}): ReactElement {
  const pushToast = useToast((s) => s.push);
  const armReturn = useDbRepairReturn((s) => s.arm);
  const utils = trpc.useUtils();

  /** 当前在哪一页。回滚 / 记录不在这条线上（见 `<HistoryLightbox>` 的注释）。 */
  const [stage, setStage] = useState<'scan' | 'repair'>('scan');
  /**
   * 选中的库。从体检结论点某个坏库进来时会预选它；「跳过体检」进来是 null ——
   * 没有选中就没有修复按钮。
   */
  const [dbName, setDbName] = useState<string | null>(null);
  /** 体检结果：按库名记着。 */
  const [checkups, setCheckups] = useState<Record<string, DbRepairCheckupView>>({});
  /** 体检跑到哪了（标题右边那句 + 顶部进度条）。 */
  const [scan, setScan] = useState<ScanView | null>(null);
  /** 「其他数据库」是否展开：完好的库默认收在开关后面。 */
  const [showOthers, setShowOthers] = useState(false);
  /** 修复前的确认（点「开始修复」不会立刻开跑）。 */
  const [confirmRepair, setConfirmRepair] = useState(false);
  /** 正在跑的那件事（按钮据此禁用，避免同时发起两个任务）。 */
  const [busy, setBusy] = useState<'repair' | 'restore' | 'backup' | 'checkup' | 'kill' | null>(
    null,
  );
  const [progress, setProgress] = useState<ProgressView | null>(null);
  /** 一次修复之后的结果卡（含「账号已被关掉、要回启动页」）。 */
  const [outcome, setOutcome] = useState<OutcomeView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 记录灯箱是否打开。 */
  const [historyOpen, setHistoryOpen] = useState(false);
  /** 记录灯箱里的内联二次确认：哪一条、等的是哪种操作。 */
  const [confirming, setConfirming] = useState<{ id: string; action: 'restore' | 'delete' } | null>(
    null,
  );
  const [preview, setPreview] = useState<DbRepairRestorePreviewView | null>(null);

  const uin = currentUin;
  const running = busy === 'repair' || busy === 'restore';

  /** 体检的「停」开关：当前这个库跑完就不再往下走。 */
  const stopScanRef = useRef(false);

  // ── 查询 ────────────────────────────────────────────────────────────────
  const statusQuery = trpc.dbRepair.status.useQuery(
    { uin: uin ?? '' },
    { enabled: uin !== null, refetchInterval: running ? POLL_MS : false },
  );
  const status = statusQuery.data as DbRepairStatusView | undefined;
  /** 该账号的 QQ 是否在线（决定要不要盯着锁状态）。 */
  const qqOnline = (status?.qqPid ?? null) !== null;
  const preflightQuery = trpc.dbRepair.preflight.useQuery(
    { uin: uin ?? '', dbName: dbName ?? '' },
    // 没选库就不查（整段环境检查都对着某个库说话）。
    {
      enabled: uin !== null && dbName !== null,
      refetchInterval: !running && qqOnline ? POLL_MS : false,
    },
  );
  const preflight = preflightQuery.data as DbRepairPreflightView | undefined;
  const historyQuery = trpc.dbRepair.history.useQuery(
    { uin: uin ?? '' },
    { enabled: uin !== null },
  );
  const history = useMemo(
    () => (historyQuery.data ?? []) as DbRepairRecordView[],
    [historyQuery.data],
  );

  const startRepair = trpc.dbRepair.start.useMutation();
  const checkupRun = trpc.dbRepair.checkup.useMutation();
  const killQq = trpc.dbRepair.killQq.useMutation();
  const restore = trpc.dbRepair.restore.useMutation();
  const removeRecord = trpc.dbRepair.deleteRecord.useMutation();
  const backupNow = trpc.dbRepair.backup.useMutation();

  const existingDbs = useMemo(() => status?.databases ?? [], [status]);
  const liveDbs = useMemo(() => existingDbs.filter((row) => row.exists), [existingDbs]);

  /** 修完统一刷新三个查询 —— 状态、预检、历史都变了。 */
  const refreshAll = async (): Promise<void> => {
    await Promise.all([
      utils.dbRepair.status.invalidate(),
      utils.dbRepair.preflight.invalidate(),
      utils.dbRepair.history.invalidate(),
    ]);
    onRefreshAccounts();
  };

  // ── 进度订阅：只在任务跑着的时候挂着 ────────────────────────────────────
  useEffect(() => {
    if (!running || uin === null) return undefined;
    const sub = client.dbRepair.onProgress.subscribe(undefined, {
      onData: (payload) => {
        // 主进程会把所有任务的进度推给所有人，按账号 + 库名过滤。
        if (payload.uin !== uin || payload.dbName !== dbName) return;
        setProgress({ phase: payload.phase, percent: payload.percent, message: payload.message });
      },
      onError: () => {
        // 订阅断了不影响修复本身（进度条会停在最后一帧）。
      },
    });
    return () => sub.unsubscribe();
  }, [running, uin, dbName]);

  /**
   * 体检：逐个库调用主进程，**检完一个显示一个**。
   *
   * 为什么不在主进程里一把跑完：128MB 的 `nt_msg.db` 要整库读两遍（结构 + 页签名），
   * 一次调用会让面板在这几秒里什么都看不到。逐个调既能边检边看，也能中途停下。
   *
   * 单个库失败只把那一行标成「无法检查」，不弹 toast、不中断其余库 —— 体检本来就
   * 在排查「哪里不对」，让第一个错误把整张表打断反而更难用。
   */
  const runCheckup = async (names: string[]): Promise<void> => {
    if (uin === null || names.length === 0) return;
    // 手动跑过也算「这个账号体检过了」，自动那次就不用再补。
    autoCheckedUins.add(uin);
    stopScanRef.current = false;
    setBusy('checkup');
    setNotice(null);
    setScan({ done: 0, total: names.length, current: names[0] ?? null });
    try {
      for (const name of names) {
        if (stopScanRef.current) break;
        setScan((prev) => (prev ? { ...prev, current: name } : prev));
        try {
          const row = (await checkupRun.mutateAsync({ uin, dbName: name })) as DbRepairCheckupView;
          setCheckups((prev) => ({ ...prev, [name]: row }));
        } catch (error) {
          setCheckups((prev) => ({ ...prev, [name]: failedCheckup(name, errMsg(error)) }));
        }
        setScan((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
      }
    } finally {
      setScan(null);
      setBusy(null);
    }
  };

  /**
   * `runCheckup` 的最新引用：下面那个自动体检的 effect 只该依赖**状态值**，不能依赖
   * 每次渲染都换身份的 `runCheckup`（否则它每渲染就重跑一次，lint 也会报错）。
   */
  const runCheckupRef = useRef(runCheckup);
  runCheckupRef.current = runCheckup;
  /** 自动体检只跑一次的标记（切页签重挂不再重复扫，所以标记放在模块级）。 */
  const autoScanRef = useRef<string | null>(null);

  // ── 自动体检：面板一打开就先回答「有没有问题」 ──────────────────────────
  //
  // 这一屏的入口问题是「库里到底有没有问题」，而用户往往答不出来。体检是只读的，
  // 代价是几秒 I/O —— 直接替他跑，比写一句「建议先体检」有用。跳过的三种情况：没密钥
  // （跑不了）、有任务在跑（别撞车）、这个账号已经自动跑过一次。
  useEffect(() => {
    if (uin === null || autoScanRef.current === uin || autoCheckedUins.has(uin)) return;
    if (busy !== null || status?.keyPresent !== true) return;
    const targets = liveDbs.map((row) => row.dbName);
    if (targets.length === 0) return;
    autoScanRef.current = uin;
    void runCheckupRef.current(targets);
  }, [uin, busy, status, liveDbs]);

  // ── 动作 ────────────────────────────────────────────────────────────────

  /** 结束挡住这个库的 QQ 进程（pid 只取自预检报上来的 QQ 持有者）。 */
  const handleKillQq = async (): Promise<void> => {
    const holder = preflight?.qqHolders[0];
    if (!holder || uin === null || dbName === null) return;
    setBusy('kill');
    setNotice(null);
    try {
      const result = await killQq.mutateAsync({ uin, dbName, pid: holder.pid });
      if (result.released) {
        pushToast({
          tone: 'success',
          title: '已结束 QQ 进程',
          detail: `pid ${holder.pid} 已退出，库的占用也释放了（等了 ${result.waitedMs}ms）。`,
        });
      } else {
        // 杀了但还占着 —— 这就是「下一步要修也修不了」的原因，不能只写在底部。
        const text = `已结束 pid ${holder.pid}，但库仍被占用（等了 ${result.waitedMs}ms）。可能还有别的 QQ 进程或别的东西在用，先把它关掉再试。`;
        pushToast({ tone: 'warning', title: 'QQ 已结束，但库仍被占用', detail: text });
        setNotice(text);
      }
      await refreshAll();
    } catch (error) {
      const text = errMsg(error);
      pushToast({ tone: 'error', title: '结束 QQ 进程失败', detail: text });
      setNotice(text);
    } finally {
      setBusy(null);
    }
  };

  /** 库被替换 / 回滚之后旧的体检结论就不成立了 —— 清掉，别指着新库说旧结论。 */
  const forgetCheckup = (name: string): void => {
    setCheckups((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const handleBackup = async (): Promise<void> => {
    if (uin === null || dbName === null) return;
    setBusy('backup');
    setNotice(null);
    try {
      const result = await backupNow.mutateAsync({ uin, dbName });
      pushToast({
        tone: 'success',
        title: '已备份',
        detail: `${formatBytes(result.bytes)} → ${result.path}`,
      });
      await refreshAll();
    } catch (error) {
      const text = errMsg(error);
      pushToast({ tone: 'error', title: '备份失败', detail: text });
      setNotice(text);
    } finally {
      setBusy(null);
    }
  };

  /**
   * 失败的统一出口（修复与回滚共用）。
   *
   * 两件事都要做，少一件都不行：
   *
   *   1. **toast + 结果卡**：面板很长，失败说明只出现在面板里，用户很可能根本没看到
   *      （他正盯着进度条）—— 尤其是「替换阶段被拦下来」这种必须马上知道的事。
   *   2. **账号已被关掉时把人送回首页**：替换阶段的失败发生在 `releaseHandles` 之后
   *      （替换前复核 / rename / 自检），主进程里当前账号已经关了，而渲染层还停在主界面上
   *      是个坏界面（会话列表在、头像没有、点不开消息）。
   */
  const reportFailure = (
    verb: '修复' | '回滚',
    failure: Extract<DbRepairTaskResultView, { ok: false }>,
  ): void => {
    const title = FAILURE_TITLES[failure.code] ?? `${verb}失败`;
    const detail = PRE_SWAP_FAILURES.has(failure.code)
      ? `${failure.error}（替换还没开始，源库一个字节都没动）`
      : failure.error;
    pushToast({ tone: 'error', title, detail });
    setNotice(detail);
    setOutcome({
      tone: 'warn',
      title,
      detail: failure.closedAccount
        ? `${detail} · WeQ 里的这个账号已经被关掉了，回启动页重新打开再试。`
        : detail,
      closedAccount: failure.closedAccount,
    });
    if (failure.closedAccount) {
      armReturn({
        tone: 'warn',
        title: `${verb}没有完成，但 WeQ 里的账号已经被关掉了`,
        detail:
          '回到首页重新打开这个账号再试一次（现在这个界面连着的是已关闭的账号，看不到正确数据）。',
      });
    }
  };

  const handleRepair = async (): Promise<void> => {
    if (uin === null || dbName === null) return;
    // 任务期间的 `dbName` 可能被用户改掉（面板不拦），所以先把目标钉住。
    const target = dbName;
    setConfirmRepair(false);
    setBusy('repair');
    setNotice(null);
    setOutcome(null);
    setProgress({ phase: 'backup', percent: 0, message: '准备中…' });
    try {
      const result = (await startRepair.mutateAsync({
        uin,
        dbName: target,
      })) as DbRepairTaskResultView;
      // 分类好的失败是**返回值**（这样才带得回「账号是否已被关掉」），不是异常。
      if (!result.ok) {
        reportFailure('修复', result);
        return;
      }
      const record = result.record;
      const summary = [
        `坏页 ${record.badPages.length} 个已被重建排除`,
        record.verification
          ? `自检通过：${record.verification.tables} 表 / ${record.verification.indexes} 索引`
          : '自检信息缺失',
      ].join(' · ');
      const title = `修复完成（${(record.durationMs / 1000).toFixed(1)}s）`;
      setOutcome({ tone: 'ok', title, detail: summary, closedAccount: result.closedAccount });
      if (result.closedAccount) {
        // 主进程里当前账号已经被关掉了，渲染层还停在主界面上 —— 必须回首页重开。
        armReturn({
          title,
          detail: `${summary} · 替换前 WeQ 里这个账号被关掉了，重新打开后才能看到修复后的数据`,
        });
      } else {
        pushToast({ tone: 'success', title, detail: summary });
      }
      // 库已经是新的了，旧的体检结论作废。
      forgetCheckup(target);
      await refreshAll();
    } catch (error) {
      // 能到这里的只有「连服务都没进得去」的意外（例如 IPC 断了）；照样给一条 toast。
      const text = errMsg(error);
      pushToast({ tone: 'error', title: '修复请求失败', detail: text });
      setNotice(text);
    } finally {
      setProgress(null);
      setBusy(null);
    }
  };

  /** 点「回滚」：先取预览，再让那一行变成确认态。 */
  const askRestore = async (record: DbRepairRecordView): Promise<void> => {
    if (uin === null) return;
    setNotice(null);
    try {
      setPreview(
        (await utils.dbRepair.restorePreview.fetch({
          uin,
          recordId: record.id,
        })) as DbRepairRestorePreviewView,
      );
      setConfirming({ id: record.id, action: 'restore' });
    } catch (error) {
      // 取不到预览就点不了确认 —— 不说一声的话，用户会觉得「点了没反应」。
      const text = errMsg(error);
      pushToast({ tone: 'error', title: '回滚前检查失败', detail: text });
      setNotice(text);
    }
  };

  const handleRestore = async (record: DbRepairRecordView, force: boolean): Promise<void> => {
    if (uin === null) return;
    setBusy('restore');
    setNotice(null);
    try {
      const result = (await restore.mutateAsync({
        uin,
        recordId: record.id,
        force,
      })) as DbRepairTaskResultView;
      if (!result.ok) {
        reportFailure('回滚', result);
        return;
      }
      if (result.closedAccount) {
        // 回滚同样是在替换库文件，所以同样要回首页重开。
        armReturn({
          title: '已回滚到修复前',
          detail: '替换前 WeQ 里这个账号被关掉了，重新打开后才能看到回滚后的数据',
        });
      } else {
        pushToast({
          tone: 'success',
          title: '已回滚到修复前',
          detail: '库已经换回修复前的那一份。',
        });
      }
      setOutcome({
        tone: 'ok',
        title: '已回滚到修复前',
        detail: `${record.dbName} 已经换回修复前的那一份。`,
        closedAccount: result.closedAccount,
      });
      // 换回的是修复前那一份，之前那份体检结论已经不对应这个文件了。
      forgetCheckup(record.dbName);
      await refreshAll();
    } catch (error) {
      const text = errMsg(error);
      pushToast({ tone: 'error', title: '回滚请求失败', detail: text });
      setNotice(text);
    } finally {
      setConfirming(null);
      setPreview(null);
      setBusy(null);
    }
  };

  /** 彻底删掉一条历史（连同它的备份）—— 记录与备份一起消失，这条就再也回滚不了了。 */
  const handleDeleteRecord = async (record: DbRepairRecordView): Promise<void> => {
    if (uin === null) return;
    setNotice(null);
    try {
      await removeRecord.mutateAsync({ uin, recordId: record.id });
      pushToast({
        tone: 'info',
        title: '已删除这条修复记录',
        detail: '记录与它的备份都已清理，这条不能再回滚。',
      });
      await refreshAll();
    } catch (error) {
      const text = errMsg(error);
      pushToast({ tone: 'error', title: '删除记录失败', detail: text });
      setNotice(text);
    } finally {
      setConfirming(null);
    }
  };

  const reveal = async (record: DbRepairRecordView, what: 'report' | 'backup'): Promise<void> => {
    if (uin === null) return;
    try {
      if (what === 'report') {
        await client.dbRepair.revealReport.mutate({ uin, recordId: record.id });
      } else {
        await client.dbRepair.revealBackup.mutate({ uin, recordId: record.id });
      }
    } catch (error) {
      const text = errMsg(error);
      pushToast({ tone: 'error', title: '打开失败', detail: text });
      setNotice(text);
    }
  };

  /** 从体检页进修复页。带上库名 = 预选它。 */
  const goRepair = (name: string | null): void => {
    setDbName(name);
    setConfirmRepair(false);
    setNotice(null);
    setOutcome(null);
    setShowOthers(false);
    setStage('repair');
  };

  // ── 渲染 ────────────────────────────────────────────────────────────────
  if (currentUin === null || accounts.length === 0) {
    return (
      <div className="weq-wtools-state">
        没有可用的账号 —— 先在 WeQ 里登录一个账号，再回来体检 / 修复它的数据库。
      </div>
    );
  }

  const account = accounts.find((item) => item.uin === uin) ?? null;
  const checkedRows = liveDbs
    .map((row) => checkups[row.dbName])
    .filter((row): row is DbRepairCheckupView => row !== undefined);
  const problemDbs = liveDbs.filter((row) => {
    const result = checkups[row.dbName];
    return result !== undefined && isProblemCheckup(result);
  });
  const healthyCount = liveDbs.length - problemDbs.length;
  const scannedAll = liveDbs.length > 0 && checkedRows.length === liveDbs.length;
  const scanning = scan !== null;
  /** 当前选中的那一行（未选就是 null —— 修复按钮看它）。 */
  const currentRow =
    dbName === null ? null : (existingDbs.find((row) => row.dbName === dbName) ?? null);
  const currentCheckup = dbName === null ? null : (checkups[dbName] ?? null);
  const readiness = preflight ? READINESS_COPY[preflight.readiness] : null;
  const spaceShort = Boolean(
    preflight && preflight.freeBytes !== null && preflight.freeBytes < preflight.requiredBytes,
  );
  const canStart =
    uin !== null &&
    dbName !== null &&
    busy === null &&
    status?.keyPresent === true &&
    preflight !== undefined &&
    !spaceShort;
  /**
   * 修复页铺哪些库：**有问题的在前**，完好的收在「其他数据库」后面。
   * 体检全过 / 压根没体检（跳过体检进来的）时没有「问题库」，那就全部直接铺出来 ——
   * 否则用户连「能修哪个」都看不到。有问题的库在前，其余保持主进程给的顺序。
   */
  const folded = problemDbs.length > 0;
  const visibleDbs = folded && !showOthers ? problemDbs : liveDbs;

  return (
    <>
      <header className="weq-wtools-pane-head weq-rp-head">
        <div className="weq-wtools-pane-title">
          <DatabaseZap size={17} strokeWidth={1.9} />
          <h2 id="weq-wtools-title">数据库修复</h2>
        </div>
        <div className="weq-rp-head-actions">
          {account ? (
            <span className="weq-rp-account" title={account.name || account.uin}>
              <QqAvatar uin={account.uin} url={account.avatarUrl} size={20} />
              <span className="weq-rp-account-name">{account.name || account.uin}</span>
            </span>
          ) : null}
          {/* 回滚 / 记录不在这条主线上 —— 它在标题栏占一枚小按钮，点开才是一张卡片。 */}
          <button
            type="button"
            className="weq-rp-icon-btn"
            title="修复记录与回滚"
            aria-label="修复记录与回滚"
            onClick={() => {
              setHistoryOpen(true);
              setConfirming(null);
              setPreview(null);
            }}
          >
            <History size={14} strokeWidth={1.9} aria-hidden />
            {history.length > 0 ? <span className="weq-rp-dot" aria-hidden /> : null}
          </button>
          <button
            type="button"
            className="weq-rp-icon-btn"
            title="刷新状态与修复记录"
            aria-label="刷新"
            disabled={busy !== null}
            onClick={() => {
              onRefreshAccounts();
              void refreshAll();
            }}
          >
            <RefreshCw
              size={14}
              strokeWidth={1.9}
              className={busy !== null ? 'weq-spin' : ''}
              aria-hidden
            />
          </button>
        </div>
      </header>

      <Steps stage={stage} />

      {status?.error ? <Note tone="warn">{status.error}</Note> : null}
      {notice && stage === 'scan' ? (
        <Note tone="warn" icon={<AlertTriangle size={14} strokeWidth={2} />}>
          {notice}
        </Note>
      ) : null}

      {stage === 'scan' ? (
        /* ── ① 体检：打开就跑，结论直接铺出来 ─────────────────────────────── */
        <div className="weq-wtools-pane-body weq-rp-body">
          <div
            className={`weq-rp-hero is-${
              scanning ? 'scan' : problemDbs.length > 0 ? 'warn' : scannedAll ? 'ok' : 'idle'
            }`}
          >
            <span className="weq-rp-hero-icon" aria-hidden>
              {scanning ? (
                <Loader2 size={22} strokeWidth={2} className="weq-spin" />
              ) : problemDbs.length > 0 ? (
                <AlertTriangle size={22} strokeWidth={1.9} />
              ) : scannedAll ? (
                <ShieldCheck size={22} strokeWidth={1.9} />
              ) : (
                <Stethoscope size={22} strokeWidth={1.9} />
              )}
            </span>
            <div className="weq-rp-hero-main">
              <h3 className="weq-rp-hero-title">
                {scanning
                  ? '正在体检数据库'
                  : liveDbs.length === 0
                    ? '没有可体检的数据库'
                    : status?.keyPresent !== true
                      ? '拿不到数据库密钥，体检跑不了'
                      : problemDbs.length > 0
                        ? `发现 ${problemDbs.length} 个数据库有问题`
                        : scannedAll
                          ? '一切健康'
                          : '还没体检'}
              </h3>
              <p className="weq-rp-hero-sub">
                {scanning
                  ? `${scan.done} / ${scan.total} · 正在看 ${scan.current ?? '…'}`
                  : liveDbs.length === 0
                    ? '这个账号的数据库目录是空的（还没登录过 QQ，或者目录被清掉了）。'
                    : status?.keyPresent !== true
                      ? '先用 WeQ 打开一次这个账号，拿到密钥后回来重新体检。'
                      : problemDbs.length > 0
                        ? '坏库可以重建修复，没报错的库也能一起修 —— 点下面任意一行开始。'
                        : scannedAll
                          ? `${liveDbs.length} 个数据库都通过了结构与坏页检查。没坏就不用修；真要修，用右边那枚按钮。`
                          : '点右边重新体检一遍，或者直接去选库。'}
              </p>
            </div>
            <div className="weq-rp-hero-actions">
              {scanning ? (
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
                  onClick={() => {
                    stopScanRef.current = true;
                  }}
                >
                  <Square size={12} strokeWidth={2.4} aria-hidden />
                  停止
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-soft"
                    disabled={busy !== null || liveDbs.length === 0}
                    onClick={() => void runCheckup(liveDbs.map((row) => row.dbName))}
                  >
                    <Stethoscope size={14} strokeWidth={2} aria-hidden />
                    {scannedAll ? '重新体检' : '开始体检'}
                  </button>
                  {problemDbs.length > 0 ? (
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-danger"
                      disabled={busy !== null}
                      onClick={() => goRepair(problemDbs[0]!.dbName)}
                    >
                      <Play size={13} strokeWidth={2} aria-hidden />
                      去修复
                    </button>
                  ) : scannedAll ? (
                    // 「一切健康」时不给主按钮：修一个完好的库会白花一次替换（还会关掉账号），
                    // 这个入口只该是一枚克制的小按钮。
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-soft"
                      disabled={busy !== null}
                      onClick={() => goRepair(null)}
                    >
                      <Play size={13} strokeWidth={2} aria-hidden />
                      仍要修复
                    </button>
                  ) : null}
                </>
              )}
            </div>
            {scanning ? (
              <div className="weq-rp-scanbar" aria-hidden>
                <div
                  className="weq-rp-scanbar-fill"
                  style={{
                    width: `${Math.round((scan.done / Math.max(1, scan.total)) * 100)}%`,
                  }}
                />
              </div>
            ) : null}
          </div>

          {liveDbs.length > 0 ? (
            <ol className="weq-rp-list">
              {liveDbs.map((row) => {
                const result = checkups[row.dbName];
                const checking = scanning && result === undefined && scan.current === row.dbName;
                const badge = result ? checkupBadge(result) : null;
                const tone: Tone = badge ? badge.tone : 'muted';
                return (
                  <li key={row.dbName}>
                    <button
                      type="button"
                      className={`weq-rp-db is-${tone}${checking ? ' is-busy' : ''}`}
                      onClick={() => goRepair(row.dbName)}
                      title={`选 ${row.dbName} 去修复`}
                    >
                      <span className="weq-rp-db-top">
                        <span className="weq-rp-db-icon" aria-hidden>
                          {checking ? (
                            <Loader2 size={16} strokeWidth={2} className="weq-spin" />
                          ) : (
                            <Database size={16} strokeWidth={1.9} />
                          )}
                        </span>
                        {checking ? (
                          <Chip tone="run">
                            <Loader2 size={10} className="weq-spin" aria-hidden />
                            体检中
                          </Chip>
                        ) : badge ? (
                          <Chip tone={badge.tone}>{badge.label}</Chip>
                        ) : (
                          <Chip>未体检</Chip>
                        )}
                      </span>
                      <span className="weq-rp-db-name weq-rp-mono">{row.dbName}</span>
                      <span className="weq-rp-db-note">
                        {result
                          ? result.summary
                          : checking
                            ? '正在整库校验结构与页签名…'
                            : '还没体检 —— 点这张卡片可以直接去修它。'}
                      </span>
                      <span className="weq-rp-db-foot">
                        <span className="weq-rp-row-size">{formatBytes(row.bytes)}</span>
                        {row.lastRecord ? (
                          <>
                            <span className="weq-rp-sep" aria-hidden />
                            <span>上次 {shortTime(row.lastRecord.at)}</span>
                          </>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : null}

          {/* 跳过体检：一行小字，点了直接去选库（代价写在旁边）。 */}
          <div className="weq-rp-skip">
            <button type="button" className="weq-rp-link" onClick={() => goRepair(null)}>
              跳过体检，直接选数据库 →
            </button>
            <span>不体检就是盲修 —— 修之前不知道哪个库坏了、坏在哪。</span>
          </div>

          <Disclosure summary="修复会做什么">
            <p>
              修复是<strong>重建</strong>而不是打补丁：产物是全新的库（没有 freelist 空洞），
              所以页数与体积会变，这是正常的。
            </p>
            <p>
              流程是「备份 → 重建 → 校验 → 替换」，任何一步失败都发生在替换之前 ——
              <strong>源库一个字节都不会动</strong>，直接重试即可。备份默认保留最近 3 份。
            </p>
            <p>
              替换那一步会先关掉 WeQ 里正开着的这个账号，修完把你送回启动页 ——
              <strong>期间不要自己打开这个账号的 QQ</strong>。
            </p>
            <ul>
              <li>
                <strong>QQ 正开着这个账号：</strong>
                修复要先解密源库，QQ 一边写、我们一边读会读出撕裂的页 —— 得先结束这个账号的
                QQ（修复页上有那一枚按钮）。
              </li>
              <li>
                <strong>被 WeQ 自己占着：</strong>
                可以照常开始，替换那一步会先把它关掉，之后回启动页重新打开即可。
              </li>
              <li>
                <strong>未合并的预写日志：</strong>
                QQ 崩溃 / 被强杀后留下的是主文件里还没有的最后一批改动。修复会先把它（不需要
                QQ）并回主文件，这批改动会一起进产物和备份。
              </li>
            </ul>
          </Disclosure>
        </div>
      ) : (
        /* ── ② 修复：选库 → 检查环境（QQ / 占用 / 空间）→ 替换 ────────────── */
        <div className="weq-wtools-pane-body weq-rp-body">
          <div className="weq-rp-bar">
            <button type="button" className="weq-rp-back" onClick={() => setStage('scan')}>
              <ArrowLeft size={13} strokeWidth={2.2} aria-hidden />
              体检结果
            </button>
            <span className="weq-rp-hint">
              {problemDbs.length > 0
                ? `${problemDbs.length} 个库有错误（已排在前面），其余收在下面。`
                : liveDbs.length > 0 && checkedRows.length === liveDbs.length
                  ? '所有库都完好 —— 真要修哪个，从这里选一个。'
                  : '没有体检结论（跳过体检进来的），所以这里把所有库都列出来。'}
            </span>
          </div>

          {liveDbs.length === 0 ? (
            <div className="weq-rp-empty">
              <DatabaseZap size={22} strokeWidth={1.6} aria-hidden />
              <span>这个账号下没有数据库文件。</span>
            </div>
          ) : (
            <ol className="weq-rp-picks">
              {visibleDbs.map((row) => {
                const result = checkups[row.dbName];
                const bad = result !== undefined && isProblemCheckup(result);
                const badge = result ? checkupBadge(result) : null;
                const tone: Tone = badge ? badge.tone : 'muted';
                const active = row.dbName === dbName;
                return (
                  <li key={row.dbName}>
                    <button
                      type="button"
                      className={`weq-rp-pick is-${tone}${bad ? ' is-bad' : ''}${
                        active ? ' is-active' : ''
                      }`}
                      aria-pressed={active}
                      onClick={() => {
                        setDbName(row.dbName);
                        setConfirmRepair(false);
                        setNotice(null);
                        setOutcome(null);
                      }}
                    >
                      <span className="weq-rp-pick-top">
                        <span className="weq-rp-pick-icon" aria-hidden>
                          {active ? (
                            <CheckCircle2 size={16} strokeWidth={2} />
                          ) : bad ? (
                            <AlertTriangle size={16} strokeWidth={1.9} />
                          ) : (
                            <Database size={16} strokeWidth={1.9} />
                          )}
                        </span>
                        {active ? (
                          <Chip tone="ok">已选中</Chip>
                        ) : bad ? (
                          <Chip tone="warn">有错误</Chip>
                        ) : badge ? (
                          <Chip tone={badge.tone}>{badge.label}</Chip>
                        ) : (
                          <Chip>未体检</Chip>
                        )}
                      </span>
                      <span className="weq-rp-pick-name weq-rp-mono">{row.dbName}</span>
                      {/* 有错误的库在这一页是主角，所以给它一句结论；完好的只给徽章。 */}
                      <span className="weq-rp-pick-note">
                        {result ? result.summary : '还没体检过这个库。'}
                      </span>
                      <span className="weq-rp-pick-foot">
                        <span className="weq-rp-row-size">{formatBytes(row.bytes)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}

          {problemDbs.length > 0 && healthyCount > 0 ? (
            <button
              type="button"
              className="weq-rp-more"
              aria-expanded={showOthers}
              onClick={() => setShowOthers((prev) => !prev)}
            >
              <ChevronDown
                size={13}
                strokeWidth={2.2}
                className={showOthers ? 'is-flip' : ''}
                aria-hidden
              />
              {showOthers ? '收起完好的数据库' : `其他数据库（${healthyCount}）`}
            </button>
          ) : null}

          {dbName === null ? (
            <Note tone="muted" icon={<Info size={14} strokeWidth={2} />}>
              在上面点一行选一个数据库 —— 选好之后这里会显示它的环境检查与修复按钮。
            </Note>
          ) : (
            <div className="weq-rp-detail">
              <header className="weq-rp-detail-head">
                <span className="weq-rp-mono weq-rp-detail-name">{dbName}</span>
                {currentCheckup ? (
                  <Chip tone={checkupBadge(currentCheckup).tone}>
                    {checkupBadge(currentCheckup).label}
                  </Chip>
                ) : (
                  <Chip>未体检</Chip>
                )}
                <span className="weq-rp-row-size">
                  {formatBytes(currentRow?.bytes ?? preflight?.dbBytes ?? null)}
                </span>
              </header>

              {/* 环境：密钥 / 占用 / 空间 / 待合并日志 —— 决定「能不能修」。 */}
              <div className="weq-rp-metrics">
                <Metric
                  icon={<KeyRound size={12} strokeWidth={2} />}
                  label="密钥"
                  value={status ? (status.keyPresent ? '已就绪' : '缺失') : '检查中…'}
                  tone={status ? (status.keyPresent ? 'ok' : 'warn') : undefined}
                />
                <Metric
                  icon={<Lock size={12} strokeWidth={2} />}
                  label="占用"
                  value={readiness?.label ?? '检查中…'}
                  tone={readiness?.tone}
                />
                <Metric
                  icon={<HardDrive size={12} strokeWidth={2} />}
                  label="磁盘"
                  value={preflight?.freeBytes != null ? formatBytes(preflight.freeBytes) : '未知'}
                  hint={
                    preflight
                      ? `需要约 ${formatBytes(preflight.requiredBytes)}${
                          spaceShort && preflight.freeBytes !== null
                            ? `，还差 ${formatBytes(preflight.requiredBytes - preflight.freeBytes)}`
                            : ''
                        }`
                      : undefined
                  }
                  tone={spaceShort ? 'warn' : preflight ? 'ok' : undefined}
                />
                <Metric
                  icon={<Waves size={12} strokeWidth={2} />}
                  label="预写日志"
                  value={preflight ? (preflight.pendingWalBytes > 0 ? '待合并' : '无') : '—'}
                  hint={
                    preflight && preflight.pendingWalBytes > 0
                      ? formatBytes(preflight.pendingWalBytes)
                      : undefined
                  }
                  tone={preflight && preflight.pendingWalBytes > 0 ? 'warn' : undefined}
                />
              </div>

              {/* QQ 在线检查：在线就先结束它，否则会读出撕裂的页。 */}
              <div className={`weq-rp-qq is-${qqOnline ? 'warn' : 'ok'}`}>
                <span className="weq-rp-qq-dot" aria-hidden />
                <span className="weq-rp-qq-text">
                  <strong>
                    {qqOnline ? `QQ 在线（PID ${status?.qqPid}）` : 'QQ 没在跑这个账号'}
                  </strong>
                  <em>
                    {qqOnline
                      ? (readiness?.short ?? '结束它，修复才读得到一致的页。')
                      : '没有 QQ 在写这个库，可以放心开始。'}
                  </em>
                </span>
                {preflight?.readiness === 'blocked-by-qq' && preflight.qqHolders[0] ? (
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-sm weq-set-btn-danger"
                    disabled={busy !== null}
                    onClick={() => void handleKillQq()}
                  >
                    {busy === 'kill' ? (
                      <Loader2 size={12} className="weq-spin" aria-hidden />
                    ) : (
                      <XCircle size={12} strokeWidth={2} aria-hidden />
                    )}
                    结束 QQ
                  </button>
                ) : null}
              </div>

              {status && !status.keyPresent ? (
                <Note tone="warn">没有数据库密钥，修不了 —— 先用 WeQ 打开一次这个账号。</Note>
              ) : null}
              {preflightQuery.error ? (
                <Note tone="warn">{errMsg(preflightQuery.error)}</Note>
              ) : null}
              {readiness && readiness.tone !== 'ok' && !qqOnline ? (
                <Note tone={readiness.tone}>{readiness.short}</Note>
              ) : null}
              {spaceShort && preflight && preflight.freeBytes !== null ? (
                <Note tone="warn">
                  空间不够：需要约 {formatBytes(preflight.requiredBytes)}，只有{' '}
                  {formatBytes(preflight.freeBytes)}。
                </Note>
              ) : null}
              {notice ? (
                <Note tone="warn" icon={<AlertTriangle size={14} strokeWidth={2} />}>
                  {notice}
                </Note>
              ) : null}

              {/* 结果 / 进度二选一：跑着的时候只该看见进度。 */}
              {running && progress ? (
                <RepairProgress progress={progress} />
              ) : outcome ? (
                <div className={`weq-rp-outcome is-${outcome.tone}`}>
                  <span className="weq-rp-outcome-icon" aria-hidden>
                    {outcome.tone === 'ok' ? (
                      <CheckCircle2 size={16} strokeWidth={2} />
                    ) : (
                      <AlertTriangle size={16} strokeWidth={2} />
                    )}
                  </span>
                  <span className="weq-rp-outcome-text">
                    <strong>{outcome.title}</strong>
                    <em>{outcome.detail}</em>
                    {outcome.closedAccount ? (
                      <em className="is-warn">
                        这个账号在替换前被关掉了：倒计时结束后会自动回启动页，也可以点上面的「立即
                        返回」自己重新打开它。
                      </em>
                    ) : null}
                  </span>
                </div>
              ) : null}

              {/* 替换确认：把「会动哪个文件、备份与回滚怎么算、会丢什么、账号会被关」
                  一次说清。它不弹窗 —— 就长在主按钮的位置上，与要操作的对象同屏。 */}
              {confirmRepair && !running ? (
                <div className="weq-rp-confirm is-strong" role="alert">
                  <div className="weq-rp-confirm-head">
                    <ShieldAlert size={14} strokeWidth={2} aria-hidden />
                    修复 = 重建 + 替换这个库
                  </div>
                  <ul>
                    <li>
                      替换 <span className="weq-rp-mono">{dbName}</span>
                      {currentRow ? `（${formatBytes(currentRow.bytes)}）` : ''}。
                    </li>
                    <li>替换前先备份（保留最近 {preflight?.backupsKept ?? 3} 份），之后可回滚。</li>
                    <li>坏页里的内容会被排除；替换前会关掉这个账号，修完自动回启动页。</li>
                  </ul>
                  {currentCheckup ? null : (
                    <p className="weq-rp-hint">这个库还没体检过（不体检也能修，那就是盲修）。</p>
                  )}
                  <div className="weq-rp-actions">
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-danger"
                      disabled={!canStart}
                      onClick={() => void handleRepair()}
                    >
                      <Play size={13} strokeWidth={2} aria-hidden />
                      确认替换并修复
                    </button>
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-soft"
                      onClick={() => setConfirmRepair(false)}
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : null}

              {/* 体检结论的细节（结构与坏页地图）。放在末尾：它只在想深看时才要看。 */}
              {currentCheckup ? (
                <Disclosure summary="这个库的体检细节">
                  {currentCheckup.integrity.ran && !currentCheckup.integrity.healthy ? (
                    <p>
                      结构损坏：
                      {currentCheckup.integrity.corruptedTables.length > 0
                        ? currentCheckup.integrity.corruptedTables.join('、')
                        : '整体损坏，未能定位到具体表'}
                    </p>
                  ) : null}
                  {currentCheckup.pages.ran ? (
                    <>
                      <p>
                        共 {currentCheckup.pages.report.pageCount} 页
                        {currentCheckup.pages.report.badPages.length > 0
                          ? ` · 坏页 ${currentCheckup.pages.report.badPages.length}`
                          : ''}
                        {currentCheckup.pages.report.zeroPages.length > 0
                          ? ` · 全零页 ${currentCheckup.pages.report.zeroPages.length}`
                          : ''}
                        {currentCheckup.pages.report.trailingBytes > 0
                          ? ` · 尾部残余 ${currentCheckup.pages.report.trailingBytes} B`
                          : ''}
                        {currentCheckup.pages.report.usedHmac ? '' : ' · 未开启页 HMAC'}
                      </p>
                      {!currentCheckup.pages.report.usedHmac ? (
                        <p>没有页 HMAC 就没有可校验的页签名，这张坏页地图在这里没有意义。</p>
                      ) : currentCheckup.pages.report.badPages.length > 0 ? (
                        <div className="weq-rp-pages">
                          {currentCheckup.pages.report.badPages
                            .slice(0, BAD_PAGE_PREVIEW)
                            .map((page) => (
                              <span key={page} className="weq-rp-page">
                                {page}
                              </span>
                            ))}
                          {currentCheckup.pages.report.badPages.length > BAD_PAGE_PREVIEW ? (
                            <span className="weq-rp-hint">
                              …共 {currentCheckup.pages.report.badPages.length} 个
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      {currentCheckup.pages.report.affected.length > 0 ? (
                        <ul>
                          {currentCheckup.pages.report.affected.map((item) => (
                            <li key={`${item.name}:${item.pagetype}`}>
                              <span className="weq-rp-mono">{item.name}</span>（{item.pagetype}
                              ）命中 {item.badPageCount} 个坏页
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </>
                  ) : (
                    <p>页级检查没跑起来：{currentCheckup.pages.error}</p>
                  )}
                  {!currentCheckup.integrity.ran ? (
                    <p>结构检查没跑起来：{currentCheckup.integrity.error}</p>
                  ) : null}
                </Disclosure>
              ) : null}

              <div className="weq-rp-actions weq-rp-actions-end">
                <button
                  type="button"
                  className="weq-rp-icon-btn is-wide"
                  disabled={busy !== null}
                  title="只备份这个库（不改动它）"
                  onClick={() => void handleBackup()}
                >
                  {busy === 'backup' ? (
                    <Loader2 size={13} className="weq-spin" aria-hidden />
                  ) : (
                    <FolderOpen size={13} strokeWidth={2} aria-hidden />
                  )}
                  只备份
                </button>
                {!confirmRepair ? (
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-danger"
                    disabled={!canStart}
                    onClick={() => {
                      setConfirmRepair(true);
                      setNotice(null);
                      setOutcome(null);
                    }}
                  >
                    {running ? (
                      <Loader2 size={13} className="weq-spin" aria-hidden />
                    ) : (
                      <Play size={13} strokeWidth={2} aria-hidden />
                    )}
                    {running ? '正在修复…' : '开始修复'}
                  </button>
                ) : null}
              </div>
            </div>
          )}
        </div>
      )}

      <HistoryLightbox
        open={historyOpen}
        onClose={() => {
          setHistoryOpen(false);
          setConfirming(null);
          setPreview(null);
        }}
        records={history}
        busy={busy !== null}
        confirming={confirming}
        preview={preview}
        onAskRestore={(record) => void askRestore(record)}
        onRestore={(record, force) => void handleRestore(record, force)}
        onDelete={(record) => void handleDeleteRecord(record)}
        onAskDelete={(record) => setConfirming({ id: record.id, action: 'delete' })}
        onCancelConfirm={() => {
          setConfirming(null);
          setPreview(null);
        }}
        onReveal={(record, what) => void reveal(record, what)}
      />
    </>
  );
}
