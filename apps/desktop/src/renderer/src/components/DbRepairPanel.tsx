import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  Database,
  Download,
  FolderOpen,
  History,
  Info,
  Loader2,
  LockKeyhole,
  Pause,
  RefreshCw,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  Settings2,
  Square,
  Trash2,
  UnlockKeyhole,
  Wrench,
  X,
} from 'lucide-react';
import {
  databaseCanCheckQuickRepair,
  databaseReadyForRepair,
  databaseNeedsPageLocation,
  databaseRepairRecommendation,
  type DatabaseRepairMethod,
  databaseRepairSupportLabel,
  databaseMaintenanceRowAbnormal,
  databaseMaintenanceKindLabel as operationLabels,
  databaseMaintenanceStatusLabel as operationStates,
  databaseRepairStatusLabel as repairStates,
  type DatabaseMaintenanceStatus,
  type DatabaseMaintenanceStatusRow,
} from '@weq/service/db-checkup';
import type { DatabaseTaskProgress } from '@weq/service/db-progress';
import { NumericText } from './NumericText';
import { TimeLabel } from './TimeLabel';
import { client, trpc } from '../trpc/client';
import { useRenderDocument } from '../lib/renderDocument';
import { useDbRepairReturn } from '../state/dbRepairReturn';
import { useDialog } from './Dialog.shared';
import { QqAvatar } from './QqAvatar';
import { DatabaseMaintenanceProgress } from './DatabaseMaintenanceProgress';
import { SegmentedControl } from './SegmentedControl';
import { WindowSurface } from './WindowSurface';
import { formatBytesOrUnknown } from '../lib/format';
import { qqDatabasePurpose } from '../lib/qqDatabasePurpose';
import '../styles/db-repair-maintenance.css';

export interface DbRepairAccountOption {
  uin: string;
  configId?: string;
  dbName?: string;
  reportId?: string;
  diagnostic?: { title: string; message: string; details: string[]; reportPath: string | null };
  name: string;
  avatarUrl: string;
}
const recordStates = {
  applied: '修复成功',
  aborted: '已中止',
  'apply-failed': '修复失败',
  'rolled-back': '已恢复备份',
};
type Tone = 'ok' | 'warn' | 'run' | 'muted';

function rowLabel(row: DatabaseMaintenanceStatusRow) {
  if (row.repair) return repairStates[row.repair.status];
  if (row.deepStatus === 'running') return '深度检查中';
  if (row.deepStatus === 'partial') return '深度体检部分完成';
  if (row.deepStatus === 'failed') return '深度体检未完成';
  if (row.deepStatus === 'cancelled') return '深度体检已停止';
  if (row.deepStatus === 'completed') return '深度体检完成';
  return { pending: '尚未扫描', running: '扫描中', completed: '扫描完成', failed: '扫描未完成' }[
    row.scanStatus
  ];
}
function rowTone(row: DatabaseMaintenanceStatusRow): Tone {
  if (row.repair) {
    if (row.repair.status === 'running') return 'run';
    if (row.repair.status === 'completed') return 'ok';
    if (row.repair.status === 'failed' || row.repair.status === 'waiting') return 'warn';
    return 'muted';
  }
  if (row.scanStatus === 'running' || row.deepStatus === 'running') return 'run';
  if (row.scanStatus === 'pending') return 'muted';
  if (row.scanStatus === 'failed' || row.deepStatus === 'failed') return 'warn';
  if (row.deepStatus === 'cancelled') return 'muted';
  if (row.support === 'unsupported') return 'muted';
  if (databaseMaintenanceRowAbnormal(row)) return 'warn';
  if (row.deepStatus === 'completed' || row.deepStatus === 'partial') return 'ok';
  return row.scanStatus === 'completed' ? 'ok' : 'muted';
}
function rowSummary(row: DatabaseMaintenanceStatusRow): string {
  if (row.repair?.status === 'running') return '正在修复这个数据库。';
  if (row.repair?.status === 'failed') return '修复没有完成，原因见问题明细。';
  if (row.repair?.status === 'waiting') return '已保留扫描结果，处理问题后可重试。';
  if (row.repair?.status === 'cancelled') return '本轮修复已停止，这个库没有提交替换。';
  if (row.repair?.status === 'completed')
    return row.repair.verification?.healthy === false
      ? '产物已替换，复核发现结构异常。详情见下方。'
      : '已替换数据库并完成结构复核。';
  if (row.scanStatus === 'pending') return '还没扫描这个数据库。';
  if (row.scanStatus === 'running') {
    const current = row.progress?.current;
    return current?.message ? `${current.message}…` : '正在检查页签名。';
  }
  if (row.scanStatus === 'failed') return '扫描没有完成，暂时没有可用结论。';
  if (row.scan?.plaintext) return '明文数据库，当前重建工具不支持处理它。';
  if (row.scan?.badPageCount) {
    const count = row.scan.badPageCount.toLocaleString('zh-CN');
    const located = row.scan.affected?.reduce((sum, object) => sum + object.badPageCount, 0) ?? 0;
    if (!located)
      return `发现 ${count} 个坏页，${row.locationChecked ? '未能确认归属' : '尚未定位'}`;
    return `发现 ${count} 个坏页，已定位 ${located.toLocaleString('zh-CN')} 个`;
  }
  if (row.deepStatus === 'running') return '正在做结构体检，页扫描结果已经保留。';
  if (row.deepStatus === 'partial')
    return '深度体检部分完成，常规扫描结果可用；结构检查还有未核验的部分。';
  if (row.deepStatus === 'failed') return '深度体检没有跑完，常规扫描结果仍然保留。';
  if (row.deepStatus === 'cancelled') return '深度体检已停止，常规扫描结果仍然保留。';
  if (row.integrity?.ran && !row.integrity.healthy) return '结构检查发现异常，可以尝试重建修复。';
  if (row.integrity?.ran && row.integrity.complete === false)
    return '已检查的结构部分没有发现异常，但仍有未核验项，不能认定整库正常。';
  const diagnostic = row.issues.filter((issue) => issue.diagnostic !== false);
  if (diagnostic.length) return `发现 ${diagnostic.length} 项需要查看的问题。`;
  if (row.scan) {
    if (!row.scan.usedHmac) return '此数据库没有可校验的加密页签名。';
    return '页签名检查没有发现坏页。';
  }
  return '等待检查结果。';
}
function namesText(names: string[], limit = 3): string {
  return names.length <= limit
    ? names.join('、')
    : `${names.slice(0, limit).join('、')} 等 ${names.length} 个`;
}

function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`weq-dbm-chip is-${tone}`}>{children}</span>;
}

const maintenanceTabs = [
  { id: 'scan', label: '扫描', Icon: Database },
  { id: 'report', label: '报告', Icon: History },
  { id: 'repair', label: '修复', Icon: Wrench },
] as const;
type MaintenanceTab = (typeof maintenanceTabs)[number]['id'];

