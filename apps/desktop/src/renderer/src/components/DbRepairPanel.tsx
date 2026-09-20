/**
 * 妙妙工具 → 数据库修复。
 *
 * 这一屏把「库坏了怎么办」收成一条能自己走完的路：看清坏在哪（坏页扫描）→ 备份 →
 * 重建 → 替换 → 自检 → 后悔（回滚）。后端是 `client.dbRepair.*`，服务层的编排在
 * `@weq/service` 的 `account/db_repair/`。
 *
 * 几条刻意的取舍：
 *
 *   1. **确认一律内联在被点的那一行里**。设置页曾经把「会丢数据」的确认条放在卡片底部，
 *      结果点级别 1 的开关、确认条出现在级别 3 下面。这里「回滚」「删除记录」都是把那一行
 *      换成确认态，位置与操作对象永远一致。
 *   2. **渲染层只传 uin + 库名**。目录、密钥、算法都在主进程解析 —— 一旦接受路径，
 *      这个接口就变成任意路径写入器。
 *   3. **进度不是装饰**：一次修复约 5 秒、八个阶段，没有它就等于「点了按钮之后卡死」。
 *      阶段名用主进程报的 `message`（本来就是中文），百分比直接用 `percent`，另外把
 *      native 报的 phase 画成一条阶段轨 —— 卡住时能看出卡在哪一步。
 *   4. **中途失败必须说清源库没被动过**。服务层是「备份 → 产物 → 校验 → 替换」，
 *      任何一步失败都发生在替换之前，所以源库一个字节都没动 —— 这决定了重试是零成本的。
 *   5. **颜色一律走主题 token**（警示用 `--weq-warn-*`，它本身也是从主题强调色派生的），
 *      不另配一套颜色，否则与主题打架。按钮同理：直接用 `.weq-set-btn` 那一套（它已经把
 *      浅色 / 深色都适配好了），只为本面板特有的东西（执行条、阶段轨、指标卡、记录列表）
 *      新加 `weq-repair-*` 样式。
 *   6. **修完必须把人送回首页**。替换库文件那一步会先 `clearAccount()`，主进程里账号
 *      已经关了，渲染层却还停在主界面上（有会话列表、没头像、点不开消息）。所以修完由
 *      全局的 `<DbRepairReturnOverlay>` 倒数几秒后自动回首页 —— 面板只管 `arm` 它。
 *   7. **常驻执行条**。这一屏比弹窗还高，而「开始修复」原本在最下面：选了库之后得先滚过
 *      一大段说明才够得着按钮。现在把「当前账号 + 当前库 + 是否可修 + 主按钮 + 进度」
 *      收进面板顶部的一条常驻条（刻意放在滚动区**外面**，与面板头 / 滚动区同级）。
 *   8. **只修当前账号**。账号固定为父级传进来的 `currentUin`（当前登录的那个），面板里
 *      没有任何切换账号的入口 —— 修错账号的代价太大，干脆不给这条路。
 *   9. **先体检 → 从结论里选库 → 再修**。体检（`dbRepair.checkup`：结构检查 + 坏页地图）
 *      是只读的，面板一打开就自动跑一次。结论里**有问题的库**直接铺出来（坏的那个旁边
 *      靠一个「选这个库」），完好的库默认收起来 —— 想修完好的得自己点「选择其他数据库」，
 *      这就是"允许选、但要手动"。自动定位只把选中项拨到第一个有问题的库，用户选过之后不再抢。
 *  10. **「开始修复」前面一定有一道确认**。点按钮不会立刻开跑：先把"会替换哪个文件、
 *      备份与回滚怎么算、坏页里的内容会丢、会关掉账号并回启动页"摊在执行条里让人确认，
 *      并且带上这个库的体检结论（没体检过就写明"还没体检过"）。
 *  11. **历史默认收起、可整条删除**。一张长列表一直拖在面板最下面又长又丑，所以修复记录
 *      收进一个默认折叠的块；每条记录可以「删除记录」—— 记录与备份一起消失（与只清备份的
 *      `deleteBackup` 不同）。
 *  12. **版面即流程**。两条编号步骤（体检·选库 → 检查环境）左侧共用一条轨道 + 节点，
 *      从上到下就是操作顺序；解释文字（重建原理、预检各情况的来龙去脉、坏页清单）都收进
 *      默认收起的说明块 —— 需要时点开，不需要时不占版面。
 *
 * 视图类型在这里重新声明（而不是从主进程 import），与 `DatabaseDamagedDialog` 的
 * `DatabaseDamagedEvent` 同一套做法：渲染层只认「主进程答应给的那个形状」。
 */

import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  DatabaseZap,
  FolderOpen,
  HardDrive,
  Info,
  KeyRound,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Stethoscope,
  Trash2,
  Waves,
  XCircle,
} from 'lucide-react';
import { client, trpc } from '../trpc/client';
import { useDbRepairReturn } from '../state/dbRepairReturn';
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

/**
 * 失败标题。主进程给的那句是**原因**（例如"替换前复核发现 QQ 又打开了该数据库"），
 * 标题只负责说清"这是哪一类事、下一步动哪里"。
 */
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

/** 这两类失败一定发生在替换**之前**，所以可以说"替换还没开始"（别的不能这么说）。 */
const PRE_SWAP_FAILURES: ReadonlySet<DbRepairFailureCode> = new Set([
  'blocked',
  'changed-during-repair',
] as const);

/** 与 `@weq/service` 的 `BadPageScanReport` 对齐（settings 里那份的同一形状）。 */
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
const BAD_PAGE_PREVIEW = 30;

/** 修复任务跑着时的轮询间隔（锁状态、QQ pid 会变）。 */
const POLL_MS = 2000;

/** 语气。`idle` 只用于"还没测出来"的指标卡，不参与配色分档。 */
type RepairTone = 'ok' | 'warn' | 'muted';

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
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 记录状态 → 徽章文案 + 色调。`aborted` / `apply-failed` 不叫「失败」：源库没被动过。 */
const STATE_BADGES: Record<
  DbRepairRecordView['state'],
  { label: string; tone: 'ok' | 'warn' | 'muted'; hint: string }
> = {
  applied: { label: '已修复', tone: 'ok', hint: '当前库就是修复产物。' },
  'rolled-back': { label: '已回滚', tone: 'muted', hint: '已经换回修复前那一份。' },
  aborted: {
    label: '已中止 · 源库未动',
    tone: 'warn',
    hint: '替换之前就停下了（期间被写入 / 仍被占用），源库一个字节都没改，直接重试即可。',
  },
  'apply-failed': {
    label: '修复失败 · 源库未动',
    tone: 'warn',
    hint: '重建或自检没过，发生在替换之前，源库一个字节都没改。',
  },
};

