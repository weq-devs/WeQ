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
 *      结果点级别 1 的开关、确认条出现在级别 3 下面。这里「回滚」「删备份」都是把那一行
 *      换成确认态，位置与操作对象永远一致。
 *   2. **渲染层只传 uin + 库名**。目录、密钥、算法都在主进程解析 —— 一旦接受路径，
 *      这个接口就变成任意路径写入器。
 *   3. **进度条不是装饰**：一次修复约 5 秒、六个阶段，没有它就等于「点了按钮之后卡死」。
 *      阶段名用主进程报的 `message`（本来就是中文），百分比直接用 `percent`。
 *   4. **中途失败必须说清源库没被动过**。服务层是「备份 → 产物 → 校验 → 替换」，
 *      任何一步失败都发生在替换之前，所以源库一个字节都没动 —— 这决定了重试是零成本的。
 *   5. **颜色一律走主题 token**（警示用 `--weq-warn-*`，它本身也是从主题强调色派生的），
 *      不另配一套颜色，否则与主题打架。按钮同理：直接用 `.weq-set-btn` 那一套（它已经把
 *      浅色 / 深色都适配好了），只为本面板特有的东西（提示条、进度、记录列表）新加
 *      `weq-repair-*` 样式。
 *   6. **修完必须把人送回首页**。替换库文件那一步会先 `clearAccount()`，主进程里账号
 *      已经关了，渲染层却还停在主界面上（有会话列表、没头像、点不开消息）。所以修完由
 *      全局的 `<DbRepairReturnOverlay>` 倒数几秒后自动回首页 —— 面板只管 `arm` 它。
 *
 * 视图类型在这里重新声明（而不是从主进程 import），与 `DatabaseDamagedDialog` 的
 * `DatabaseDamagedEvent` 同一套做法：渲染层只认「主进程答应给的那个形状」。
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  DatabaseZap,
  FolderOpen,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  ShieldAlert,
  Trash2,
  XCircle,
} from 'lucide-react';
import { client, trpc } from '../trpc/client';
import { useDbRepairReturn } from '../state/dbRepairReturn';
import { QqAvatar } from './QqAvatar';
import { useToast } from './Toast';

/** 账号选择用的最小信息（父级已有一份，不再重复探测）。 */
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

// ────────────────────────── 展示用的小工具 ──────────────────────────

/** 坏页清单只显示前若干个：整份可能上千个，铺满屏幕反而看不见结论。 */
const BAD_PAGE_PREVIEW = 30;

/** 修复任务跑着时的轮询间隔（锁状态、QQ pid 会变）。 */
const POLL_MS = 2000;

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

/**
 * 预检结论 → 界面措辞 + 该给什么按钮。
 *
 * `blocked-by-qq` 才给「结束 QQ 进程」：`blocked-by-other` 的持有者通常是 WeQ 自己
 * （当前打开着这个账号），那种情况下替换前会自动关掉，不需要用户动手。
 */
const READINESS_COPY: Record<
  DbRepairReadiness,
  { label: string; tone: 'ok' | 'warn' | 'muted'; detail: string }
> = {
  ready: { label: '可以开始', tone: 'ok', detail: '没有进程占用这个库，随时可以修。' },
  'blocked-by-qq': {
    label: 'QQ 正开着这个账号',
    tone: 'warn',
    detail:
      '修复要先解密源库，QQ 一边写、我们一边读会读出撕裂的页 —— 必须先把这个账号的 QQ 结束掉。',
  },
  'blocked-by-other': {
    label: '有进程占用',
    tone: 'warn',
    detail:
      '通常是 WeQ 自己打开着这个账号。可以照常开始：替换那一步会先把它关掉，之后重新打开即可。',
  },
  'unknown-lock': {
    label: '占用情况不明',
    tone: 'muted',
    detail:
      '这个平台上探测不到锁（权限或平台不支持）。不阻断，但替换前会再查一次；还是被占用的话会中止，源库不会被动。',
  },
};