export function DbRepairPanel({
  currentUin,
  accounts,
  onRefreshAccounts,
  reportId: requestedReportId,
  resultRequest,
}: {
  currentUin: string | null;
  accounts: DbRepairAccountOption[];
  onRefreshAccounts: () => void;
  reportId?: string;
  resultRequest?: { uin: string; configId?: string; reportId?: string };
}) {
  const account = accounts.find((item) => item.uin === currentUin) ?? accounts[0];
  const ownerDocument = useRenderDocument();
  const scope = useMemo(
    () => ({ uin: account?.uin ?? '', configId: account?.configId }),
    [account?.uin, account?.configId],
  );
  const [live, setLive] = useState<DatabaseMaintenanceStatus | null>(null);
  const [reportId, setReportId] = useState(requestedReportId ?? account?.reportId);
  const [reportScope, setReportScope] = useState(scope);
  const sameReportScope = reportScope.uin === scope.uin && reportScope.configId === scope.configId;
  const [legacyId, setLegacyId] = useState<string>();
  const [focused, setFocused] = useState(account?.dbName);
  const [tab, setTab] = useState<MaintenanceTab>('scan');
  const [scanSelection, setScanSelection] = useState<string[] | undefined>(
    account?.dbName ? [account.dbName] : undefined,
  );
  const [nextScanSelection, setNextScanSelection] = useState<string[]>();
  const [selected, setSelected] = useState<string[]>([]);
  const [deepChoices, setDeepChoices] = useState<string[]>([]);
  const [backupChoices, setBackupChoices] = useState<Record<string, boolean>>({});
  const [strictPages, setStrictPages] = useState(false);
  const [allowLowSpace, setAllowLowSpace] = useState(false);
  const [starting, setStarting] = useState<'scan' | 'checkup' | 'repair' | null>(null);
  const [scanKind, setScanKind] = useState<'scan' | 'checkup'>('scan');
  const [surface, setSurface] = useState<'history' | 'settings' | null>(null);
  const [surfaceAnchor, setSurfaceAnchor] = useState<HTMLElement>();
  const [reportFocused, setReportFocused] = useState<string>();
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState(false);
  const touched = useRef(new Set<string>());
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastOperation = useRef<string | undefined>(undefined);
  const displayedOperation = useRef<string | undefined>(undefined);
  const sessionId = useRef<string | undefined>(undefined);
  const optionsRef = useRef<HTMLDetailsElement>(null);
  const utils = trpc.useUtils();
  const status = trpc.dbRepair.status.useQuery(scope, { enabled: !!scope.uin, retry: false });
  const maintenance = trpc.dbRepair.maintenance.useQuery(scope, {
    enabled: !!scope.uin,
    refetchInterval: 2000,
    retry: false,
  });
  const reports = trpc.dbRepair.reports.useQuery(scope, { enabled: !!scope.uin, retry: false });
  const history = trpc.dbRepair.history.useQuery(scope, { enabled: !!scope.uin, retry: false });
  const report = trpc.dbRepair.reportStatus.useQuery(
    { ...reportScope, reportId: reportId ?? '' },
    {
      enabled: !!reportId,
      retry: false,
      cacheTime: 0,
      refetchInterval: (value) =>
        !sameReportScope && value?.operation?.status === 'running' ? 1000 : false,
    },
  );
  const legacy = trpc.dbRepair.legacyReport.useQuery(
    { ...scope, recordId: legacyId ?? '' },
    { enabled: !!legacyId, retry: false },
  );
  const cache = trpc.dbRepair.cacheLocation.useQuery(undefined);
  const scan = trpc.dbRepair.scanAccount.useMutation();
  const repair = trpc.dbRepair.repairSelected.useMutation();
  const stop = trpc.dbRepair.stopMaintenance.useMutation();
  const end = trpc.dbRepair.endMaintenance.useMutation();
  const exportReport = trpc.dbRepair.exportMaintenanceReport.useMutation();
  const exportLegacy = trpc.dbRepair.exportLegacyReport.useMutation();
  const pickCache = trpc.dbRepair.pickCacheLocation.useMutation();
  const resetCache = trpc.dbRepair.resetCacheLocation.useMutation();
  const deleteReport = trpc.dbRepair.deleteReport.useMutation();
  const deleteRecord = trpc.dbRepair.deleteRecord.useMutation();

  useEffect(() => {
    const dismissOptions = (event: PointerEvent) => {
      const options = optionsRef.current;
      if (options?.open && !event.composedPath().includes(options)) options.open = false;
    };
    ownerDocument.addEventListener('pointerdown', dismissOptions, true);
    return () => ownerDocument.removeEventListener('pointerdown', dismissOptions, true);
  }, [ownerDocument]);
  useEffect(() => {
    if (maintenance.data !== undefined) setLive(maintenance.data);
  }, [maintenance.data]);
  useEffect(() => {
    if (
      resultRequest &&
      !resultRequest.reportId &&
      (resultRequest.uin !== scope.uin || resultRequest.configId !== scope.configId)
    )
      return;
    setReportId(resultRequest ? resultRequest.reportId : (requestedReportId ?? account?.reportId));
    setReportScope(
      resultRequest?.reportId
        ? { uin: resultRequest.uin, configId: resultRequest.configId }
        : scope,
    );
    setLegacyId(undefined);
    if (resultRequest?.reportId || requestedReportId || account?.reportId) setSurface('history');
  }, [requestedReportId, account?.reportId, resultRequest, scope]);
  useEffect(() => {
    const operation = live?.operation;
    if (!operation || operation.status === 'running') return;
    const key = `${operation.id}:${operation.status}`;
    if (lastOperation.current === key) return;
    lastOperation.current = key;
    if (operation.kind === 'repair' && !['completed', 'cancelled'].includes(operation.status)) {
      setTab('report');
      setFocused(live?.databases.find((row) => row.repair?.error)?.dbName);
    } else if (operation.kind !== 'repair' && operation.status !== 'cancelled') {
      setTab((current) => (current === 'scan' ? 'report' : current));
    }
  }, [live]);
  useEffect(() => {
    const kind = live?.operation?.kind;
    if (kind === 'scan' || kind === 'checkup') setScanKind(kind);
  }, [live?.operation?.id, live?.operation?.kind]);
  useEffect(() => {
    const sub = client.dbRepair.onMaintenance.subscribe(undefined, {
      onData(snapshot) {
        if (snapshot.uin !== scope.uin || snapshot.configId !== scope.configId) return;
        setLive(snapshot);
        setConnectionError(false);
        if (snapshot.operation?.status !== 'running') {
          void utils.dbRepair.reports.invalidate(scope);
          void utils.dbRepair.history.invalidate(scope);
        }
      },
      onError() {
        setConnectionError(true);
      },
    });
    return () => sub.unsubscribe();
  }, [scope, utils]);
  useEffect(() => {
    if (!live) return;
    if (sessionId.current !== live.id) {
      sessionId.current = live.id;
      touched.current.clear();
      setSelected([]);
      setDeepChoices([]);
    }
    const defaults = live.databases
      .filter(
        (row) =>
          databaseRepairRecommendation(row) &&
          row.support === 'supported' &&
          row.issues.some((issue) => issue.diagnostic !== false) &&
          !touched.current.has(row.dbName),
      )
      .map((row) => row.dbName);
    if (defaults.length)
      setSelected((values) =>
        defaults.every((name) => values.includes(name))
          ? values
          : [...new Set([...values, ...defaults])],
      );
  }, [live]);
  const refresh = async () => {
    await Promise.all([
      utils.dbRepair.maintenance.invalidate(scope),
      utils.dbRepair.reports.invalidate(scope),
      utils.dbRepair.history.invalidate(scope),
      utils.dbRepair.status.invalidate(scope),
    ]);
    onRefreshAccounts();
  };
  const act = async (run: () => Promise<unknown>) => {
    setError('');
    try {
      await run();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const startScan = (kind: 'scan' | 'checkup', dbNames: string[]) =>
    act(async () => {
      if (!dbNames.length) return;
      window.electron?.ipcRenderer.send('db-repair:scope', scope);
      setTab('scan');
      setReportId(undefined);
      setReportScope(scope);
      setLegacyId(undefined);
      setStarting(kind);
      setAllowLowSpace(false);
      try {
        setLive(await scan.mutateAsync({ ...scope, kind, dbNames }));
        await refresh();
      } finally {
        setStarting(null);
      }
    });
  const endMaintenance = () =>
    act(async () => {
      if (
        !(await useDialog
          .getState()
          .confirm(
            '结束数据库维护？',
            '放弃本次扫描结果并释放此账号全部目标数据库的维护锁。历史报告继续保留；下次修复需要主动重新扫描。',
            { okLabel: '放弃结果并结束维护', cancelLabel: '继续维护', ownerDocument },
          ))
      )
        return;
      await end.mutateAsync(scope);
      await refresh();
    });
  const startRepair = () =>
    act(async () => {
      const names = selectedReady;
      if (!names.length) return;
      const quickNames = names.filter((name) => methods[name] === 'quick');
      const deepNames = names.filter((name) => methods[name] === 'deep');
      const detail = [
        quickNames.length
          ? `${quickNames.join('、')} 将先核验快速修复条件，通过后修复并保留消息记录。`
          : '',
        deepNames.length ? `${deepNames.join('、')} 将重建数据库，损坏的记录可能无法恢复。` : '',
      ]
        .filter(Boolean)
        .join('');
      if (
        !(await useDialog
          .getState()
          .confirm('修复所选数据库？', `${detail}修复可以停止，已修复的库会保留结果。`, {
            okLabel: '开始修复',
            cancelLabel: '继续查看',
            ownerDocument,
          }))
      ) {
        setAllowLowSpace(false);
        return;
      }
      setReportId(undefined);
      setReportScope(scope);
      setLegacyId(undefined);
      setTab('repair');
      setStarting('repair');
      try {
        const result = await repair.mutateAsync({
          ...scope,
          dbNames: names,
          methods,
          backups,
          strictPages,
          allowLowSpace,
        });
        setLive(result.snapshot);
        if (result.closedAccount)
          useDbRepairReturn.getState().arm({
            title: '本轮数据库维护已结束',
            detail: '数据库替换前已关闭当前账号，请从主页重新打开。',
            tone: result.snapshot.operation?.status === 'completed' ? 'ok' : 'warn',
          });
        await refresh();
      } catch (error) {
        setTab('report');
        throw error;
      } finally {
        setStarting(null);
        setAllowLowSpace(false);
      }
    });
  const restore = (recordId: string) =>
    act(async () => {
      const preview = await client.dbRepair.restorePreview.query({ ...scope, recordId });
      if (!preview.backupExists) throw new Error('这份备份已经不在了。');
      if (
        !(await useDialog
          .getState()
          .confirm(
            '恢复修复前的数据库？',
            `${preview.record.dbName} 将恢复为这份备份。${preview.matchesAfter ? '' : '当前数据库已变化或仍有未合并的日志，恢复会覆盖修复之后的数据。'}`,
            { okLabel: '恢复备份', cancelLabel: '取消', ownerDocument },
          ))
      )
        return;
      const result = await client.dbRepair.restore.mutate({
        ...scope,
        recordId,
        force: !preview.matchesAfter,
      });
      if (!result.ok) throw new Error(result.error);
      if (result.closedAccount)
        useDbRepairReturn
          .getState()
          .arm({ title: '数据库备份已恢复', detail: '请从主页重新打开账号。' });
      await refresh();
    });

  const historical = !!reportId || !!legacyId;
  const historicalView = reportId
    ? sameReportScope && live?.operation?.id === reportId
      ? live
      : report.data
    : undefined;
  const historicalRow =
    historicalView?.databases.find((row) => row.dbName === reportFocused) ??
    historicalView?.databases[0];
  const view = live;
  const busyStarting = starting !== null;
  const running = live?.operation?.status === 'running' || busyStarting;
  const repairing =
    live?.state === 'repairing' ||
    starting === 'repair' ||
    (live?.operation?.status === 'running' && live.operation.kind === 'repair');
  const ending = live?.state === 'ending';
  const locked = !!live?.locked && live.state !== 'ended';
  const waiting = live?.state === 'waiting' && !ending;
  const paused =
    waiting && live?.operation?.kind !== 'repair' && live?.operation?.status === 'cancelled';
  const scanRunning = running && !repairing;
  const available = status.data?.databases.filter((row) => row.exists) ?? [];
  const databases = view?.databases ?? [];
  const maintainedRows = new Map(databases.map((row) => [row.dbName, row]));
  const scanCandidates = locked
    ? available.filter(({ dbName }) => {
        const row = maintainedRows.get(dbName);
        if (!row) return true;
        if (row.scanStatus !== 'completed') return row.support !== 'unsupported';
        return scanKind === 'checkup' && row.deepStatus !== 'completed';
      })
    : available;
  const candidateNames = scanCandidates.map((row) => row.dbName);
  const scanSelectionForAction = locked
    ? (nextScanSelection ?? candidateNames.filter((name) => maintainedRows.has(name)))
    : scanSelection;
  const scanNames = scanSelectionForAction
    ? candidateNames.filter((name) => scanSelectionForAction.includes(name))
    : candidateNames;
  const allScanSelected = scanNames.length === candidateNames.length;
  const setScanCandidates = locked ? setNextScanSelection : setScanSelection;
  const operation = view?.operation;
  const bytesByName = useMemo(
    () => new Map(status.data?.databases.map((row) => [row.dbName, row.bytes]) ?? []),
    [status.data],
  );
  const activeRow =
    databases.find((row) => row.dbName === focused) ??
    databases.find((row) => row.dbName === view?.operation?.currentDb) ??
    databases.find(databaseMaintenanceRowAbnormal) ??
    databases[0];
  const progressOwner =
    operation?.status === 'running'
      ? databases.find((row) => row.dbName === operation.currentDb)
      : activeRow;
  const progress = progressOwner?.progress ?? view?.progress;
  const plans = databases.flatMap((row) => {
    const recommended = databaseRepairRecommendation(row);
    if (!recommended) return [];
    const canCheckQuick = databaseCanCheckQuickRepair(row);
    const method = canCheckQuick && !deepChoices.includes(row.dbName) ? 'quick' : recommended;
    return [
      { row, method, canCheckQuick, budgetPending: method === 'quick' && !row.quickBudgetBytes },
    ];
  });
  const readyNames = plans.map(({ row }) => row.dbName);
  const methods = Object.fromEntries(plans.map(({ row, method }) => [row.dbName, method]));
  const backups = Object.fromEntries(
    plans.map(({ row, method }) => [
      row.dbName,
      backupChoices[`${method}:${row.dbName}`] ?? method === 'deep',
    ]),
  );
  const selectedReady = selected.filter((name) => readyNames.includes(name));
  const selectedWithBudget = plans
    .filter(({ row, budgetPending }) => !budgetPending && selectedReady.includes(row.dbName))
    .map(({ row }) => row.dbName);
  const scannedCount = databases.filter((row) => row.scanStatus === 'completed').length;
  const abnormalCount = databases.filter((row) => databaseMaintenanceRowAbnormal(row)).length;
  const scanAction = !locked
    ? '开始扫描'
    : !scanCandidates.length
      ? '扫描已完成'
      : paused
        ? '继续扫描'
        : scanNames.some((name) => !maintainedRows.has(name)) || !scanNames.length
          ? '追加扫描'
          : scanKind === 'checkup'
            ? '开始补充检查'
            : '继续扫描';
  const maintenanceLabel = ending
    ? '正在解锁'
    : repairing
      ? '修复中'
      : scanRunning
        ? locked
          ? '扫描中'
          : '准备中'
        : locked
          ? '维护中'
          : '已结束';
  const canScan = !!(status.data?.keyPresent && !status.data.error && !running && !ending);
  const showFooter = tab === 'repair' && waiting && !running && readyNames.length > 0;
  const showScanSetup = tab === 'scan' && !scanRunning && !repairing && !ending;
  const selectedBackups = selectedReady.filter((name) => backups[name]).length;
  const hasDeep = selectedReady.some((name) => methods[name] === 'deep');
  const needsLocation = !!(activeRow && databaseNeedsPageLocation(activeRow));
  const activeRepair = activeRow && databaseRepairRecommendation(activeRow);
  const activeCanCheckQuick = !!(activeRow && databaseCanCheckQuickRepair(activeRow));
  const reportIdToExport = operation?.id;
  const activeProgress =
    progress && (progress.status === 'running' || progress.steps.length > 0) ? progress : undefined;
  const alerts = [
    ...new Set(
      [
        surface ? '' : error,
        live?.maintenanceError,
        operation?.error,
        live?.reportError,
        maintenance.error ? `无法读取维护状态：${maintenance.error.message}` : '',
        status.error?.message,
        status.data?.error,
      ].filter((value): value is string => !!value),
    ),
  ];
  useLayoutEffect(() => {
    const current = live?.operation;
    if (current?.status === 'running' && displayedOperation.current !== current.id) {
      if (bodyRef.current) bodyRef.current.scrollTop = 0;
      displayedOperation.current = current.id;
    }
  }, [live?.operation]);
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [scope, tab]);

  const selectAll = (checked: boolean) => {
    for (const name of readyNames) touched.current.add(name);
    setSelected(checked ? [...readyNames] : []);
    setAllowLowSpace(false);
  };
  const allReadySelected =
    readyNames.length > 0 && readyNames.every((name) => selected.includes(name));
  const closeReport = () => {
    setReportId(undefined);
    setReportScope(scope);
    setLegacyId(undefined);
  };
  const changeCache = () =>
    act(async () => {
      await pickCache.mutateAsync();
      setAllowLowSpace(false);
      await cache.refetch();
      await utils.dbRepair.preflight.invalidate();
      await utils.dbRepair.repairStorage.invalidate();
    });
  const closeSurface = () => {
    setSurface(null);
    closeReport();
  };
  const removeReport = (id: string, legacy = false, hasBackup = false) =>
    act(async () => {
      if (
        !(await useDialog
          .getState()
          .confirm(
            legacy ? '删除这条修复记录？' : '删除这份历史报告？',
            hasBackup
              ? '这条修复记录和对应备份会一并删除，之后无法使用这份备份恢复。不会更改当前数据库。'
              : '删除后无法再查看或导出这份报告，不会更改当前数据库或其他修复备份。',
            { okLabel: '删除', cancelLabel: '取消', danger: 'outline', ownerDocument },
          ))
      )
        return;
      if (legacy) await deleteRecord.mutateAsync({ ...scope, recordId: id });
      else await deleteReport.mutateAsync({ ...scope, reportId: id });
      if (reportId === id || legacyId === id) closeReport();
      await refresh();
    });
  const pauseOrStop = () =>
    act(async () => {
      const result = await stop.mutateAsync(scope);
      if (result) setLive(result);
      await refresh();
    });
  const onExportCurrent = (format: 'html' | 'md' | 'json') => {
    if (reportIdToExport)
      void act(() => exportReport.mutateAsync({ ...scope, reportId: reportIdToExport, format }));
  };
  const showProgress = (tab === 'scan' && scanRunning) || (tab === 'repair' && repairing);
  const showLiveOperation = showProgress && operation?.status === 'running';
  const showReportSummary =
    tab === 'report' && waiting && !running && !!operation && databases.length > 0;
  const showDatabaseStatus = tab === 'report' || showLiveOperation;
  const visibleDatabases =
    tab === 'report'
      ? databases
      : databases.filter(
          (row) =>
            operation?.databaseNames?.includes(row.dbName) ?? (tab !== 'repair' || !!row.repair),
        );
  const scanCoverage = `${scannedCount} / ${databases.length} 已扫描`;
  const repairAvailability = readyNames.length ? ` · ${readyNames.length} 个可修复` : '';
  const stopping = stop.isLoading || !!operation?.stopping;
  const deepScan =
    starting === 'checkup' || (operation?.status === 'running' && operation.kind === 'checkup');
  const progressTitle = repairing
    ? stopping
      ? '正在停止修复'
      : '正在修复数据库'
    : stopping
      ? '正在暂停扫描'
      : live?.state === 'locking'
        ? '正在锁定数据库'
        : deepScan
          ? '正在深度体检'
          : '正在扫描数据库';

  return (
    <section className="weq-dbm" aria-label="数据库修复">
      <header className="weq-dbm-head">
        <div className="weq-dbm-title">
          <span className="weq-dbm-title-icon" aria-hidden>
            <Database size={17} strokeWidth={1.9} />
          </span>
          <div>
            <h1>数据库检查与修复</h1>
          </div>
        </div>
        <div className="weq-dbm-identity">
          {account ? (
            <button
              type="button"
              className="weq-dbm-head-btn"
              title="历史报告与恢复"
              aria-label="历史报告与恢复"
              aria-expanded={surface === 'history'}
              onClick={(event) => {
                closeReport();
                setSurfaceAnchor(event.currentTarget);
                setSurface(surface === 'history' ? null : 'history');
              }}
            >
              <History size={15} />
            </button>
          ) : null}
          <button
            type="button"
            className="weq-dbm-head-btn"
            title="数据库修复设置"
            aria-label="数据库修复设置"
            aria-expanded={surface === 'settings'}
            onClick={(event) => {
              closeReport();
              setSurfaceAnchor(event.currentTarget);
              setSurface(surface === 'settings' ? null : 'settings');
            }}
          >
            <Settings2 size={15} />
          </button>
          {account ? (
            <span className="weq-dbm-account">
              <QqAvatar uin={account.uin} url={account.avatarUrl} size={22} />
              <span>{account.name}</span>
            </span>
          ) : null}
          {account?.name !== scope.uin ? (
            <span className="weq-dbm-scope" title={scope.configId}>
              {scope.uin}
            </span>
          ) : null}
          {locked || running || operation ? (
            <span className="weq-dbm-state" title={maintenanceLabel} aria-label={maintenanceLabel}>
              {locked ? (
                <LockKeyhole size={12} strokeWidth={2} aria-hidden />
              ) : (
                <Database size={12} aria-hidden />
              )}
              {maintenanceLabel}
            </span>
          ) : null}
        </div>
      </header>

      <div className="weq-dbm-steps" role="tablist" aria-label="数据库维护">
        {maintenanceTabs.map(({ id, label, Icon }, index) => (
          <button
            id={`dbm-tab-${id}`}
            key={id}
            className={`weq-dbm-step${tab === id ? ' is-current' : ''}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            aria-controls="dbm-tab-content"
            onClick={() => setTab(id)}
            onKeyDown={(event) => {
              const offset = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
              if (!offset && event.key !== 'Home' && event.key !== 'End') return;
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? maintenanceTabs.length - 1
                    : (index + offset + maintenanceTabs.length) % maintenanceTabs.length;
              const target = maintenanceTabs[next]!;
              setTab(target.id);
              ownerDocument.getElementById(`dbm-tab-${target.id}`)?.focus();
            }}
          >
            <span className="weq-dbm-step-dot" aria-hidden>
              <Icon size={12} />
            </span>
            <span className="weq-dbm-step-text">
              <strong>{label}</strong>
            </span>
          </button>
        ))}
      </div>

      <div
        className="weq-dbm-body"
        ref={bodyRef}
        id="dbm-tab-content"
        role="tabpanel"
        aria-labelledby={`dbm-tab-${tab}`}
      >
        {alerts.map((message) => (
          <p className="weq-dbm-alert" role="alert" key={message}>
            <AlertTriangle size={15} aria-hidden />
            <span>{message}</span>
            <button
              type="button"
              className="weq-dbm-text-btn"
              disabled={running}
              onClick={() => void refresh()}
            >
              <RefreshCw size={12} />
              刷新
            </button>
          </p>
        ))}
        {connectionError && running && !activeProgress ? (
          <p className="weq-dbm-alert" role="alert">
            <AlertTriangle size={15} aria-hidden />
            <span>进度连接中断，正在重新连接；任务结果尚未确认。</span>
          </p>
        ) : null}

        {showScanSetup ? (
          <div className="weq-dbm-scan-setup">
            <section className="weq-dbm-scan-controls" aria-label="扫描设置">
              <button
                className="weq-set-btn weq-set-btn-primary weq-dbm-scan-start"
                type="button"
                disabled={!canScan || !scanNames.length}
                onClick={() => void startScan(scanKind, scanNames)}
              >
                <ScanLine size={30} strokeWidth={1.6} aria-hidden />
                {scanAction}
              </button>
              <SegmentedControl
                label="体检类型"
                value={scanKind}
                options={[
                  { value: 'scan', label: '快速体检', title: '检查数据库页签名' },
                  { value: 'checkup', label: '深度体检', title: '定位坏页并检查数据库结构' },
                ]}
                onChange={(kind) => {
                  setScanKind(kind);
                  setNextScanSelection(undefined);
                }}
              />
              <p role="status">
                {status.data && !status.data.keyPresent && !status.data.error
                  ? '请先用 WeQ 打开一次这个账号，获取数据库密钥后再扫描。'
                  : paused
                    ? '扫描已暂停，已完成的检查会保留。'
                    : locked
                      ? '已完成的检查会保留。'
                      : available.length && !scanNames.length
                        ? '请在下方至少选择一个数据库。'
                        : '扫描只读取所选数据库，维护期间会暂停写入。'}
              </p>
            </section>

            <section className="weq-dbm-scan-databases" aria-label="选择数据库">
              <div className="weq-dbm-dbs-head">
                <h2>数据库</h2>
                {scanCandidates.length ? (
                  <div className="weq-dbm-dbs-tools">
                    <span className="weq-dbm-selected">
                      <NumericText>{`已选 ${scanNames.length} / ${scanCandidates.length}`}</NumericText>
                    </span>
                    <button
                      type="button"
                      className="weq-dbm-text-btn"
                      onClick={() => setScanCandidates(allScanSelected ? [] : candidateNames)}
                    >
                      {allScanSelected ? '取消全选' : '全选'}
                    </button>
                  </div>
                ) : null}
              </div>
              {scanCandidates.length ? (
                <ul className="weq-dbm-list">
                  {scanCandidates.map((row) => (
                    <li key={row.dbName}>
                      <DatabaseCard
                        dbName={row.dbName}
                        bytes={row.bytes}
                        selection={{
                          checked: scanNames.includes(row.dbName),
                          onChange: (checked) =>
                            setScanCandidates(
                              checked
                                ? [...scanNames, row.dbName]
                                : scanNames.filter((name) => name !== row.dbName),
                            ),
                        }}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={status.isLoading ? 'weq-dbm-loading' : 'weq-dbm-empty'} role="status">
                  {status.isLoading
                    ? '正在读取数据库列表…'
                    : locked
                      ? `没有待${scanKind === 'checkup' ? '深度体检' : '快速体检'}的数据库。`
                      : '没有可扫描的数据库。'}
                </p>
              )}
            </section>
          </div>
        ) : null}

        {showProgress ? (
          <section className="weq-dbm-hero is-run" aria-label="维护进度">
            <span className="weq-dbm-hero-icon" aria-hidden>
              <Loader2 size={22} className="weq-spin" />
            </span>
            <div className="weq-dbm-hero-main" role="status">
              <h2>{progressTitle}</h2>
              <p>
                {operation?.status === 'running'
                  ? `${operation.completedDatabases} / ${operation.totalDatabases} 个数据库完成${operation.currentDb ? ` · 当前 ${operation.currentDb}` : ''}`
                  : '正在准备…'}
              </p>
            </div>
            <div className="weq-dbm-hero-actions">
              <button
                type="button"
                className="weq-set-btn"
                disabled={stopping || operation?.status !== 'running'}
                onClick={() => void pauseOrStop()}
              >
                {repairing ? <Square size={13} /> : <Pause size={14} />}
                {stopping
                  ? repairing
                    ? '正在停止'
                    : '正在暂停'
                  : repairing
                    ? '停止修复'
                    : '暂停扫描'}
              </button>
            </div>
          </section>
        ) : null}
        {tab === 'scan' && repairing ? (
          <p role="status">修复正在继续，可切换到「修复」查看进度。</p>
        ) : null}
        {tab === 'repair' ? (
          <RepairStorageWarning
            scope={scope}
            names={selectedWithBudget}
            backups={backups}
            methods={methods}
            enabled={showFooter && selectedWithBudget.length > 0}
            storage={repairing ? live?.storage : undefined}
            onChangeCache={() => void changeCache()}
            cacheDisabled={repairing || pickCache.isLoading || resetCache.isLoading}
          />
        ) : null}

        {tab === 'report' && !databases.length ? (
          account?.diagnostic ? (
            <section className="weq-dbm-callout">
              <AlertTriangle size={16} aria-hidden />
              <div>
                <strong>{account.diagnostic.title}</strong>
                <p>{account.diagnostic.message}</p>
                {account.diagnostic.details.map((detail) => (
                  <p key={detail}>{detail}</p>
                ))}
                {account.diagnostic.reportPath ? (
                  <p className="weq-dbm-path">{account.diagnostic.reportPath}</p>
                ) : null}
              </div>
            </section>
          ) : (
            <p>开始扫描后可在这里查看本轮报告。</p>
          )
        ) : null}
        {tab === 'repair' && !repairing && !showFooter ? (
          <p>报告中有可用的修复方案时，可从对应数据库打开。</p>
        ) : null}
        {showReportSummary ? (
          <section
            className={`weq-dbm-hero${abnormalCount || operation.status === 'waiting' ? ' is-warn' : ''}`}
            aria-label="本轮检查结论"
          >
            <span className="weq-dbm-hero-icon" aria-hidden>
              {abnormalCount || operation.status === 'waiting' ? (
                <AlertTriangle size={22} />
              ) : (
                <Database size={22} />
              )}
            </span>
            <div className="weq-dbm-hero-main" role="status">
              <h2>
                {operation.kind === 'repair' && operation.status === 'waiting'
                  ? '修复未完成，等待重试'
                  : paused
                    ? '扫描已暂停'
                    : abnormalCount
                      ? `${abnormalCount} 个数据库发现异常`
                      : operation.status === 'completed' && scannedCount === databases.length
                        ? '本轮检查完成'
                        : '本轮检查未完成'}
              </h2>
              <p>
                <NumericText>{`${scanCoverage}${repairAvailability}`}</NumericText>
              </p>
            </div>
          </section>
        ) : null}
        {showDatabaseStatus && visibleDatabases.length > 0 ? (
          <section className="weq-dbm-dbs" aria-label="数据库列表">
            <div className="weq-dbm-dbs-head">
              <h2>数据库</h2>
              {tab === 'report' && !showReportSummary && !repairing ? (
                <span className="weq-dbm-dbs-meta">
                  <NumericText>{`${scanCoverage}${abnormalCount ? ` · ${abnormalCount} 个异常` : ''}${repairAvailability}`}</NumericText>
                </span>
              ) : null}
            </div>
            <ul className="weq-dbm-list">
              {visibleDatabases.map((row) => (
                <li key={row.dbName}>
                  <DatabaseCard
                    row={row}
                    bytes={bytesByName.get(row.dbName)}
                    current={
                      (tab === 'report' ? activeRow?.dbName : operation?.currentDb) === row.dbName
                    }
                    onFocus={tab === 'report' ? () => setFocused(row.dbName) : undefined}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {(showLiveOperation || tab === 'report' || (tab === 'scan' && paused)) && activeProgress ? (
          <details className="weq-dbm-process" open={running || undefined}>
            <summary>
              <span className="weq-dbm-process-title">
                {running ? <Loader2 size={14} className="weq-spin" /> : <History size={14} />}
                {running ? '执行进度' : '本次执行过程'}
              </span>
              {!running && operation ? (
                <span className="weq-dbm-process-hint">
                  {`${operationLabels[operation.kind]} · ${operationStates[operation.status]} · ${operation.completedDatabases} / ${operation.totalDatabases} 个数据库`}
                </span>
              ) : null}
              <ChevronDown size={14} className="weq-dbm-chevron" aria-hidden />
            </summary>
            <div className="weq-dbm-process-body">
              <DatabaseMaintenanceProgress
                progress={activeProgress}
                batch={operation ? { ...operation, locked: locked && !ending } : undefined}
                connectionError={connectionError && running}
                showBatch={false}
                showMaintained={false}
              />
            </div>
          </details>
        ) : showLiveOperation ? (
          <p className="weq-dbm-operation" role="status">
            {operationLabels[operation.kind]} · {operationStates[operation.status]} ·{' '}
            {operation.completedDatabases} / {operation.totalDatabases} 个数据库
            {operation.error ? `；${operation.error}` : ''}
          </p>
        ) : null}

        {tab === 'report' && activeRow ? (
          <>
            <DatabaseDetail row={activeRow} bytes={bytesByName.get(activeRow.dbName)} />
            <div className="weq-dbm-report-actions">
              {waiting &&
              activeRow.scanStatus === 'failed' &&
              activeRow.support !== 'unsupported' ? (
                <button
                  className="weq-set-btn weq-set-btn-primary"
                  type="button"
                  disabled={!canScan}
                  onClick={() => void startScan('scan', [activeRow.dbName])}
                >
                  重试未完成的扫描
                </button>
              ) : null}
              {needsLocation && locked && !repairing && activeRow.support !== 'unsupported' ? (
                <button
                  className={`weq-set-btn${waiting && activeCanCheckQuick ? '' : ' weq-set-btn-primary'}`}
                  type="button"
                  disabled={!canScan}
                  onClick={() => {
                    setNextScanSelection([activeRow.dbName]);
                    setScanKind('checkup');
                    setTab('scan');
                  }}
                >
                  前往补充检查
                </button>
              ) : null}
              {waiting && activeRepair ? (
                <button
                  className={`weq-set-btn${(needsLocation && !activeCanCheckQuick) || activeRow.repair?.nextAction === 'retry-space' ? '' : ' weq-set-btn-primary'}`}
                  type="button"
                  onClick={() => {
                    setSelected((values) => [...new Set([...values, activeRow.dbName])]);
                    setTab('repair');
                  }}
                >
                  {(needsLocation && !activeCanCheckQuick) ||
                  activeRow.repair?.nextAction === 'view-deep'
                    ? '查看深度修复方案'
                    : activeRow.repair?.nextAction === 'retry-space' &&
                        activeRow.repair.method === 'quick'
                      ? '重试快速修复'
                      : activeRow.repair?.status === 'waiting'
                        ? '重试修复'
                        : '查看修复方案'}
                </button>
              ) : null}
              {activeRow.repair?.nextAction === 'retry-space' ? (
                <button
                  className="weq-set-btn weq-set-btn-primary"
                  type="button"
                  onClick={() => {
                    setSelected((values) => [...new Set([...values, activeRow.dbName])]);
                    setTab('repair');
                    void utils.dbRepair.preflight.invalidate();
                    void utils.dbRepair.repairStorage.invalidate();
                  }}
                >
                  <RefreshCw size={13} />
                  重新检查空间
                </button>
              ) : null}
              {!locked &&
              (activeRow.repair?.nextAction === 'check-source' || live?.maintenanceError) ? (
                <button
                  className="weq-set-btn weq-set-btn-primary"
                  type="button"
                  onClick={() => {
                    setScanSelection(databases.map((row) => row.dbName));
                    setTab('scan');
                  }}
                >
                  重新核对原库
                </button>
              ) : null}
              {locked && waiting ? (
                <button
                  className="weq-set-btn"
                  type="button"
                  disabled={end.isLoading}
                  onClick={() => void endMaintenance()}
                >
                  <UnlockKeyhole size={14} />
                  结束维护
                </button>
              ) : null}
              {operation && (operation.status !== 'cancelled' || scannedCount > 0) ? (
                <ExportButtons disabled={exportReport.isLoading} onExport={onExportCurrent} />
              ) : null}
            </div>
          </>
        ) : null}
        {showFooter ? (
          <section className="weq-dbm-plan" aria-label="修复方案">
            <div className="weq-dbm-progress-toolbar">
              <strong>修复方案</strong>
              {readyNames.length > 1 ? (
                <button
                  type="button"
                  className="weq-dbm-text-btn"
                  onClick={() => selectAll(!allReadySelected)}
                >
                  {allReadySelected ? '取消全选' : '全选可修复'}
                </button>
              ) : null}
              <button
                className="weq-set-btn weq-set-btn-sm"
                type="button"
                onClick={() => {
                  void utils.dbRepair.preflight.invalidate();
                  void utils.dbRepair.repairStorage.invalidate();
                }}
              >
                <RefreshCw size={13} />
                重新检查空间
              </button>
            </div>
            {plans.map(({ row, method, canCheckQuick, budgetPending }) => (
              <div key={row.dbName} className="weq-dbm-detail weq-dbm-plan-row">
                <header className="weq-dbm-detail-head">
                  <label className="weq-dbm-plan-select">
                    <input
                      type="checkbox"
                      aria-label={`修复 ${row.dbName}`}
                      checked={selected.includes(row.dbName)}
                      onChange={(event) => {
                        touched.current.add(row.dbName);
                        setAllowLowSpace(false);
                        const checked = event.target.checked;
                        setSelected((values) =>
                          checked
                            ? [...new Set([...values, row.dbName])]
                            : values.filter((name) => name !== row.dbName),
                        );
                      }}
                    />
                    <h2>
                      {row.dbName} · {method === 'quick' ? '快速修复' : '深度修复'}
                    </h2>
                  </label>
                </header>
                <p>
                  {budgetPending
                    ? '开始后先核验坏页和同卷克隆能力，再检查所需空间。'
                    : method === 'quick'
                      ? `只修复已核验的 ${row.scan?.badPageCount} 个坏页，保留消息记录。复核可能需要通读数据库。`
                      : '抢救可读记录并重建数据库。损坏的记录可能无法恢复。'}
                </p>
                {canCheckQuick ? (
                  <label className="weq-dbm-plan-select">
                    <input
                      type="checkbox"
                      checked={method === 'deep'}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setAllowLowSpace(false);
                        setDeepChoices((names) =>
                          checked
                            ? [...names, row.dbName]
                            : names.filter((name) => name !== row.dbName),
                        );
                      }}
                    />
                    <span>使用深度修复</span>
                  </label>
                ) : null}
                <label className="weq-dbm-plan-select">
                  <input
                    type="checkbox"
                    checked={backups[row.dbName]}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setBackupChoices((choices) => ({
                        ...choices,
                        [`${method}:${row.dbName}`]: checked,
                      }));
                    }}
                  />
                  <span>{method === 'quick' ? '保留同卷克隆备份' : '修复前保留备份'}</span>
                </label>
                {budgetPending ? null : (
                  <RepairBudget
                    scope={scope}
                    dbName={row.dbName}
                    enabled={!running}
                    method={method}
                    backup={!!backups[row.dbName]}
                  />
                )}
              </div>
            ))}
          </section>
        ) : null}
      </div>

      {showFooter ? (
        <footer className="weq-dbm-foot">
          <div className="weq-dbm-foot-summary">
            <strong>
              {selectedReady.length
                ? `已选 ${selectedReady.length} 个数据库`
                : '勾选要修复的数据库'}
            </strong>
            <span>
              {selectedReady.length
                ? `${namesText(selectedReady)} · ${selectedBackups ? `保留 ${selectedBackups} 份备份` : '不保留备份'}`
                : `${readyNames.length} 个数据库有可用方案`}
            </span>
          </div>
          <div className="weq-dbm-foot-actions">
            {hasDeep ? (
              <details
                className="weq-dbm-options"
                ref={optionsRef}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && optionsRef.current?.open) {
                    optionsRef.current.open = false;
                    event.stopPropagation();
                  }
                }}
              >
                <summary className="weq-set-btn">
                  修复选项
                  <ChevronDown size={13} aria-hidden />
                </summary>
                <div className="weq-dbm-options-panel">
                  {hasDeep ? (
                    <label className="weq-dbm-option">
                      <input
                        type="checkbox"
                        checked={strictPages}
                        disabled={!!starting}
                        onChange={(event) => setStrictPages(event.target.checked)}
                      />
                      <span>
                        <strong>丢弃损坏部分的数据</strong>
                        <em>不尝试恢复损坏页中仍可读取的内容，可能丢失更多记录；默认关闭。</em>
                      </span>
                    </label>
                  ) : null}
                  {hasDeep ? (
                    <label className="weq-dbm-option">
                      <input
                        type="checkbox"
                        checked={allowLowSpace}
                        disabled={!!starting}
                        onChange={(event) => setAllowLowSpace(event.target.checked)}
                      />
                      <span>
                        <strong>预留空间不足时仍尝试修复</strong>
                        <em>
                          仍需满足预计写入空间；后续空间不足时保留扫描结果，腾出空间后可重试。
                        </em>
                      </span>
                    </label>
                  ) : null}
                </div>
              </details>
            ) : null}
            <button
              type="button"
              className="weq-set-btn weq-set-btn-primary"
              disabled={!selectedReady.length || !!starting || ending}
              onClick={() => void startRepair()}
            >
              <ShieldCheck size={15} />
              开始修复
            </button>
          </div>
        </footer>
      ) : null}
      {surface ? (
        <WindowSurface
          mode="anchored"
          anchor={surfaceAnchor}
          width={surface === 'history' ? 680 : 460}
          title={surface === 'history' ? '历史报告与恢复' : '数据库修复设置'}
          onClose={closeSurface}
        >
          <section className="weq-dbm weq-dbm-overlay">
            <header className="weq-dbm-overlay-head">
              <h2>{surface === 'history' ? '历史报告与恢复' : '数据库修复设置'}</h2>
              <button
                type="button"
                className="weq-dbm-head-btn"
                title="关闭"
                aria-label="关闭"
                onClick={closeSurface}
              >
                <X size={16} />
              </button>
            </header>
            <div className="weq-dbm-body" key={`${surface}:${reportId ?? legacyId ?? ''}`}>
              {error ? (
                <p className="weq-dbm-alert" role="alert">
                  {error}
                </p>
              ) : null}
              {surface === 'settings' ? (
                <section className="weq-dbm-cache">
                  <h3>备份与修复工作区位置</h3>
                  <p>{cache.data?.override ?? '默认 WeQ 缓存目录'}</p>
                  {cache.error ? (
                    <p className="weq-dbm-alert" role="alert">
                      {cache.error.message}
                    </p>
                  ) : null}
                  <div className="weq-dbm-cache-actions">
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-sm"
                      disabled={repairing || pickCache.isLoading || resetCache.isLoading}
                      onClick={() => void changeCache()}
                    >
                      <FolderOpen size={14} />
                      更改位置
                    </button>
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-sm"
                      disabled={
                        repairing ||
                        resetCache.isLoading ||
                        pickCache.isLoading ||
                        !cache.data?.override
                      }
                      onClick={() =>
                        void act(async () => {
                          await resetCache.mutateAsync();
                          setAllowLowSpace(false);
                          await cache.refetch();
                          await utils.dbRepair.preflight.invalidate();
                          await utils.dbRepair.repairStorage.invalidate();
                        })
                      }
                    >
                      <RotateCcw size={14} />
                      使用默认位置
                    </button>
                  </div>
                </section>
              ) : legacyId ? (
                legacy.data ? (
                  <LegacyReport
                    data={legacy.data}
                    onBack={closeReport}
                    onExport={(format) =>
                      void act(() =>
                        exportLegacy.mutateAsync({ ...scope, recordId: legacyId, format }),
                      )
                    }
                  />
                ) : legacy.error || !legacy.isLoading ? (
                  <p className="weq-dbm-alert" role="alert">
                    {legacy.error?.message ?? '找不到这份历史修复报告。'}
                  </p>
                ) : (
                  <p className="weq-dbm-loading" role="status">
                    正在读取历史报告…
                  </p>
                )
              ) : historical ? (
                historicalView?.operation ? (
                  <ReportView
                    view={historicalView}
                    operation={historicalView.operation}
                    bytesByName={sameReportScope ? bytesByName : new Map()}
                    progress={historicalRow?.progress ?? historicalView.progress}
                    activeRow={historicalRow}
                    onFocus={setReportFocused}
                    onBack={closeReport}
                    onExport={(format) =>
                      void act(() =>
                        exportReport.mutateAsync({ ...reportScope, reportId: reportId!, format }),
                      )
                    }
                  />
                ) : report.error || !report.isLoading ? (
                  <p className="weq-dbm-alert" role="alert">
                    {report.error?.message ?? '找不到这份数据库维护报告。'}
                  </p>
                ) : (
                  <p className="weq-dbm-loading" role="status">
                    正在读取历史报告…
                  </p>
                )
              ) : (
                <>
                  {reports.isLoading || history.isLoading ? (
                    <p className="weq-dbm-loading" role="status">
                      正在读取历史报告…
                    </p>
                  ) : !reports.data?.length &&
                    !history.data?.length &&
                    !reports.error &&
                    !history.error ? (
                    <p className="weq-dbm-empty">暂无历史报告</p>
                  ) : null}
                  {reports.data?.map((item) => (
                    <div className="weq-dbm-history-row" key={item.id}>
                      <span className="weq-dbm-history-icon" aria-hidden>
                        <Database size={15} />
                      </span>
                      <div className="weq-dbm-history-main">
                        <strong>{operationLabels[item.operation.kind]}</strong>
                        <span>
                          <TimeLabel value={item.operation.startedAt} /> ·{' '}
                          {operationStates[item.operation.status]} ·{' '}
                          <NumericText>{`${item.operation.completedDatabases} / ${item.operation.totalDatabases} 个数据库`}</NumericText>
                        </span>
                      </div>
                      <div className="weq-dbm-history-actions">
                        <button
                          type="button"
                          className="weq-set-btn weq-set-btn-sm"
                          onClick={() => {
                            setReportId(item.id);
                            setReportScope(scope);
                            setReportFocused(undefined);
                            setLegacyId(undefined);
                          }}
                        >
                          查看结果
                        </button>
                        <button
                          type="button"
                          className="weq-set-iconbtn"
                          data-danger="outline"
                          title="删除报告"
                          aria-label="删除报告"
                          disabled={
                            deleteReport.isLoading || (running && live?.operation?.id === item.id)
                          }
                          onClick={() => void removeReport(item.id)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                  {history.data?.map((record) => (
                    <div className="weq-dbm-history-row" key={record.id}>
                      <span className="weq-dbm-history-icon" aria-hidden>
                        <Wrench size={15} />
                      </span>
                      <div className="weq-dbm-history-main">
                        <strong>
                          {record.dbName} · {recordStates[record.state]}
                        </strong>
                        <span>
                          <TimeLabel value={record.at} />
                        </span>
                      </div>
                      <div className="weq-dbm-history-actions">
                        <button
                          type="button"
                          className="weq-set-btn weq-set-btn-sm"
                          onClick={() => {
                            setLegacyId(record.id);
                            setReportId(undefined);
                          }}
                        >
                          查看旧报告
                        </button>
                        {record.canRestore ? (
                          <button
                            type="button"
                            className="weq-set-btn weq-set-btn-sm"
                            disabled={locked || running}
                            onClick={() => void restore(record.id)}
                          >
                            <RotateCcw size={13} />
                            恢复备份
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="weq-set-iconbtn"
                          data-danger="outline"
                          title="删除修复记录"
                          aria-label="删除修复记录"
                          disabled={locked || running || deleteRecord.isLoading}
                          onClick={() => void removeReport(record.id, true, record.canRestore)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                  {reports.error || history.error ? (
                    <p className="weq-dbm-alert" role="alert">
                      历史报告读取失败：{reports.error?.message || history.error?.message}
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </section>
        </WindowSurface>
      ) : null}
    </section>
  );
}

type DatabaseCardProps = {
  bytes: number | null | undefined;
} & (
  | {
      dbName: string;
      selection: { checked: boolean; onChange: (checked: boolean) => void };
    }
  | {
      row: DatabaseMaintenanceStatusRow;
      current: boolean;
      onFocus?: () => void;
    }
);

function DatabaseCard(props: DatabaseCardProps) {
  const row = 'row' in props ? props.row : undefined;
  const dbName = 'dbName' in props ? props.dbName : props.row.dbName;
  const purpose = qqDatabasePurpose(dbName);
  const purposeId = useId();
  const tone = row ? rowTone(row) : 'muted';
  const content = (
    <>
      <span className="weq-dbm-db-top">
        <span className="weq-dbm-db-icon" aria-hidden>
          {row?.scanStatus === 'running' ||
          row?.deepStatus === 'running' ||
          row?.repair?.status === 'running' ? (
            <Loader2 size={15} className="weq-spin" />
          ) : tone === 'warn' ? (
            <AlertTriangle size={15} strokeWidth={1.9} />
          ) : tone === 'ok' ? (
            <Check size={15} strokeWidth={2.2} />
          ) : (
            <Database size={15} strokeWidth={1.9} />
          )}
        </span>
        {row ? <Chip tone={tone}>{rowLabel(row)}</Chip> : null}
      </span>
      <span className="weq-dbm-db-name">{dbName}</span>
      {purpose ? (
        <span className="weq-dbm-db-purpose" id={purposeId}>
          {purpose}
        </span>
      ) : null}
      {row ? <span className="weq-dbm-db-note">{rowSummary(row)}</span> : null}
      <span className="weq-dbm-db-foot">
        <span>
          <NumericText>{formatBytesOrUnknown(props.bytes)}</NumericText>
        </span>
        {row?.scan ? (
          <span>
            <NumericText>{`${row.scan.pageCount.toLocaleString('zh-CN')} 页`}</NumericText>
          </span>
        ) : null}
        {row?.scan?.badPageCount ? (
          <span className="is-warn">
            <NumericText>{`${row.scan.badPageCount.toLocaleString('zh-CN')} 坏页`}</NumericText>
          </span>
        ) : null}
        {row?.deepStatus === 'partial' ||
        (row?.integrity?.ran && row.integrity.complete === false) ? (
          <span className="is-warn">有未核验项</span>
        ) : null}
      </span>
    </>
  );
  if ('selection' in props) {
    const { selection } = props;
    return (
      <label className={`weq-dbm-db is-selectable${selection.checked ? ' is-selected' : ''}`}>
        {content}
        <input
          type="checkbox"
          className="weq-dbm-db-input"
          aria-label={`扫描 ${dbName}`}
          aria-describedby={purpose ? purposeId : undefined}
          checked={selection.checked}
          onChange={(event) => selection.onChange(event.target.checked)}
          onFocus={({ currentTarget }) => {
            if (currentTarget.matches(':focus-visible'))
              currentTarget.labels?.[0]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
          }}
        />
      </label>
    );
  }
  const className = `weq-dbm-db${props.current ? ' is-current' : ''}`;
  return props.onFocus ? (
    <button
      type="button"
      className={className}
      data-tone={tone}
      aria-label={`查看 ${dbName} 检查详情`}
      aria-describedby={purpose ? purposeId : undefined}
      aria-pressed={props.current}
      onClick={props.onFocus}
    >
      {content}
    </button>
  ) : (
    <div className={className} data-tone={tone} aria-current={props.current || undefined}>
      {content}
    </div>
  );
}

function DatabaseDetail({
  row,
  bytes,
}: {
  row: DatabaseMaintenanceStatusRow;
  bytes: number | null | undefined;
}) {
  const tone = rowTone(row);
  const purpose = qqDatabasePurpose(row.dbName);
  const issues = new Map(row.issues.map((issue) => [issue.message, issue]));
  if (row.scan?.plaintext) {
    const original = row.issues.find(
      (issue) => issue.message === '此数据库为明文库，当前重建工具仅支持加密库。',
    );
    if (original) issues.delete(original.message);
    const message = '明文数据库，没有加密页签名可校验；当前重建工具不支持处理它。';
    issues.set(message, { message, support: 'unsupported', diagnostic: false });
  }
  for (const message of [
    row.integrity && !row.integrity.ran ? row.integrity.error : undefined,
    row.scanError,
    row.repair?.error,
  ]) {
    if (message && !issues.has(message)) issues.set(message, { message, support: row.support });
  }
  const integrityText = row.integrity
    ? row.integrity.ran
      ? row.integrity.healthy
        ? row.integrity.complete === false
          ? '部分正常，有未核验项'
          : '结构正常'
        : row.integrity.complete === false
          ? '发现异常，另有未核验项'
          : '发现结构异常'
      : row.integrity.corrupt
        ? '检查报损坏'
        : '未完成'
    : row.deepStatus === 'running'
      ? '进行中'
      : '未检查';
  return (
    <section className="weq-dbm-detail" aria-label={`${row.dbName}检查结果`}>
      <header className="weq-dbm-detail-head">
        <span className="weq-dbm-detail-icon" data-tone={tone} aria-hidden>
          <Database size={16} strokeWidth={1.9} />
        </span>
        <div className="weq-dbm-detail-title">
          <h2>数据库检查详情</h2>
          <span className="weq-dbm-detail-name">{row.dbName}</span>
          {purpose ? <span className="weq-dbm-db-purpose">{purpose}</span> : null}
        </div>
        <Chip tone={tone}>{rowLabel(row)}</Chip>
        <span className="weq-dbm-detail-support">
          {databaseNeedsPageLocation(row)
            ? '坏页归属待确认'
            : databaseRepairSupportLabel[row.support]}
        </span>
      </header>
      {!row.scan?.plaintext ? <p className="weq-dbm-verdict">{rowSummary(row)}</p> : null}
      <dl className="weq-dbm-metrics">
        <div>
          <dt>文件大小</dt>
          <dd>
            <NumericText>{formatBytesOrUnknown(bytes)}</NumericText>
          </dd>
        </div>
        <div>
          <dt>页数</dt>
          <dd>
            <NumericText>{row.scan ? row.scan.pageCount.toLocaleString('zh-CN') : '—'}</NumericText>
          </dd>
        </div>
        <div>
          <dt>坏页</dt>
          <dd className={row.scan?.badPageCount ? 'is-warn' : undefined}>
            <NumericText>
              {row.scan ? row.scan.badPageCount.toLocaleString('zh-CN') : '—'}
            </NumericText>
          </dd>
        </div>
        <div>
          <dt>全零页</dt>
          <dd>
            <NumericText>
              {row.scan ? row.scan.zeroPageCount.toLocaleString('zh-CN') : '—'}
            </NumericText>
          </dd>
        </div>
        <div>
          <dt>深度体检</dt>
          <dd className={row.integrity?.ran && !row.integrity.healthy ? 'is-warn' : undefined}>
            {integrityText}
          </dd>
        </div>
        <div>
          <dt>本次修复</dt>
          <dd className={row.repair?.status === 'failed' ? 'is-warn' : undefined}>
            {row.repair ? repairStates[row.repair.status] : '未开始'}
          </dd>
        </div>
      </dl>
      {row.integrity?.ran && row.integrity.unverifiedTables?.length ? (
        <p className="weq-dbm-note">
          <Info size={14} aria-hidden />
          未核验结构：{row.integrity.unverifiedTables.join('、')}
        </p>
      ) : null}
      {row.scan?.affected?.length ? (
        <ul className="weq-dbm-issues">
          {row.scan.affected.map((object) => (
            <li key={object.name}>
              <Database size={13} aria-hidden />
              <span>
                {object.name} · 页{' '}
                {object.samplePages.map((page) => page.toLocaleString('zh-CN')).join('、')}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {issues.size ? (
        <ul className="weq-dbm-issues">
          {[...issues.values()].map((issue) => (
            <li key={`${issue.stage ?? 'scan'}:${issue.message}`}>
              <span
                className="weq-dbm-issue-icon"
                data-tone={issue.diagnostic === false ? 'muted' : 'warn'}
                aria-hidden
              >
                {issue.diagnostic === false ? <Info size={13} /> : <AlertTriangle size={13} />}
              </span>
              <span>{issue.message}</span>
              <em>{databaseRepairSupportLabel[issue.support]}</em>
            </li>
          ))}
        </ul>
      ) : null}
      {row.repair?.verification ? (
        <div className="weq-dbm-verify">
          <CheckCircle2 size={15} aria-hidden />
          <span>
            修复产物复核：
            {row.repair.verification.healthy
              ? row.repair.verification.complete === false
                ? '已检查部分正常，仍有未核验项'
                : '结构正常'
              : '结构异常'}{' '}
            · 坏页 <NumericText>{row.repair.verification.badPageCount}</NumericText>
          </span>
        </div>
      ) : null}
    </section>
  );
}

function RepairBudget({
  scope,
  dbName,
  enabled,
  backup,
  method,
}: {
  scope: { uin: string; configId?: string };
  dbName: string;
  enabled: boolean;
  backup: boolean;
  method: DatabaseRepairMethod;
}) {
  const budget = trpc.dbRepair.preflight.useQuery(
    { ...scope, dbName, backup, method },
    { enabled, retry: false },
  );
  if (budget.error)
    return (
      <p className="weq-dbm-budget is-warn">
        <strong>{dbName}</strong>
        <span>{budget.error.message}</span>
      </p>
    );
  if (!budget.data) return <p role="status">正在检查空间…</p>;
  const tight = budget.data.space?.some(
    (volume) => volume.freeBytes !== null && volume.freeBytes < volume.recommendedBytes,
  );
  return (
    <div className={`weq-dbm-budget${tight ? ' is-warn' : ''}`}>
      {budget.data.space?.map((volume) => (
        <span key={volume.paths.join(':')}>
          <span className="weq-dbm-path">{volume.paths.join('、')}</span>
          <span>
            <NumericText>
              {method === 'quick'
                ? `可用 ${formatBytesOrUnknown(volume.freeBytes)} · 额外空间预算 ${formatBytesOrUnknown(volume.requiredBytes)}`
                : `可用 ${formatBytesOrUnknown(volume.freeBytes)} · 预计新增峰值 ${formatBytesOrUnknown(volume.requiredBytes)} · 建议预留 ${formatBytesOrUnknown(volume.recommendedBytes)}`}
            </NumericText>
          </span>
        </span>
      ))}
    </div>
  );
}

function RepairStorageWarning({
  scope,
  names,
  backups,
  methods,
  enabled,
  storage,
  onChangeCache,
  cacheDisabled,
}: {
  scope: { uin: string; configId?: string };
  names: string[];
  backups: Record<string, boolean>;
  methods: Record<string, DatabaseRepairMethod>;
  enabled: boolean;
  storage?: DatabaseMaintenanceStatus['storage'];
  onChangeCache: () => void;
  cacheDisabled: boolean;
}) {
  const budget = trpc.dbRepair.repairStorage.useQuery(
    { ...scope, dbNames: names, backups, methods },
    { enabled, retry: false, refetchInterval: enabled ? 2000 : false },
  );
  const estimates = enabled ? (budget.data ?? []) : storage ? [storage] : [];
  const tight = estimates.flatMap((item) =>
    item.space
      .filter((volume) => volume.freeBytes !== null && volume.freeBytes < volume.recommendedBytes)
      .map((volume) => ({ ...volume, cachePath: item.cachePath })),
  );
  if (!tight.length)
    return budget.error && enabled ? (
      <p className="weq-dbm-alert" role="alert">
        无法检查备份与修复工作区空间：{budget.error.message}
      </p>
    ) : null;
  const grouped = new Map<string, (typeof tight)[number]>();
  for (const volume of tight) {
    const key = volume.paths.join(':');
    if (!grouped.has(key) || grouped.get(key)!.requiredBytes < volume.requiredBytes)
      grouped.set(key, volume);
  }
  const volumes = [...grouped.values()];
  return (
    <section className="weq-dbm-storage-warning" role="alert" aria-label="磁盘空间警告">
      <div className="weq-dbm-storage-heading">
        <AlertTriangle size={17} aria-hidden />
        <strong>
          {tight.some((volume) => volume.freeBytes! < volume.requiredBytes)
            ? '磁盘空间不足'
            : '磁盘可用空间偏低'}
        </strong>
      </div>
      <p>
        请清理磁盘或更改备份与修复工作区位置。空间不足时会保留维护锁和扫描结果，返回查看结果后可重试。
      </p>
      <dl>
        <div>
          <dt>备份与修复工作区位置</dt>
          <dd>{estimates[0]?.cachePath}</dd>
        </div>
        {volumes.map((volume) => (
          <div key={volume.paths.join(':')}>
            <dt>{volume.paths.includes(volume.cachePath) ? '工作区所在卷' : '原数据库卷'}</dt>
            <dd>
              <span className="weq-dbm-path">{volume.paths.join('、')}</span>
              <span>
                <NumericText>{`可用 ${formatBytesOrUnknown(volume.freeBytes)} · ${!enabled ? '后续' : '预计'}新增峰值 ${formatBytesOrUnknown(volume.requiredBytes)}`}</NumericText>
              </span>
            </dd>
          </div>
        ))}
      </dl>
      <div className="weq-dbm-cache-actions">
        <button
          type="button"
          className="weq-set-btn weq-set-btn-sm"
          disabled={cacheDisabled}
          onClick={onChangeCache}
          title={cacheDisabled ? '当前重建结束并返回查看结果后可更改位置' : undefined}
        >
          <FolderOpen size={14} />
          更改位置
        </button>
        <button
          type="button"
          className="weq-set-btn weq-set-btn-sm"
          onClick={() => void budget.refetch()}
          disabled={!enabled || budget.isFetching}
        >
          <RefreshCw size={14} />
          刷新空间
        </button>
      </div>
    </section>
  );
}

function ExportButtons({
  disabled,
  onExport,
}: {
  disabled?: boolean;
  onExport: (format: 'html' | 'md' | 'json') => void;
}) {
  return (
    <div className="weq-dbm-export">
      {(['html', 'md', 'json'] as const).map((format) => (
        <button
          key={format}
          type="button"
          className="weq-set-btn weq-set-btn-sm"
          disabled={disabled}
          onClick={() => onExport(format)}
        >
          <Download size={13} />
          {format === 'md' ? 'Markdown' : format.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function ReportView({
  view,
  operation,
  bytesByName,
  progress,
  activeRow,
  onFocus,
  onBack,
  onExport,
}: {
  view: DatabaseMaintenanceStatus;
  operation: NonNullable<DatabaseMaintenanceStatus['operation']>;
  bytesByName: Map<string, number | null>;
  progress?: DatabaseTaskProgress;
  activeRow?: DatabaseMaintenanceStatusRow;
  onFocus: (name: string) => void;
  onBack: () => void;
  onExport: (format: 'html' | 'md' | 'json') => void;
}) {
  const rows = view.databases;
  const abnormal = rows.filter((row) => databaseMaintenanceRowAbnormal(row)).length;
  const repaired = rows.filter((row) => row.repair?.status === 'completed').length;
  const ready = rows.filter(databaseReadyForRepair).length;
  return (
    <>
      <div className="weq-dbm-report-bar">
        <button type="button" className="weq-dbm-back" onClick={onBack}>
          <ArrowLeft size={13} strokeWidth={2.2} aria-hidden />
          返回历史报告
        </button>
        <span className="weq-dbm-report-kind">历史报告</span>
      </div>
      <header className="weq-dbm-report-head">
        <div>
          <h2>{operationLabels[operation.kind]}报告</h2>
          <p>
            {view.uin}
            {view.configId ? ` · ${view.configId}` : ''} · <TimeLabel value={operation.startedAt} />
          </p>
        </div>
        <Chip
          tone={
            operation.status === 'completed'
              ? 'ok'
              : operation.status === 'failed'
                ? 'warn'
                : 'muted'
          }
        >
          {operationStates[operation.status]}
        </Chip>
        <ExportButtons onExport={onExport} />
      </header>
      <dl className="weq-dbm-report-metrics">
        <div>
          <dt>数据库</dt>
          <dd>
            <NumericText>{`${operation.completedDatabases} / ${operation.totalDatabases} 完成`}</NumericText>
          </dd>
        </div>
        <div>
          <dt>异常</dt>
          <dd className={abnormal ? 'is-warn' : undefined}>
            <NumericText>{`${abnormal} 个`}</NumericText>
          </dd>
        </div>
        <div>
          <dt>{operation.kind === 'repair' ? '修复成功' : '可修复'}</dt>
          <dd>
            <NumericText>{`${operation.kind === 'repair' ? repaired : ready} 个`}</NumericText>
          </dd>
        </div>
        <div>
          <dt>未完成</dt>
          <dd className={operation.failedDatabases ? 'is-warn' : undefined}>
            <NumericText>{`${operation.failedDatabases ?? 0} 个`}</NumericText>
          </dd>
        </div>
      </dl>
      {operation.error ? (
        <p className="weq-dbm-alert" role="alert">
          <AlertTriangle size={15} aria-hidden />
          {operation.error}
        </p>
      ) : null}
      {rows.length ? (
        <ul className="weq-dbm-list">
          {rows.map((row) => (
            <li key={row.dbName}>
              <DatabaseCard
                row={row}
                bytes={bytesByName.get(row.dbName)}
                current={activeRow?.dbName === row.dbName}
                onFocus={() => onFocus(row.dbName)}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {progress ? (
        <details className="weq-dbm-process" open>
          <summary>
            <span className="weq-dbm-process-title">
              <History size={14} />
              执行过程
            </span>
            <span className="weq-dbm-process-hint">
              {operationLabels[operation.kind]} · {operationStates[operation.status]}
            </span>
            <ChevronDown size={14} className="weq-dbm-chevron" aria-hidden />
          </summary>
          <div className="weq-dbm-process-body">
            <DatabaseMaintenanceProgress
              progress={progress}
              batch={{ ...operation, locked: view.locked }}
              showBatch={false}
              showBatchError={false}
              showMaintained={false}
            />
          </div>
        </details>
      ) : null}
      {activeRow ? (
        <DatabaseDetail row={activeRow} bytes={bytesByName.get(activeRow.dbName)} />
      ) : null}
    </>
  );
}

function LegacyReport({
  data,
  onBack,
  onExport,
}: {
  data: {
    dbName: string;
    at: string;
    state: keyof typeof recordStates;
    badPages: number[];
    beforeBytes: number;
    afterBytes: number | null;
    error?: string;
  };
  onBack: () => void;
  onExport: (format: 'html' | 'md' | 'json') => void;
}) {
  return (
    <>
      <div className="weq-dbm-report-bar">
        <button type="button" className="weq-dbm-back" onClick={onBack}>
          <ArrowLeft size={13} strokeWidth={2.2} aria-hidden />
          返回历史报告
        </button>
        <span className="weq-dbm-report-kind">旧版修复记录</span>
      </div>
      <header className="weq-dbm-report-head">
        <div>
          <h2>{data.dbName}</h2>
          <p>
            <TimeLabel value={data.at} /> · {recordStates[data.state]}
          </p>
        </div>
        <ExportButtons onExport={onExport} />
      </header>
      <dl className="weq-dbm-report-metrics">
        <div>
          <dt>坏页</dt>
          <dd className={data.badPages.length ? 'is-warn' : undefined}>
            <NumericText>{data.badPages.length}</NumericText>
          </dd>
        </div>
        <div>
          <dt>源库大小</dt>
          <dd>
            <NumericText>{formatBytesOrUnknown(data.beforeBytes)}</NumericText>
          </dd>
        </div>
        <div>
          <dt>产物大小</dt>
          <dd>
            <NumericText>{formatBytesOrUnknown(data.afterBytes)}</NumericText>
          </dd>
        </div>
        <div>
          <dt>修复能力</dt>
          <dd>旧记录未逐项判定</dd>
        </div>
      </dl>
      {data.error ? (
        <p className="weq-dbm-alert" role="alert">
          <AlertTriangle size={15} aria-hidden />
          {data.error}
        </p>
      ) : null}
      <p className="weq-dbm-note">
        <Info size={14} aria-hidden />
        旧报告没有记录逐项支持情况，也没有本次维护的扫描与复核过程。只能查看结果和导出。
      </p>
    </>
  );
}