/** 体检结论 → 徽章文案（文案就是结论本身）。 */
function checkupBadge(row: DbRepairCheckupView): { label: string; tone: RepairTone } {
  switch (row.verdict) {
    case 'healthy':
      return { label: '完好', tone: 'ok' };
    case 'healthy-unverified':
      return { label: '结构完好 · 页未校验', tone: 'muted' };
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
 * 已经"自动体检过"的账号（模块级，不是组件状态）。
 *
 * 为什么需要它：这一屏的关键问题是「到底有没有问题」，而用户自己往往答不出来 ——
 * 所以面板一打开就自动体检一次。但组件会在切工具页签时卸载（`activeTool` 一变就换人），
 * 用组件内的标记会在切回来时又整库读一遁。一个账号自动跑过一次就够，想拿新结论
 * 自己点「体检全部」即可。
 */
const autoCheckedUins = new Set<string>();

/** 体检结果的汇总（步骤标题右侧的徽章）：只看已经检过的库。 */
function checkupRollup(rows: DbRepairCheckupView[]): { label: string; tone: RepairTone } | null {
  if (rows.length === 0) return null;
  const broken = rows.filter(
    (row) => row.verdict === 'pages-bad' || row.verdict === 'corrupted',
  ).length;
  if (broken > 0) return { label: `${broken} / ${rows.length} 个库有问题`, tone: 'warn' };
  const unknown = rows.filter(
    (row) => row.verdict === 'healthy-unverified' || row.verdict === 'error',
  ).length;
  if (unknown > 0) return { label: `${unknown} / ${rows.length} 个库还没判定`, tone: 'muted' };
  return { label: `${rows.length} 个库全部完好`, tone: 'ok' };
}

/**
 * 预检结论 → 界面措辞 + 该给什么按钮。
 *
 * `blocked-by-qq` 才给「结束 QQ 进程」：`blocked-by-other` 的持有者通常是 WeQ 自己
 * （当前打开着这个账号），那种情况下替换前会自动关掉，不需要用户动手。
 */
const READINESS_COPY: Record<
  DbRepairReadiness,
  { label: string; tone: 'ok' | 'warn' | 'muted'; short: string }
> = {
  ready: { label: '可以开始', tone: 'ok', short: '没有进程占用这个库，随时可以修。' },
  'blocked-by-qq': {
    label: 'QQ 正开着这个账号',
    tone: 'warn',
    short: '要先结束这个账号的 QQ，否则会读出撕裂的页。',
  },
  'blocked-by-other': {
    label: '有进程占用',
    tone: 'warn',
    short: '通常是 WeQ 自己，替换那一步会先把它关掉。',
  },
  'unknown-lock': {
    label: '占用情况不明',
    tone: 'muted',
    short: '不阻断；替换前会再查一次，仍被占用则中止（源库不动）。',
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

/**
 * 展开区里的补充说明。都是"为什么 / 万一"这类解释，默认不占版面 ——
 * 界面上只留"要做什么"。
 */
const REPAIR_NOTES: readonly { title: string; body: string }[] = [
  {
    title: 'QQ 正开着这个账号',
    body: '修复要先解密源库，QQ 一边写、我们一边读会读出撕裂的页 —— 必须先把这个账号的 QQ 结束掉（用上面的「结束 QQ 进程」按钮即可）。',
  },
  {
    title: '被 WeQ 自己占着',
    body: '通常是 WeQ 自己打开着这个账号。可以照常开始：替换那一步会先把它关掉，之后回到启动页重新打开即可。',
  },
  {
    title: '占用情况不明',
    body: '这个平台上探测不到锁（权限或平台不支持）。不阻断，但替换前会再查一次；还是被占用的话会中止，源库不会被动。',
  },
  {
    title: '未合并的预写日志',
    body: 'QQ 崩溃或被强杀之后会留下它，里面是主文件里还没有的最后一批改动。修复会先把它并回主文件（不需要 QQ 参与），所以这批改动会一起进修复产物和备份；万一并不成功，报告里会写明「这批改动没修进去」。',
  },
];

// ────────────────────────── 版面零件 ──────────────────────────

/** 一句话提示条：语气靠左边框重量与底色区分（不用另一支色相）。 */
function Note({
  tone = 'muted',
  icon,
  children,
  action,
}: {
  tone?: RepairTone;
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}): ReactElement {
  return (
    <div className={`weq-repair-note is-${tone}`}>
      <span className="weq-repair-note-icon" aria-hidden>
        {icon ??
          (tone === 'ok' ? (
            <CheckCircle2 size={14} strokeWidth={2} />
          ) : tone === 'warn' ? (
            <AlertTriangle size={14} strokeWidth={2} />
          ) : (
            <Info size={14} strokeWidth={2} />
          ))}
      </span>
      <span className="weq-repair-note-text">{children}</span>
      {action ? <span className="weq-repair-note-action">{action}</span> : null}
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
  tone?: RepairTone;
}): ReactElement {
  return (
    <div className={`weq-repair-metric${tone ? ` is-${tone}` : ''}`}>
      <span className="weq-repair-metric-label" aria-hidden>
        {icon}
        {label}
      </span>
      <span className="weq-repair-metric-value" title={value}>
        {value}
      </span>
      {hint ? <span className="weq-repair-metric-hint">{hint}</span> : null}
    </div>
  );
}

/**
 * 「修复步骤」的一块：序号节点 + 标题 + 右侧结论/动作，正文在下面。
 * 三块从上到下就是操作顺序，左侧的轨道把它们连成一条路。
 */
function FlowStep({
  n,
  title,
  aside,
  children,
}: {
  n: number;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="weq-repair-step">
      <div className="weq-repair-step-rail" aria-hidden>
        <span className="weq-repair-step-node">{n}</span>
      </div>
      <div className="weq-repair-step-main">
        <header className="weq-repair-step-head">
          <h3 className="weq-repair-step-title">{title}</h3>
          {aside ? <div className="weq-repair-step-aside">{aside}</div> : null}
        </header>
        <div className="weq-repair-step-body">{children}</div>
      </div>
    </section>
  );
}

/** 默认收起的说明块：重点步骤保持清爽，解释文字点开再看。 */
function RepairDisclosure({
  summary,
  children,
}: {
  summary: string;
  children: ReactNode;
}): ReactElement {
  return (
    <details className="weq-repair-details">
      <summary>
        <ChevronDown size={13} aria-hidden />
        {summary}
      </summary>
      <div className="weq-repair-details-body">{children}</div>
    </details>
  );
}

/** 修复进度：当前阶段 + 百分比 + 阶段轨（卡住时能看出卡在哪一步）。 */
function RepairProgress({
  phase,
  percent,
  message,
}: {
  phase: string;
  percent: number;
  message: string;
}): ReactElement {
  const activeIndex = REPAIR_STAGES.findIndex((stage) => stage.phase === phase);
  return (
    <div className="weq-repair-progress" aria-live="polite">
      <div className="weq-repair-progress-head">
        <span className="weq-repair-progress-msg">
          <Loader2 size={12} strokeWidth={2.4} className="weq-spin" aria-hidden />
          {message || phase}
        </span>
        <span className="weq-repair-progress-pct">{percent}%</span>
      </div>
      <div className="weq-repair-progress-track">
        <div className="weq-repair-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      {activeIndex >= 0 ? (
        <ol className="weq-repair-stages">
          {REPAIR_STAGES.map((stage, index) => (
            <li
              key={stage.phase}
              className={
                index < activeIndex ? 'is-done' : index === activeIndex ? 'is-active' : 'is-todo'
              }
            >
              <span className="weq-repair-stage-dot" aria-hidden />
              {stage.label}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

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

  const [dbName, setDbName] = useState('nt_msg.db');
  /** 内联二次确认：哪一条记录、等的是哪种操作。 */
  const [confirming, setConfirming] = useState<{ id: string; action: 'restore' | 'delete' } | null>(
    null,
  );
  const [preview, setPreview] = useState<DbRepairRestorePreviewView | null>(null);
  const [progress, setProgress] = useState<{
    phase: string;
    percent: number;
    message: string;
  } | null>(null);
  /** 体检结果：按库名记着。 */
  const [checkups, setCheckups] = useState<Record<string, DbRepairCheckupView>>({});
  /**
   * 「选择其他数据库」是否展开：完好的库默认藏起来 —— 这一屏的主角是**有问题的库**，
   * 9 个库全铺出来等于没说哪个有问题。完好的也要修时，用户自己点开这个入口再挑。
   */
  const [showHealthy, setShowHealthy] = useState(false);
  /** 用户手动选过库之后，就不再自动把选中项跳到"发现问题的那个"。 */
  const userPickedDbRef = useRef(false);
  /** 自动体检只跑一次的标记（切换工具页签会卸载重挂，所以标记放在模块级）。 */
  const autoCheckedRef = useRef<string | null>(null);
  /**
   * `runCheckup` 的最新引用：下面那个自动体检的 effect 只该依赖**状态值**，不能依赖
   * 每次渲染都换身份的 `runCheckup`（否则它每渲染就重跑一次，lint 也会报错）。
   */
  const runCheckupRef = useRef<(dbNames: string[]) => Promise<void>>(async () => {});
  /** 正在体检的那一个库（那一行转圈）。 */
  const [checkingDb, setCheckingDb] = useState<string | null>(null);
  const [checkupRunning, setCheckupRunning] = useState(false);
  /** 体检的「停」开关：当前这个库跑完就不再往下走。 */
  const stopCheckupRef = useRef(false);
  /** 「开始修复」是否停在替换确认那一步。 */
  const [confirmRepair, setConfirmRepair] = useState(false);
  /** 正在跑的那件事（按钮据此禁用，避免同时发起两个任务）。 */
  const [busy, setBusy] = useState<'repair' | 'backup' | 'checkup' | 'kill' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 只修当前登录的那个账号（uin 由父级传入）。
  const uin = currentUin;
  const running = busy === 'repair';

  // ── 查询 ────────────────────────────────────────────────────────────────
  const statusQuery = trpc.dbRepair.status.useQuery(
    { uin: uin ?? '' },
    { enabled: uin !== null, refetchInterval: running ? POLL_MS : false },
  );
  const status = statusQuery.data as DbRepairStatusView | undefined;
  /** 该账号的 QQ 是否在线（决定要不要盯着锁状态）。 */
  const qqOnline = (status?.qqPid ?? null) !== null;
  const preflightQuery = trpc.dbRepair.preflight.useQuery(
    { uin: uin ?? '', dbName },
    // 只在真需要盯的时候轮询：任务跑着，或者 QQ 在线（用户可能在面板外把它关掉，
    // 那样"被 QQ 占着"的提示得自己变成"可以开始"）。其余时候一次就够。
    { enabled: uin !== null, refetchInterval: !running && qqOnline ? POLL_MS : false },
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
  const checkup = trpc.dbRepair.checkup.useMutation();
  const killQq = trpc.dbRepair.killQq.useMutation();
  const restore = trpc.dbRepair.restore.useMutation();
  const removeRecord = trpc.dbRepair.deleteRecord.useMutation();
  const backupNow = trpc.dbRepair.backup.useMutation();

  // ── 默认库：优先 nt_msg.db，其次第一个真实存在的库 ────────────────────────
  const existingDbs = useMemo(() => status?.databases ?? [], [status]);
  useEffect(() => {
    if (existingDbs.length === 0) return;
    const current = existingDbs.find((row) => row.dbName === dbName);
    if (current?.exists) return;
    const preferred = existingDbs.find((row) => row.dbName === 'nt_msg.db' && row.exists);
    const fallback = existingDbs.find((row) => row.exists);
    if (preferred ?? fallback) setDbName((preferred ?? fallback)!.dbName);
  }, [existingDbs, dbName]);

  // ── 进度订阅：只在修复期间挂着 ──────────────────────────────────────────
  const unsubRef = useRef<(() => void) | null>(null);
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
    unsubRef.current = () => sub.unsubscribe();
    return () => {
      unsubRef.current?.();
      unsubRef.current = null;
    };
  }, [running, uin, dbName]);

  // ── 自动体检：面板一打开就先回答「有没有问题」 ──────────────────────────
  //
  // 这一屏原来的毛病是：只有一个「开始修复」，用户既不知道哪个库有问题、也不知道有没有
  // 问题，却已经把库换掉了。体检是只读的，代价是几秒 I/O —— 直接替他跑，比写一句
  // "建议先体检"有用。跳过的三种情况：没密钥（跑不了）、有任务在跑（别撞车）、
  // 这个账号已经自动跑过一次（切换页签重挂不再重复扫）。
  useEffect(() => {
    if (uin === null || autoCheckedRef.current === uin || autoCheckedUins.has(uin)) return;
    if (busy !== null || status?.keyPresent !== true) return;
    const targets = existingDbs.filter((row) => row.exists).map((row) => row.dbName);
    if (targets.length === 0) return;
    autoCheckedRef.current = uin;
    void runCheckupRef.current(targets);
  }, [uin, busy, status, existingDbs]);

  // ── 自动定位到"有问题的那个库" ────────────────────────────────────
  //
  // 体检的目的就是找出坏的库。一旦有结论说某个库坏了，就把选中项拨到它那边 ——
  // 用户打开面板就是为了修它，不必再手动点一次。用户自己选过库之后就不再抢。
  useEffect(() => {
    if (checkupRunning || userPickedDbRef.current) return;
    const firstBad = existingDbs.find((row) => {
      const result = checkups[row.dbName];
      return result !== undefined && isProblemCheckup(result);
    });
    if (firstBad) setDbName(firstBad.dbName);
  }, [existingDbs, checkups, checkupRunning]);

  /** 修完统一刷新三个查询 —— 状态、预检、历史都变了。 */
  const refreshAll = async (): Promise<void> => {
    await Promise.all([
      utils.dbRepair.status.invalidate(),
      utils.dbRepair.preflight.invalidate(),
      utils.dbRepair.history.invalidate(),
    ]);
    onRefreshAccounts();
  };

  // ── 动作 ────────────────────────────────────────────────────────────────

  /** 结束挡住这个库的 QQ 进程（pid 只取自预检报上来的 QQ 持有者）。 */
  const handleKillQq = async (): Promise<void> => {
    const holder = preflight?.qqHolders[0];
    if (!holder || uin === null) return;
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
        // 杀了但还占着 —— 这就是"下一步要修也修不了"的原因，不能只写在底部。
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

  /**
   * 体检：逐个库调用主进程，**检完一个显示一个**。
   *
   * 为什么不在主进程里一把跑完：128MB 的 `nt_msg.db` 要整库读两遍（结构 + 页签名），
   * 一次调用会让面板在这几秒里什么都看不到。逐个调既能边检边看，也能中途停下。
   *
   * 单个库失败只把那一行标成「无法检查」，不弹 toast、不中断其余库 —— 体检本来就是
   * 在排查"哪里不对"，让第一个错误把整张表打断反而更难用。
   */
  const runCheckup = async (dbNames: string[]): Promise<void> => {
    if (uin === null || dbNames.length === 0) return;
    // 手动跑过也算"这个账号体检过了"，自动那次就不用再补。
    autoCheckedRef.current = uin;
    autoCheckedUins.add(uin);
    stopCheckupRef.current = false;
    setCheckupRunning(true);
    setBusy('checkup');
    setNotice(null);
    try {
      for (const name of dbNames) {
        if (stopCheckupRef.current) break;
        setCheckingDb(name);
        try {
          const row = (await checkup.mutateAsync({ uin, dbName: name })) as DbRepairCheckupView;
          setCheckups((prev) => ({ ...prev, [name]: row }));
        } catch (error) {
          const text = errMsg(error);
          setCheckups((prev) => ({ ...prev, [name]: failedCheckup(name, text) }));
        }
      }
    } finally {
      setCheckingDb(null);
      setCheckupRunning(false);
      setBusy(null);
    }
  };

  // 把最新那份 runCheckup 交给上面的自动体检 effect（它不依赖函数身份，见那里的注释）。
  runCheckupRef.current = runCheckup;

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
    if (uin === null) return;
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
   *   1. **toast**：面板很长，失败说明只出现在面板里的 notice 那一块，用户很可能根本没
   *      看到（他正盯着进度条）—— 尤其是"替换阶段被拦下来"这种必须马上知道的事。
   *   2. **账号已被关掉时把人送回首页**：替换阶段的失败发生在 `releaseHandles` 之后
   *      （替换前复核 / rename / 自检），主进程里当前账号已经关了，而渲染层还停在主
   *      界面上是个坏界面（会话列表在、头像没有、点不开消息）。以前这里只写一句
   *      notice，人就被留在了那个界面里。
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
    if (uin === null) return;
    setConfirmRepair(false);
    setBusy('repair');
    setNotice(null);
    setProgress({ phase: 'backup', percent: 0, message: '准备中…' });
    try {
      const result = (await startRepair.mutateAsync({
        uin,
        dbName,
      })) as DbRepairTaskResultView;
      // 分类好的失败是**返回值**（这样才带得回"账号是否已被关掉"），不是异常。
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
      if (result.closedAccount) {
        // 主进程里当前账号已经被关掉了，渲染层还停在主界面上 —— 必须回首页重开。
        armReturn({
          title: `修复完成（${(record.durationMs / 1000).toFixed(1)}s）`,
          detail: `${summary} · 替换前 WeQ 里这个账号被关掉了，重新打开后才能看到修复后的数据`,
        });
      } else {
        pushToast({
          tone: 'success',
          title: `修复完成（${(record.durationMs / 1000).toFixed(1)}s）`,
          detail: summary,
        });
      }
      // 库已经是新的了，旧的体检结论作废。
      forgetCheckup(dbName);
      await refreshAll();
    } catch (error) {
      // 能到这里的只有"连服务都没进得去"的意外（例如 IPC 断了）；照样给一条 toast。
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
      // 取不到预览就点不了确认 —— 不说一声的话，用户会觉得"点了没反应"。
      const text = errMsg(error);
      pushToast({ tone: 'error', title: '回滚前检查失败', detail: text });
      setNotice(text);
    }
  };

  const handleRestore = async (record: DbRepairRecordView, force: boolean): Promise<void> => {
    if (uin === null) return;
    setBusy('repair');
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
      if (what === 'report')
        await client.dbRepair.revealReport.mutate({ uin, recordId: record.id });
      else await client.dbRepair.revealBackup.mutate({ uin, recordId: record.id });
    } catch (error) {
      const text = errMsg(error);
      pushToast({ tone: 'error', title: '打开失败', detail: text });
      setNotice(text);
    }
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
  const readiness = preflight ? READINESS_COPY[preflight.readiness] : null;
  const currentRow = existingDbs.find((row) => row.dbName === dbName) ?? null;
  const liveDbs = existingDbs.filter((row) => row.exists);
  /** 有问题的库 —— 这一屏的主角，永远铺在列表里。 */
  const problemDbNames = liveDbs
    .filter((row) => {
      const result = checkups[row.dbName];
      return result !== undefined && isProblemCheckup(result);
    })
    .map((row) => row.dbName);
  /** 完好的库数量（「选择其他数据库」入口的计数）。 */
  const healthyDbCount = liveDbs.length - problemDbNames.length;
  /**
   * 实际铺在屏幕上的库：当前选中的、正在体检的、有问题的，以及（手动展开时才有的）
   * 完好的。完好的默认藏起来 —— 不然 9 个库全列出来，等于没说哪个有问题。
   */
  const visibleDbs = liveDbs.filter((row) => {
    if (row.dbName === dbName || checkingDb === row.dbName) return true;
    if (problemDbNames.includes(row.dbName)) return true;
    return showHealthy;
  });
  const spaceShort = Boolean(
    preflight && preflight.freeBytes !== null && preflight.freeBytes < preflight.requiredBytes,
  );
  const canStart =
    uin !== null && !busy && status?.keyPresent === true && preflight !== undefined && !spaceShort;
  /** 当前库的体检结论（没检过就是 null —— 确认替换时会说明"还没体检过"）。 */
  const currentCheckup = checkups[dbName] ?? null;
  /** 已经检过的库（汇总徽章只看这些）。 */
  const checkedRows = liveDbs
    .map((row) => checkups[row.dbName])
    .filter((row): row is DbRepairCheckupView => row !== undefined);
  const rollup = checkupRollup(checkedRows);
  const startHint = running
    ? '修复期间不要打开这个账号的 QQ；修完会把你送回启动页重新打开。'
    : status && !status.keyPresent
      ? '缺少数据库密钥：先在 WeQ 里打开一次这个账号再回来。'
      : preflight === undefined
        ? '正在检查环境…'
        : spaceShort
          ? '磁盘空间不够，先清理空间再开始。'
          : checkupRunning
            ? '正在体检，跑完再开始修复。'
            : busy
              ? '有其它操作正在进行，稍等一下。'
              : currentCheckup
                ? `体检结论：${currentCheckup.summary}点「开始修复」还会再让你确认一次替换。`
                : '「开始修复」是把这个库重建后**替换**掉（先备份、可回滚），点下去会先让你确认；想先看坏在哪，用上面的「体检」。';

  return (
    <>
      <header className="weq-wtools-pane-head">
        <div className="weq-wtools-pane-title">
          <DatabaseZap size={17} strokeWidth={1.9} />
          <h2 id="weq-wtools-title">数据库修复</h2>
        </div>
        {status ? (
          <div className="weq-repair-head-tags">
            <span className={`weq-repair-tag${qqOnline ? ' is-live' : ''}`}>
              {qqOnline ? 'QQ 在线' : 'QQ 离线'}
            </span>
            {status.busy ? <span className="weq-repair-tag is-busy">任务进行中</span> : null}
          </div>
        ) : null}
      </header>

      {/* ── 执行条：当前对象 + 结论 + 主按钮 + 进度 ──
          刻意放在滚动区**外面**（与 head / body 同级）：这一屏比弹窗还高，而
          「开始修复」原本在最下面 —— 选了库之后得先滚过一大段说明才够得着。放在
          滚动区里用 sticky 也能钉住，但滚动容器的 padding 会在条子上方留一条缝，
          内容从那道缝里透出来；直接不参与滚动就没这问题。 */}
      <section className="weq-repair-bar">
        <div className="weq-repair-bar-row">
          {account ? <QqAvatar uin={account.uin} url={account.avatarUrl} size={26} /> : null}
          <div className="weq-repair-bar-id">
            <span className="weq-repair-bar-name">
              {account ? account.name || account.uin : '未选择账号'}
            </span>
            <span className="weq-repair-bar-sub">
              <span className="weq-repair-mono">{dbName}</span>
              <span className="weq-repair-sep" aria-hidden />
              {currentRow ? formatBytes(currentRow.bytes) : '—'}
              {readiness ? (
                <>
                  <span className="weq-repair-sep" aria-hidden />
                  <span className={`weq-repair-bar-flag is-${readiness.tone}`}>
                    {readiness.label}
                  </span>
                </>
              ) : null}
            </span>
          </div>
          <div className="weq-repair-actions">
            {/* 「…」是认真的：点下去不会立刻开跑，而是先把替换的后果摊开让人确认。 */}
            {!confirmRepair ? (
              <button
                type="button"
                className="weq-set-btn"
                disabled={!canStart}
                onClick={() => {
                  setConfirmRepair(true);
                  setNotice(null);
                }}
              >
                {running ? (
                  <Loader2 size={13} className="weq-spin" aria-hidden />
                ) : (
                  <Play size={13} strokeWidth={2} aria-hidden />
                )}
                {running ? '修复中…' : '开始修复…'}
              </button>
            ) : null}
            <button
              type="button"
              className="weq-set-btn weq-set-btn-soft"
              disabled={busy !== null || uin === null || confirmRepair}
              onClick={() => void handleBackup()}
            >
              {busy === 'backup' ? (
                <Loader2 size={13} className="weq-spin" aria-hidden />
              ) : (
                <FolderOpen size={13} strokeWidth={2} aria-hidden />
              )}
              {busy === 'backup' ? '备份中…' : '只备份'}
            </button>
          </div>
        </div>

        {running && progress ? (
          <RepairProgress
            phase={progress.phase}
            percent={progress.percent}
            message={progress.message}
          />
        ) : confirmRepair ? null : (
          // 确认那一段自己就把"会发生什么"说完了 —— 再挂一行提示只会把执行条撑高。
          <p className="weq-repair-bar-hint">{startHint}</p>
        )}

        {/* 替换确认：把「会动哪个文件、备份与回滚怎么算、会丢什么、账号会被关」一次说清。
            它不弹窗 —— 就长在执行条里，与要操作的对象（上面那行库名）在同一屏。 */}
        {confirmRepair && !running ? (
          <div className="weq-repair-replace" role="alert">
            <div className="weq-repair-replace-head">
              <ShieldAlert size={14} strokeWidth={2} aria-hidden />
              修复是「重建 + 替换」，不是只读扫描
            </div>
            <ul className="weq-repair-replace-list">
              <li>
                会用重建产物替换 <span className="weq-repair-mono">{dbName}</span>
                {currentRow ? `（${formatBytes(currentRow.bytes)}）` : ''}。
              </li>
              <li>
                替换前会先备份当前文件（保留最近 {preflight?.backupsKept ?? 3}{' '}
                份），之后可以一键回滚。
              </li>
              <li>坏页里的内容会被排除；替换前会关掉 WeQ 里这个账号，修完自动回到启动页。</li>
            </ul>
            {/* 体检结论已经写在上面的提示行里了，这里只在"没体检过"时补一句。 */}
            {currentCheckup ? null : (
              <p className="weq-repair-hint">
                这个库还没体检过 —— 可以先回上面「体检」看一眼坏在哪（不体检也能修，那就是盲修）。
              </p>
            )}
            <div className="weq-repair-actions">
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

        {notice ? (
          <Note tone="warn" icon={<AlertTriangle size={14} strokeWidth={2} />}>
            {notice}
          </Note>
        ) : null}
      </section>

      <div className="weq-wtools-pane-body weq-repair-body">
        {/* ── ① 体检 · 选择要修复的库 ──
            体检只读、自动跑；结论里**有问题的库**直接铺在列表里，其余完好库默认收起来，
            要看 / 要修得自己点「选择其他数据库」。选中哪个库由行上的按钮决定。 */}
        <FlowStep
          n={1}
          title="体检 · 选择要修复的库"
          aside={
            <>
              {rollup ? (
                <span className={`weq-repair-badge is-${rollup.tone}`}>{rollup.label}</span>
              ) : null}
              <button
                type="button"
                className="weq-repair-icon-btn"
                title="刷新状态与修复记录"
                onClick={() => {
                  onRefreshAccounts();
                  void refreshAll();
                }}
                disabled={busy !== null}
              >
                {/* 图标转起来是「有任务在跑」的信号，文字保持「刷新」—— 转的可能是扫描、
                    备份或结束进程，写成「刷新中」会骗人。 */}
                <RefreshCw size={13} strokeWidth={1.9} className={busy ? 'weq-spin' : ''} />
                刷新
              </button>
            </>
          }
        >
          <p className="weq-repair-hint">
            体检是<strong>只读</strong>的：每个库做一次结构检查（integrity_check）+ 逐页页签名校验。
            修复会把库文件<strong>替换</strong>
            成重建产物，所以先看清哪个库坏了、坏在哪里，再决定修不修。
            {/* 只修当前账号，这里把这一点说死。 */}
            <br />
            当前只看 / 修 <strong>{account?.name || uin}</strong> 这个账号的库。
          </p>

          <div className="weq-repair-actions">
            <button
              type="button"
              className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
              disabled={busy !== null || liveDbs.length === 0}
              onClick={() => void runCheckup(liveDbs.map((row) => row.dbName))}
            >
              {checkupRunning ? (
                <Loader2 size={13} className="weq-spin" aria-hidden />
              ) : (
                <Stethoscope size={13} strokeWidth={2} aria-hidden />
              )}
              {checkupRunning ? '体检中…' : `重新体检全部（${liveDbs.length} 个库）`}
            </button>
            <button
              type="button"
              className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
              disabled={busy !== null}
              onClick={() => void runCheckup([dbName])}
            >
              只体检 {dbName}
            </button>
            {checkupRunning ? (
              <button
                type="button"
                className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
                onClick={() => {
                  stopCheckupRef.current = true;
                }}
              >
                停
              </button>
            ) : null}
          </div>

          {/* 体检是只读的，但「一边被写一边读」可能扫出假坏页 —— 结论的可信度要说清楚。 */}
          {preflight?.readiness === 'blocked-by-qq' ? (
            <Note tone="warn">
              QQ 正开着这个账号：体检不写库，但 QQ 一边写、我们一边读，可能扫出假坏页。
              想要一个可信的结论，先结束 QQ（下面「检查环境」里那个按钮）。
            </Note>
          ) : null}

          {liveDbs.length === 0 ? (
            <p className="weq-repair-hint">这个账号下没有找到数据库文件。</p>
          ) : null}

          {liveDbs.length > 0 && checkedRows.length > 0 ? (
            <div className="weq-repair-checkups-head">
              <span className="weq-repair-hint">
                已检 {checkedRows.length} / {liveDbs.length}
                {checkupRunning && checkingDb ? ` · 正在看 ${checkingDb}` : ''}
                {problemDbNames.length > 0
                  ? ` · 发现 ${problemDbNames.length} 个有问题的库`
                  : checkedRows.length === liveDbs.length
                    ? ' · 全部完好'
                    : ''}
              </span>
            </div>
          ) : null}

          {liveDbs.length > 0 && checkedRows.length === 0 && !checkupRunning ? (
            <p className="weq-repair-hint">
              还没体检过 —— 点上面「重新体检全部」先看看有没有问题。
              修复是替换库文件，不是只读扫描，先体检再决定修不修更划算。
            </p>
          ) : null}

          {/* 按库的顺序渲染（不是"检完的顺序"）：同一屏里位置固定才方便上下对比。 */}
          <ol className="weq-repair-checkups">
            {visibleDbs.map((row) => {
              const result = checkups[row.dbName] ?? null;
              const checking = checkingDb === row.dbName;
              const badge = result ? checkupBadge(result) : null;
              const active = row.dbName === dbName;
              return (
                <li
                  key={row.dbName}
                  className={`weq-repair-row weq-repair-checkup${badge ? ` is-${badge.tone}` : ''}${
                    checking ? ' is-checking' : ''
                  }${active ? ' is-active' : ''}`}
                >
                  <span className="weq-repair-row-dot" aria-hidden />
                  <div className="weq-repair-row-main">
                    <div className="weq-repair-row-head">
                      <span className="weq-repair-mono">{row.dbName}</span>
                      {checking ? (
                        <span className="weq-repair-checkup-state">
                          <Loader2 size={11} className="weq-spin" aria-hidden />
                          体检中…
                        </span>
                      ) : badge ? (
                        <span className={`weq-repair-badge is-${badge.tone}`}>{badge.label}</span>
                      ) : (
                        <span className="weq-repair-badge is-muted">未体检</span>
                      )}
                      {active ? <span className="weq-repair-checkup-state">已选中</span> : null}
                      <span className="weq-repair-row-time">{formatBytes(row.bytes)}</span>
                    </div>

                    {result ? <p className="weq-repair-hint">{result.summary}</p> : null}

                    {result?.integrity.ran && !result.integrity.healthy ? (
                      <div className="weq-repair-row-meta">
                        <span>
                          结构损坏：
                          {result.integrity.corruptedTables.length > 0
                            ? result.integrity.corruptedTables.join('、')
                            : '整体损坏，未能定位到具体表'}
                        </span>
                      </div>
                    ) : null}

                    {result?.pages.ran ? (
                      <div className="weq-repair-row-meta">
                        <span>共 {result.pages.report.pageCount} 页</span>
                        {result.pages.report.badPages.length > 0 ? (
                          <>
                            <span className="weq-repair-sep" aria-hidden />
                            <span>坏页 {result.pages.report.badPages.length}</span>
                          </>
                        ) : null}
                        {result.pages.report.zeroPages.length > 0 ? (
                          <>
                            <span className="weq-repair-sep" aria-hidden />
                            <span>全零页 {result.pages.report.zeroPages.length}</span>
                          </>
                        ) : null}
                        {result.pages.report.trailingBytes > 0 ? (
                          <>
                            <span className="weq-repair-sep" aria-hidden />
                            <span>尾部残余 {result.pages.report.trailingBytes} B</span>
                          </>
                        ) : null}
                        {!result.pages.report.usedHmac ? (
                          <>
                            <span className="weq-repair-sep" aria-hidden />
                            <span>未开启页 HMAC</span>
                          </>
                        ) : null}
                      </div>
                    ) : null}

                    {result ? (
                      <div className="weq-repair-checkup-foot">
                        <div className="weq-repair-actions">
                          {!active ? (
                            <button
                              type="button"
                              className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
                              onClick={() => {
                                userPickedDbRef.current = true;
                                setDbName(row.dbName);
                                setConfirmRepair(false);
                                setNotice(null);
                              }}
                            >
                              选这个库
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="weq-set-btn weq-set-btn-sm weq-set-btn-danger"
                              disabled={busy !== null || status?.keyPresent !== true}
                              onClick={() => {
                                setConfirmRepair(true);
                                setNotice(null);
                              }}
                            >
                              修复这个库…
                            </button>
                          )}
                          {row.lastRecord ? (
                            <span className="weq-repair-step-note">
                              上次 {shortTime(row.lastRecord.at)} ·{' '}
                              {STATE_BADGES[row.lastRecord.state].label}
                            </span>
                          ) : null}
                        </div>

                        {result.pages.ran ? (
                          <RepairDisclosure summary="坏页详情">
                            {!result.pages.report.usedHmac ? (
                              <span>
                                没有页 HMAC 就没有可校验的页签名，这张坏页地图在这里没有意义。
                              </span>
                            ) : (
                              <div className="weq-repair-kv">
                                {result.pages.report.badPages.length > 0 &&
                                result.pages.report.badPages.length <= BAD_PAGE_PREVIEW ? (
                                  <div className="weq-repair-pages">
                                    {result.pages.report.badPages.map((page) => (
                                      <span key={page} className="weq-repair-page">
                                        {page}
                                      </span>
                                    ))}
                                  </div>
                                ) : null}
                                {result.pages.report.badPages.length > BAD_PAGE_PREVIEW ? (
                                  <>
                                    <span>
                                      坏页号（只显示前 {BAD_PAGE_PREVIEW} /{' '}
                                      {result.pages.report.badPages.length} 个）：
                                    </span>
                                    <span className="weq-repair-mono">
                                      {result.pages.report.badPages
                                        .slice(0, BAD_PAGE_PREVIEW)
                                        .join(', ')}
                                    </span>
                                  </>
                                ) : null}
                                {result.pages.report.affected.length > 0 ? (
                                  <ul>
                                    {result.pages.report.affected.map((item) => (
                                      <li key={`${item.name}:${item.pagetype}`}>
                                        <span className="weq-repair-mono">{item.name}</span>（
                                        {item.pagetype}）命中 {item.badPageCount} 个坏页
                                      </li>
                                    ))}
                                  </ul>
                                ) : result.pages.report.badPages.length > 0 ? (
                                  <span>坏页没能映射到具体对象，页号清单仍然有效。</span>
                                ) : null}
                              </div>
                            )}
                          </RepairDisclosure>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>

          {/* 完好的库默认收起来 —— 想修就自己点开（这就是"允许选，但要手动"）。 */}
          {healthyDbCount > 0 ? (
            <button
              type="button"
              className="weq-repair-icon-btn weq-repair-more"
              aria-expanded={showHealthy}
              onClick={() => setShowHealthy((prev) => !prev)}
            >
              <ChevronDown
                size={13}
                strokeWidth={2.2}
                className={showHealthy ? 'is-flip' : ''}
                aria-hidden
              />
              {showHealthy ? '收起完好的数据库' : `选择其他数据库（${healthyDbCount} 个完好）`}
            </button>
          ) : null}
        </FlowStep>

        {/* ── ② 检查环境：密钥 / 占用 / 磁盘 / WAL（决定"能不能修"） ── */}
        <FlowStep
          n={2}
          title="检查环境"
          aside={
            readiness ? (
              <span className={`weq-repair-badge is-${readiness.tone}`}>{readiness.label}</span>
            ) : null
          }
        >
          <div className="weq-repair-metrics">
            <Metric
              icon={<KeyRound size={12} strokeWidth={2} />}
              label="数据库密钥"
              value={status ? (status.keyPresent ? '已就绪' : '缺失') : '检查中…'}
              tone={status ? (status.keyPresent ? 'ok' : 'warn') : undefined}
            />
            <Metric
              icon={<Lock size={12} strokeWidth={2} />}
              label="占用情况"
              value={readiness?.label ?? '检查中…'}
              tone={readiness?.tone}
            />
            <Metric
              icon={<HardDrive size={12} strokeWidth={2} />}
              label="磁盘可用"
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

          {status?.error ? <Note tone="warn">{status.error}</Note> : null}

          {preflightQuery.error ? <Note tone="warn">{errMsg(preflightQuery.error)}</Note> : null}

          {status && !status.keyPresent ? (
            <Note tone="warn">
              这个账号的配置里没有数据库密钥，修不了。先用 WeQ 打开一次该账号再来。
            </Note>
          ) : null}

          {preflight && readiness ? (
            <Note
              tone={readiness.tone}
              icon={
                readiness.tone === 'ok' ? (
                  <ShieldCheck size={14} strokeWidth={2} />
                ) : (
                  <ShieldAlert size={14} strokeWidth={2} />
                )
              }
              action={
                preflight.readiness === 'blocked-by-qq' && preflight.qqHolders[0] ? (
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
                    结束 QQ 进程（pid {preflight.qqHolders[0].pid}）
                  </button>
                ) : null
              }
            >
              {readiness.short}
            </Note>
          ) : null}

          {preflight && preflight.pendingWalBytes > 0 ? (
            <Note tone="warn">
              发现未合并的预写日志（{formatBytes(preflight.pendingWalBytes)}）——
              修复时会先把它并回主文件。
            </Note>
          ) : null}

          {spaceShort && preflight && preflight.freeBytes !== null ? (
            <Note tone="warn">
              磁盘空间不够：需要约 {formatBytes(preflight.requiredBytes)}，可用只有{' '}
              {formatBytes(preflight.freeBytes)}。先清理空间再开始。
            </Note>
          ) : null}
        </FlowStep>

        <RepairDisclosure summary="修复会做什么、要注意什么">
          <p>
            修复是<strong>重建</strong>而不是打补丁：产物是一份全新的库（没有 freelist
            空洞），所以页数与体积会变，这是正常的。
          </p>
          <p>
            整个流程是「备份 → 重建 → 校验 → 替换」，任何一步失败都发生在替换之前 ——
            <strong>源库一个字节都不会动</strong>，直接重试即可。
            {preflight ? <>需要约 {formatBytes(preflight.requiredBytes)} 空间；</> : null}
            备份默认保留最近 3 份。
          </p>
          <p>
            替换那一步会先关掉 WeQ 里正开着的这个账号，修完会把你送回启动页 ——
            <strong>期间不要自己打开这个账号的 QQ</strong>。
          </p>
          <p className="weq-repair-details-h">几种情况怎么说：</p>
          <ul>
            {REPAIR_NOTES.map((item) => (
              <li key={item.title}>
                <strong>{item.title}：</strong>
                {item.body}
              </li>
            ))}
          </ul>
        </RepairDisclosure>

        {/* ── 修复记录：默认收起（点开才铺列表，不然一直拖到最后又长又丑） ── */}
        {history.length > 0 ? (
          <details className="weq-repair-details weq-repair-history">
            <summary>
              <ChevronDown size={13} aria-hidden />
              <span className="weq-repair-label">修复记录</span>
              <span className="weq-repair-count">{history.length}</span>
            </summary>
            <div className="weq-repair-history-body">
              <ol className="weq-repair-timeline">
                {history.map((record) => {
                  const badge = STATE_BADGES[record.state];
                  const isConfirming = confirming?.id === record.id;
                  return (
                    <li
                      key={record.id}
                      className={`weq-repair-row weq-repair-record is-${badge.tone}${isConfirming ? ' is-confirming' : ''}`}
                    >
                      <span className="weq-repair-row-dot" aria-hidden />
                      <div className="weq-repair-row-main">
                        <div className="weq-repair-row-head">
                          <span className="weq-repair-mono">{record.dbName}</span>
                          <span className={`weq-repair-badge is-${badge.tone}`}>{badge.label}</span>
                          <span className="weq-repair-row-time">{shortTime(record.at)}</span>
                        </div>
                        <div className="weq-repair-row-meta">
                          <span>
                            {formatBytes(record.beforeBytes)} → {formatBytes(record.afterBytes)}
                          </span>
                          <span className="weq-repair-sep" aria-hidden />
                          <span>{(record.durationMs / 1000).toFixed(1)}s</span>
                          {record.badPages.length > 0 ? (
                            <>
                              <span className="weq-repair-sep" aria-hidden />
                              <span>坏页 {record.badPages.length}</span>
                            </>
                          ) : null}
                          {record.strictPages ? (
                            <>
                              <span className="weq-repair-sep" aria-hidden />
                              <span>坏页已清零</span>
                            </>
                          ) : null}
                        </div>
                        <p className="weq-repair-hint">{record.error ?? badge.hint}</p>

                        {/* 确认一律内联在这一行里 —— 位置与操作对象永远一致。 */}
                        {isConfirming && confirming?.action === 'restore' ? (
                          <div className="weq-repair-confirm">
                            {!preview?.backupExists ? (
                              <span>这条记录的备份已经被清理了，回滚不了。</span>
                            ) : preview.matchesAfter ? (
                              <span>库现在还是修复后的那一份，可以安全回滚到修复前。</span>
                            ) : (
                              <span className="is-warn">
                                警告：库在这之后又被写过（QQ
                                进了新消息）。回滚会把这些新内容一起丢掉 —— 确认要这么做再继续。
                              </span>
                            )}
                            <div className="weq-repair-actions">
                              <button
                                type="button"
                                className="weq-set-btn weq-set-btn-sm weq-set-btn-danger"
                                disabled={!preview?.backupExists || busy !== null}
                                onClick={() =>
                                  void handleRestore(record, preview?.matchesAfter === false)
                                }
                              >
                                {preview?.matchesAfter === false ? '丢弃新内容并回滚' : '确认回滚'}
                              </button>
                              <button
                                type="button"
                                className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
                                onClick={() => {
                                  setConfirming(null);
                                  setPreview(null);
                                }}
                              >
                                取消
                              </button>
                            </div>
                          </div>
                        ) : null}

                        {isConfirming && confirming?.action === 'delete' ? (
                          <div className="weq-repair-confirm">
                            <span className="is-warn">
                              删掉这条修复记录？记录与它的备份会一起被清理，之后不能再回滚到这一条。
                            </span>
                            <div className="weq-repair-actions">
                              <button
                                type="button"
                                className="weq-set-btn weq-set-btn-sm weq-set-btn-danger"
                                disabled={busy !== null}
                                onClick={() => void handleDeleteRecord(record)}
                              >
                                确认删除
                              </button>
                              <button
                                type="button"
                                className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
                                onClick={() => setConfirming(null)}
                              >
                                取消
                              </button>
                            </div>
                          </div>
                        ) : null}

                        {!isConfirming ? (
                          <div className="weq-repair-actions">
                            {record.state === 'applied' && record.canRestore ? (
                              <button
                                type="button"
                                className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
                                disabled={busy !== null}
                                onClick={() => void askRestore(record)}
                              >
                                <RotateCcw size={12} strokeWidth={2} aria-hidden />
                                回滚
                              </button>
                            ) : null}
                            {record.reportPath ? (
                              <button
                                type="button"
                                className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
                                onClick={() => void reveal(record, 'report')}
                              >
                                打开报告
                              </button>
                            ) : null}
                            {record.canRestore ? (
                              <button
                                type="button"
                                className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
                                onClick={() => void reveal(record, 'backup')}
                              >
                                打开备份位置
                              </button>
                            ) : (
                              <span className="weq-repair-hint">
                                {record.purgedAt
                                  ? `备份已于 ${shortTime(record.purgedAt)} 被保留策略清理`
                                  : '这条记录没有备份'}
                              </span>
                            )}
                            <button
                              type="button"
                              className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
                              disabled={busy !== null}
                              onClick={() => setConfirming({ id: record.id, action: 'delete' })}
                            >
                              <Trash2 size={12} strokeWidth={2} aria-hidden />
                              删除记录
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          </details>
        ) : null}
      </div>
    </>
  );
}