export function DbRepairPanel({
  accounts,
  onRefreshAccounts,
  initialUin = null,
}: {
  accounts: DbRepairAccountOption[];
  /** 刷新左侧那份账号列表（修复会关掉账号，pid 与在线状态都可能变）。 */
  onRefreshAccounts: () => void;
  /** 打开时先选中的账号（损坏弹窗跳过来时带的就是出问题的那一个）。 */
  initialUin?: string | null;
}): ReactElement {
  const pushToast = useToast((s) => s.push);
  const armReturn = useDbRepairReturn((s) => s.arm);
  const utils = trpc.useUtils();

  const [pickedUin, setPickedUin] = useState<string | null>(initialUin);
  const [dbName, setDbName] = useState('nt_msg.db');
  /** 内联二次确认：哪一条记录、等的是哪种操作。 */
  const [confirming, setConfirming] = useState<{ id: string; action: 'restore' | 'purge' } | null>(
    null,
  );
  const [preview, setPreview] = useState<DbRepairRestorePreviewView | null>(null);
  const [progress, setProgress] = useState<{
    phase: string;
    percent: number;
    message: string;
  } | null>(null);
  const [report, setReport] = useState<BadPageScanReportView | null>(null);
  /** 正在跑的那件事（按钮据此禁用，避免同时发起两个任务）。 */
  const [busy, setBusy] = useState<'repair' | 'backup' | 'scan' | 'kill' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const uin = pickedUin ?? accounts[0]?.uin ?? null;
  const running = busy === 'repair';

  // 外部点名了账号（损坏弹窗 → 修复页）就跟过去 —— 多账号下才不会修错库。
  useEffect(() => {
    if (initialUin) setPickedUin(initialUin);
  }, [initialUin]);

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
  const scan = trpc.dbRepair.scanBadPages.useMutation();
  const killQq = trpc.dbRepair.killQq.useMutation();
  const restore = trpc.dbRepair.restore.useMutation();
  const removeBackup = trpc.dbRepair.deleteBackup.useMutation();
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

  const handleScan = async (): Promise<void> => {
    if (uin === null) return;
    setBusy('scan');
    setNotice(null);
    try {
      setReport((await scan.mutateAsync({ uin, dbName })) as BadPageScanReportView);
    } catch (error) {
      const text = errMsg(error);
      pushToast({ tone: 'error', title: '扫描坏页失败', detail: text });
      setNotice(text);
    } finally {
      setBusy(null);
    }
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
   *   1. **toast**：面板很长，失败说明只出现在底部那块 notice 里，用户很可能根本没
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

  const handleDeleteBackup = async (record: DbRepairRecordView): Promise<void> => {
    if (uin === null) return;
    setNotice(null);
    try {
      await removeBackup.mutateAsync({ uin, recordId: record.id });
      pushToast({
        tone: 'info',
        title: '已删除备份',
        detail: '记录会留着，但这一条不能再回滚了。',
      });
      await refreshAll();
    } catch (error) {
      const text = errMsg(error);
      pushToast({ tone: 'error', title: '删除备份失败', detail: text });
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
  if (accounts.length === 0) {
    return (
      <div className="weq-wtools-state">
        没有可用的账号配置 —— 先在 WeQ 里登录一次，或导入一份账号配置再来。
      </div>
    );
  }

  const readiness = preflight ? READINESS_COPY[preflight.readiness] : null;
  const currentRow = existingDbs.find((row) => row.dbName === dbName);
  const canStart = uin !== null && !busy && status?.keyPresent === true && preflight !== undefined;

  return (
    <>
      <header className="weq-wtools-pane-head">
        <div className="weq-wtools-pane-title">
          <DatabaseZap size={17} strokeWidth={1.9} />
          <h2 id="weq-wtools-title">数据库修复</h2>
          {status ? (
            <span className="weq-wtools-total">
              {status.qqPid !== null ? 'QQ 在线' : 'QQ 离线'}
              {status.busy ? ' · 任务进行中' : ''}
            </span>
          ) : null}
        </div>
      </header>

      <div className="weq-wtools-pane-body weq-repair-body">
        {/* ── 账号 ── */}
        <section className="weq-repair-block">
          <div className="weq-repair-block-head">
            <span className="weq-repair-label">账号</span>
            <button
              type="button"
              className="weq-wtools-refresh"
              onClick={() => {
                onRefreshAccounts();
                void refreshAll();
              }}
              disabled={busy !== null}
            >
              <RefreshCw size={13} strokeWidth={1.9} className={busy ? 'weq-spin' : ''} />
              刷新
            </button>
          </div>
          <div className="weq-repair-chips">
            {accounts.map((account) => {
              const active = account.uin === uin;
              return (
                <button
                  key={account.uin}
                  type="button"
                  className={`weq-repair-chip${active ? ' is-active' : ''}`}
                  aria-pressed={active}
                  onClick={() => {
                    setPickedUin(account.uin);
                    setReport(null);
                    setNotice(null);
                  }}
                >
                  <QqAvatar uin={account.uin} url={account.avatarUrl} size={22} />
                  <span>{account.name || account.uin}</span>
                </button>
              );
            })}
          </div>
        </section>

        {status?.error ? (
          <div className="weq-repair-note is-warn">
            <AlertTriangle size={14} strokeWidth={2} aria-hidden />
            <span>{status.error}</span>
          </div>
        ) : null}

        {/* 预检抛错（解析不出目录 / 库不存在 / 没密钥）就是"不能修"的原因，直接说。 */}
        {preflightQuery.error ? (
          <div className="weq-repair-note is-warn">
            <AlertTriangle size={14} strokeWidth={2} aria-hidden />
            <span>{errMsg(preflightQuery.error)}</span>
          </div>
        ) : null}

        {status && !status.keyPresent ? (
          <div className="weq-repair-note is-warn">
            <AlertTriangle size={14} strokeWidth={2} aria-hidden />
            <span>
              这个账号的配置里没有数据库密钥，修不了。先用 WeQ
              打开一次该账号（或重新扫描密钥）再来。
            </span>
          </div>
        ) : null}

        {/* ── 库 ── */}
        {existingDbs.length > 0 ? (
          <section className="weq-repair-block">
            <span className="weq-repair-label">数据库</span>
            <div className="weq-repair-chips">
              {existingDbs
                .filter((row) => row.exists)
                .map((row) => {
                  const active = row.dbName === dbName;
                  return (
                    <button
                      key={row.dbName}
                      type="button"
                      className={`weq-repair-chip is-mono${active ? ' is-active' : ''}`}
                      aria-pressed={active}
                      title={`${row.dbPath} · ${formatBytes(row.bytes)}`}
                      onClick={() => {
                        setDbName(row.dbName);
                        setReport(null);
                        setNotice(null);
                      }}
                    >
                      <span>{row.dbName}</span>
                      <em>{formatBytes(row.bytes)}</em>
                    </button>
                  );
                })}
            </div>
            {currentRow?.lastRecord ? (
              <p className="weq-repair-hint">
                上一次动这个库：{shortTime(currentRow.lastRecord.at)} ·{' '}
                {STATE_BADGES[currentRow.lastRecord.state].label}
              </p>
            ) : null}
          </section>
        ) : null}

        {/* ── 预检 ── */}
        {preflight && readiness ? (
          <div className={`weq-repair-note is-${readiness.tone}`}>
            {readiness.tone === 'ok' ? (
              <CheckCircle2 size={14} strokeWidth={2} aria-hidden />
            ) : (
              <ShieldAlert size={14} strokeWidth={2} aria-hidden />
            )}
            <span>
              <strong>{readiness.label}</strong> —— {readiness.detail}
            </span>
            {preflight.readiness === 'blocked-by-qq' && preflight.qqHolders[0] ? (
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
            ) : null}
          </div>
        ) : null}

        {preflight?.pendingWalBytes ? (
          <div className="weq-repair-note is-warn">
            <AlertTriangle size={14} strokeWidth={2} aria-hidden />
            <span>
              这个库旁边有一个<strong>未合并的预写日志</strong>（
              {formatBytes(preflight.pendingWalBytes)}）。QQ 崩溃或被强杀之后会留下它，里面是主文件
              里还没有的最后一批改动。修复会先把它并回主文件（不需要 QQ 参与），所以这批改动
              会一起进修复产物和备份；万一并不成功，报告里会写明「这批改动没修进去」。
            </span>
          </div>
        ) : null}

        {preflight &&
        preflight.freeBytes !== null &&
        preflight.freeBytes < preflight.requiredBytes ? (
          <div className="weq-repair-note is-warn">
            <AlertTriangle size={14} strokeWidth={2} aria-hidden />
            <span>
              磁盘空间不够：需要约 {formatBytes(preflight.requiredBytes)}（备份 + 明文中间件 +
              产物），可用只有 {formatBytes(preflight.freeBytes)}。
            </span>
          </div>
        ) : null}

        {/* ── 进度 ── */}
        {running && progress ? (
          <section className="weq-repair-progress" aria-live="polite">
            <div className="weq-repair-progress-head">
              <span>{progress.message || progress.phase}</span>
              <span className="weq-repair-progress-pct">{progress.percent}%</span>
            </div>
            <div className="weq-repair-progress-track">
              <div className="weq-repair-progress-fill" style={{ width: `${progress.percent}%` }} />
            </div>
            <p className="weq-repair-hint">
              修复期间<strong>不要打开这个账号的 QQ</strong>。替换那一步会先关掉 WeQ 里正开着的
              账号，修完会把你送回启动页重新打开。
            </p>
          </section>
        ) : null}

        {/* ── 动作 ── */}
        <section className="weq-repair-block">
          <span className="weq-repair-label">操作</span>
          <div className="weq-repair-actions">
            <button
              type="button"
              className="weq-set-btn weq-set-btn-sm"
              disabled={!canStart}
              onClick={() => void handleRepair()}
            >
              {running ? (
                <Loader2 size={13} className="weq-spin" aria-hidden />
              ) : (
                <Play size={13} strokeWidth={2} aria-hidden />
              )}
              {running ? '修复中…' : '开始修复'}
            </button>
            <button
              type="button"
              className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
              disabled={busy !== null || uin === null}
              onClick={() => void handleScan()}
            >
              {busy === 'scan' ? (
                <Loader2 size={13} className="weq-spin" aria-hidden />
              ) : (
                <ScanSearch size={13} strokeWidth={2} aria-hidden />
              )}
              {busy === 'scan' ? '扫描中…' : '扫描坏页'}
            </button>
            <button
              type="button"
              className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
              disabled={busy !== null || uin === null}
              onClick={() => void handleBackup()}
            >
              {busy === 'backup' ? (
                <Loader2 size={13} className="weq-spin" aria-hidden />
              ) : (
                <FolderOpen size={13} strokeWidth={2} aria-hidden />
              )}
              只备份
            </button>
          </div>
          <p className="weq-repair-hint">
            修复是<strong>重建</strong>而不是打补丁：产物是一份全新的库（没有 freelist 空洞），
            所以页数与体积会变，这是正常的。需要约 {formatBytes(preflight?.requiredBytes ?? 0)}{' '}
            空间；备份默认保留最近 3 份。
          </p>
        </section>

        {notice ? (
          <div className="weq-repair-note is-warn">
            <AlertTriangle size={14} strokeWidth={2} aria-hidden />
            <span>{notice}</span>
          </div>
        ) : null}

        {/* ── 坏页扫描报告 ── */}
        {report ? (
          <section className="weq-repair-block">
            <span className="weq-repair-label">坏页扫描（{report.dbName}）</span>
            <div className="weq-repair-kv">
              {!report.usedHmac ? (
                <span>
                  这个数据库没有开启页 HMAC，逐页校验无从做起 ——{' '}
                  <strong>这不代表数据库是好的</strong>，只是这张地图在这里没有意义。
                </span>
              ) : report.badPages.length === 0 ? (
                <span className="weq-repair-ok">
                  没有发现坏页（共 {report.pageCount} 页 / 每页 {report.pageSize} 字节）——
                  页层面是完好的。读不出来的话，问题可能在别处（例如密钥或索引）。
                </span>
              ) : (
                <>
                  <span>
                    共 {report.pageCount} 页，坏页 <strong>{report.badPages.length}</strong> 个
                    {report.zeroPages.length > 0 ? `，全零页 ${report.zeroPages.length} 个` : ''}
                    {report.trailingBytes > 0 ? `，文件尾残余 ${report.trailingBytes} 字节` : ''}
                    {report.badPages.length > BAD_PAGE_PREVIEW
                      ? `（下列只显示前 ${BAD_PAGE_PREVIEW} 个）`
                      : ''}
                    ：
                  </span>
                  <span className="weq-repair-mono">
                    {report.badPages.slice(0, BAD_PAGE_PREVIEW).join(', ')}
                  </span>
                  {report.affected.length > 0 ? (
                    <ul>
                      {report.affected.map((item) => (
                        <li key={`${item.name}:${item.pagetype}`}>
                          <span className="weq-repair-mono">{item.name}</span>（{item.pagetype}）
                          命中 {item.badPageCount} 个坏页
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span>坏页没能映射到具体对象，页号清单仍然有效。</span>
                  )}
                </>
              )}
            </div>
          </section>
        ) : null}

        {/* ── 修复记录 ── */}
        {history.length > 0 ? (
          <section className="weq-repair-block">
            <span className="weq-repair-label">修复记录</span>
            <ul className="weq-repair-history">
              {history.map((record) => {
                const badge = STATE_BADGES[record.state];
                const isConfirming = confirming?.id === record.id;
                return (
                  <li key={record.id} className={isConfirming ? 'is-confirming' : ''}>
                    <div className="weq-repair-history-main">
                      <span className="weq-repair-mono">{record.dbName}</span>
                      <span className={`weq-repair-badge is-${badge.tone}`}>{badge.label}</span>
                      <span className="weq-repair-history-meta">
                        {shortTime(record.at)} · {formatBytes(record.beforeBytes)} →{' '}
                        {formatBytes(record.afterBytes)} · {(record.durationMs / 1000).toFixed(1)}s
                        {record.badPages.length > 0 ? ` · 坏页 ${record.badPages.length}` : ''}
                        {record.strictPages ? ' · 坏页已清零' : ''}
                      </span>
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
                            警告：库在这之后又被写过（QQ 进了新消息）。回滚会把这些新内容一起丢掉 ——
                            确认要这么做再继续。
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

                    {isConfirming && confirming?.action === 'purge' ? (
                      <div className="weq-repair-confirm">
                        <span>删掉这条记录的备份？备份没了就回滚不了了，记录本身会留着。</span>
                        <div className="weq-repair-actions">
                          <button
                            type="button"
                            className="weq-set-btn weq-set-btn-sm weq-set-btn-danger"
                            onClick={() => void handleDeleteBackup(record)}
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
                          <>
                            <button
                              type="button"
                              className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
                              onClick={() => void reveal(record, 'backup')}
                            >
                              打开备份位置
                            </button>
                            <button
                              type="button"
                              className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
                              disabled={busy !== null}
                              onClick={() => setConfirming({ id: record.id, action: 'purge' })}
                            >
                              <Trash2 size={12} strokeWidth={2} aria-hidden />
                              删备份
                            </button>
                          </>
                        ) : (
                          <span className="weq-repair-hint">
                            {record.purgedAt
                              ? `备份已于 ${shortTime(record.purgedAt)} 被保留策略清理`
                              : '这条记录没有备份'}
                          </span>
                        )}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </>
  );
}
