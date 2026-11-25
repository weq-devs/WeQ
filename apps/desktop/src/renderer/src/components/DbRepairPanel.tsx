import {
  useCallback,
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
  Play,
  RefreshCw,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  Settings2,
  Square,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import {
  MAX_DATABASE_CHECKUP_CONCURRENCY,
  databaseCanCheckQuickRepair,
  databaseReadyForRepair,
  databaseNeedsPageLocation,
  databaseRepairRecommendation,
  type DatabaseRepairBackupMode,
  type DatabaseRepairMethod,
  databaseRepairSupportLabel,
  databaseMaintenanceRowAbnormal,
  databaseMaintenanceOperationLabel as operationLabel,
  databaseMaintenanceStatusLabel as operationStates,
  databaseRepairStatusLabel as repairStates,
  type DatabaseMaintenanceOperation,
  type DatabaseMaintenanceStatus,
  type DatabaseMaintenanceStatusRow,
} from '@weq/service/db-checkup';
import {
  databaseStepPercent,
  type DatabaseTaskProgress,
  type DatabaseWorkProgress,
} from '@weq/service/db-progress';
import { NumericText } from './NumericText';
import { TimeLabel } from './TimeLabel';
import { client, trpc } from '../trpc/client';
import { useRenderDocument } from '../lib/renderDocument';
import { useDbRepairReturn } from '../state/dbRepairReturn';
import { Modal } from './Dialog';
import { useDialog } from './Dialog.shared';
import { QqAvatar } from './QqAvatar';
import { DatabaseMaintenanceProgress } from './DatabaseMaintenanceProgress';
import { TaskProgressBar } from './tasks/TaskProgressBar';
import { ConversationActionsMenu } from './ConversationActionsMenu';
import { FormSelect } from './FormSelect';
import { SegmentedControl } from './SegmentedControl';
import { WindowSurface } from './WindowSurface';
import { Row } from './settings/controls';
import { formatBytesOrUnknown } from '../lib/format';
import { qqDatabasePurpose } from '../lib/qqDatabasePurpose';
import '../styles/db-repair-maintenance.css';

export interface DbRepairAccountOption {
  uin: string;
  configId?: string;
  dbName?: string;
  reportId?: string;
  checkupResult?: DatabaseMaintenanceStatus;
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
type ScanKind = 'scan' | 'checkup';
const checkupConcurrencyOptions = Array.from(
  { length: MAX_DATABASE_CHECKUP_CONCURRENCY },
  (_, index) => index + 1,
);

function rowLabel(row: DatabaseMaintenanceStatusRow) {
  if (row.repair) return repairStates[row.repair.status];
  if (row.deepStatus === 'running') return '深度检查中';
  if (row.deepStatus === 'partial') return '深度体检部分完成';
  if (row.deepStatus === 'failed') return '深度体检未完成';
  if (row.deepStatus === 'cancelled') return '深度体检已停止';
  if (row.deepStatus === 'completed') return '深度体检完成';
  return {
    pending: '等待体检',
    running: '体检中',
    completed: '快速体检完成',
    failed: '体检未完成',
  }[row.scanStatus];
}
function waitingScanLabel(kind: ScanKind) {
  return kind === 'scan' ? '等待快速体检' : '等待深度体检';
}

function isWaitingForScan(row: DatabaseMaintenanceStatusRow | undefined, kind: ScanKind) {
  if (!row || row.scanStatus === 'pending') return true;
  if (row.scanStatus === 'running' || row.deepStatus === 'running') return false;
  return (
    kind === 'checkup' &&
    row.scanStatus === 'completed' &&
    (!row.deepStatus || row.deepStatus === 'cancelled')
  );
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
function rowSummary(row: DatabaseMaintenanceStatusRow): ReactNode {
  if (row.repair?.status === 'running') return '正在修复这个数据库。';
  if (row.repair?.status === 'failed') return '修复没有完成，原因见问题明细。';
  if (row.repair?.status === 'waiting') return '已保留体检结果，处理问题后可重试。';
  if (row.repair?.status === 'cancelled') return '本轮修复已停止，这个库没有提交替换。';
  if (row.repair?.status === 'completed')
    return row.repair.verification?.healthy === false
      ? '产物已替换，复核发现结构异常。详情见下方。'
      : '已替换数据库并完成结构复核。';
  if (row.scanStatus === 'pending') return '这个数据库还未体检。';
  if (row.scanStatus === 'running') {
    const current = row.progress?.current;
    return current?.message ? `${current.message}…` : '正在检查页签名。';
  }
  if (row.scanStatus === 'failed') return '体检没有完成，暂时没有可用结论。';
  if (row.scan?.plaintext) return '明文数据库，当前重建工具不支持处理它。';
  if (row.scan?.badPageCount) {
    const count = row.scan.badPageCount.toLocaleString('zh-CN');
    const located = row.scan.affected?.reduce((sum, object) => sum + object.badPageCount, 0) ?? 0;
    const location = located
      ? `已定位 ${located.toLocaleString('zh-CN')} 个`
      : row.locationChecked
        ? '未能确认归属'
        : '尚未定位';
    return <NumericText>{`发现 ${count} 个坏页，${location}`}</NumericText>;
  }
  if (row.deepStatus === 'running') return '正在做结构体检，页签名检查结果已经保留。';
  if (row.deepStatus === 'partial')
    return '深度体检部分完成，快速体检结果可用；结构检查还有未核验的部分。';
  if (row.deepStatus === 'failed') return '深度体检没有跑完，快速体检结果仍然保留。';
  if (row.deepStatus === 'cancelled') return '深度体检已停止，快速体检结果仍然保留。';
  if (row.integrity?.ran && !row.integrity.healthy) return '结构检查发现异常，可以尝试重建修复。';
  if (row.integrity?.ran && row.integrity.complete === false)
    return '已检查的结构部分没有发现异常，但仍有未核验项，不能认定整库正常。';
  const diagnostic = row.issues.filter((issue) => issue.diagnostic !== false);
  if (diagnostic.length)
    return <NumericText>{`发现 ${diagnostic.length} 项需要查看的问题。`}</NumericText>;
  if (row.scan) {
    if (!row.scan.usedHmac) return '此数据库没有可校验的加密页签名。';
    return '页签名检查没有发现坏页。';
  }
  return '等待检查结果。';
}
function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`weq-dbm-chip is-${tone}`}>{children}</span>;
}

const repairConclusion: Record<DatabaseMaintenanceOperation['status'], string> = {
  running: '正在修复',
  completed: '修复完成',
  partial: '部分数据库修复成功',
  failed: '修复未完成',
  cancelled: '修复已停止',
  interrupted: '修复已中断',
  waiting: '修复暂停，等待处理',
};

const maintenanceTabs = [
  { id: 'scan', label: '开始体检', Icon: Database },
  { id: 'report', label: '体检进度与结果', Icon: History },
  { id: 'repair', label: '开始修复', Icon: Wrench },
  { id: 'result', label: '修复进度与结果', Icon: CheckCircle2 },
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
  resultRequest?: Pick<DbRepairAccountOption, 'uin' | 'configId' | 'reportId' | 'checkupResult'>;
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
  const [requestedTab, setRequestedTab] = useState<MaintenanceTab>();
  const [openedCheck, setOpenedCheck] = useState<DatabaseMaintenanceStatus>();
  function setTab(tab: MaintenanceTab) {
    setRequestedTab(tab);
    if (tab !== 'report') setOpenedCheck(undefined);
  }
  const [scanSelection, setScanSelection] = useState<string[] | undefined>(
    account?.dbName ? [account.dbName] : undefined,
  );
  const [nextScanSelection, setNextScanSelection] = useState<string[]>();
  const [additionalNames, setAdditionalNames] = useState<string[]>();
  const [appendKind, setAppendKind] = useState<ScanKind>();
  const [selected, setSelected] = useState<string[]>([]);
  const [repairMethodOverride, setRepairMethodOverride] = useState<DatabaseRepairMethod>();
  const [recentCheck, setRecentCheck] = useState<DatabaseMaintenanceStatus>();
  const [recentRepair, setRecentRepair] = useState<DatabaseMaintenanceStatus>();
  const [resultFocused, setResultFocused] = useState<string>();
  const spaceEstimateId = useId();
  const settingsTitleId = useId();
  const concurrencyDescriptionId = useId();
  const [starting, setStarting] = useState<
    | {
        kind: ScanKind;
        dbNames: string[];
        previousOperationId: string | undefined;
        resuming: boolean;
      }
    | { kind: 'repair'; dbNames: string[] }
    | null
  >(null);
  const [scanKind, setScanKind] = useState<ScanKind>('scan');
  const [surface, setSurface] = useState<'history' | 'settings' | null>(null);
  const [surfaceAnchor, setSurfaceAnchor] = useState<HTMLElement>();
  const [reportFocused, setReportFocused] = useState<string>();
  const [diagnostic, setDiagnostic] = useState(account?.diagnostic);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState(false);
  const [backupRestore, setBackupRestore] = useState<{
    dbName: string;
    step: DatabaseWorkProgress;
  } | null>(null);
  const touched = useRef(new Set<string>());
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastOperation = useRef<string | undefined>(undefined);
  const displayedOperation = useRef<string | undefined>(undefined);
  const sessionId = useRef<string | undefined>(undefined);
  const endDecision = useRef<{ unsubscribe(): void } | null>(null);
  const utils = trpc.useUtils();
  const status = trpc.dbRepair.status.useQuery(scope, { enabled: !!scope.uin, retry: false });
  const maintenance = trpc.dbRepair.maintenance.useQuery(scope, {
    enabled: !!scope.uin,
    refetchInterval: 2000,
    refetchOnMount: 'always',
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
  const repairBackupMode = trpc.dbRepair.repairBackupMode.useQuery(undefined, { retry: false });
  const setRepairBackupMode = trpc.dbRepair.setRepairBackupMode.useMutation();
  const checkupSettings = trpc.dbRepair.checkupSettings.useQuery(undefined, {
    enabled: surface === 'settings',
  });
  const setCheckupConcurrency = trpc.dbRepair.setCheckupConcurrency.useMutation();
  const scan = trpc.dbRepair.scanAccount.useMutation();
  const appendScan = trpc.dbRepair.appendScan.useMutation();
  const repair = trpc.dbRepair.repairSelected.useMutation();
  const stop = trpc.dbRepair.stopMaintenance.useMutation();
  const end = trpc.dbRepair.endMaintenance.useMutation();
  const exportReport = trpc.dbRepair.exportMaintenanceReport.useMutation();
  const exportLegacy = trpc.dbRepair.exportLegacyReport.useMutation();
  const pickCache = trpc.dbRepair.pickCacheLocation.useMutation();
  const resetCache = trpc.dbRepair.resetCacheLocation.useMutation();
  const deleteReport = trpc.dbRepair.deleteReport.useMutation();
  const deleteRecord = trpc.dbRepair.deleteRecord.useMutation();

  const updateLive = useCallback((snapshot: DatabaseMaintenanceStatus | null) => {
    setLive((current) => {
      if (snapshot?.state !== 'ended') return snapshot;
      // 当前窗口内的修复结果和异常仍可查看。重新打开时从历史报告查看已结束的维护。
      const hasResult =
        snapshot.operation?.kind === 'repair' ||
        snapshot.operation?.status === 'cancelled' ||
        snapshot.operation?.error ||
        snapshot.maintenanceError ||
        snapshot.reportError;
      return current?.id === snapshot.id &&
        hasResult &&
        (current.state !== 'ending' || snapshot.operation?.kind === 'repair')
        ? snapshot
        : null;
    });
  }, []);

  useEffect(() => {
    if (maintenance.isFetchedAfterMount && maintenance.data !== undefined)
      updateLive(maintenance.data);
  }, [maintenance.data, maintenance.isFetchedAfterMount, updateLive]);
  useEffect(() => {
    if (resultRequest?.checkupResult) {
      setOpenedCheck(resultRequest.checkupResult);
      setRequestedTab('report');
      setFocused(undefined);
      setReportId(undefined);
      setLegacyId(undefined);
      setSurface(null);
      return;
    }
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
    if (!live || !operation || operation.status === 'running') return;
    const key = `${operation.id}:${operation.status}`;
    if (lastOperation.current === key) return;
    lastOperation.current = key;
    if (operation.kind === 'repair') {
      setRecentRepair(live);
      setResultFocused(live.databases.find((row) => row.repair?.error)?.dbName);
    } else {
      setRecentCheck(live);
    }
  }, [live]);
  useEffect(() => {
    const kind = live?.operation?.kind;
    if (kind === 'scan' || kind === 'checkup') {
      setScanKind(kind);
      setNextScanSelection(undefined);
    }
  }, [live?.operation?.id, live?.operation?.kind]);
  useEffect(() => {
    const sub = client.dbRepair.onMaintenance.subscribe(undefined, {
      onData(snapshot) {
        if (snapshot.uin !== scope.uin || snapshot.configId !== scope.configId) return;
        updateLive(snapshot);
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
  }, [scope, updateLive, utils]);
  useEffect(() => {
    setBackupRestore(null);
    const sub = client.dbRepair.onRestoreProgress.subscribe(scope, { onData: setBackupRestore });
    return () => sub.unsubscribe();
  }, [scope]);
  useEffect(() => {
    if (!live) return;
    if (sessionId.current !== live.id) {
      sessionId.current = live.id;
      touched.current.clear();
      setSelected([]);
      setRepairMethodOverride(undefined);
      setNextScanSelection(undefined);
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
  const startScan = (kind: ScanKind, dbNames: string[]) =>
    act(async () => {
      if (!dbNames.length) return;
      window.electron?.ipcRenderer.send('db-repair:scope', scope);
      setTab('report');
      setOpenedCheck(undefined);
      setAdditionalNames(undefined);
      setAppendKind(undefined);
      setScanKind(kind);
      setReportId(undefined);
      setReportScope(scope);
      setLegacyId(undefined);
      setDiagnostic(undefined);
      if (!locked) {
        setLive(null);
        setFocused(account?.dbName);
      }
      const request = { kind, dbNames, previousOperationId: operation?.id, resuming: paused };
      setStarting(request);
      try {
        updateLive(await scan.mutateAsync({ ...scope, kind, dbNames }));
        await refresh();
      } finally {
        setStarting((current) => (current === request ? null : current));
      }
    });
  useEffect(() => () => endDecision.current?.unsubscribe(), []);
  const endMaintenance = () => {
    if (ending) {
      useDialog.getState().showInfo('正在结束维护', '当前操作结束后会释放维护锁。', {
        ownerDocument,
      });
      return;
    }
    if (!live || endDecision.current) return;
    const dismiss = () => {
      endDecision.current?.unsubscribe();
      endDecision.current = null;
    };
    endDecision.current = client.dbRepair.prepareEndMaintenance.subscribe(
      { ...scope, sessionId: live.id },
      {
        onData: (decision) =>
          void act(async () => {
            try {
              if (!decision) return await refresh();
              const { replacing, restoring, running, kind } = decision;
              const title = restoring
                ? '重试恢复原库并结束维护？'
                : replacing
                  ? '撤销本次替换并停止维护？'
                  : running
                    ? '停止当前操作并解除占用？'
                    : '解除数据库占用？';
              const detail = restoring
                ? `将重试恢复并校验 ${restoring}，成功后释放维护锁。`
                : replacing
                  ? `将取消 ${replacing} 的替换。如果已经换入新库，将恢复并校验原库后解锁。此前已修复成功的其他数据库会保留结果。`
                  : kind === 'repair' && running
                    ? '将停止本次修复并释放维护锁。已修复成功的数据库会保留结果。'
                    : '将结束本次维护并释放维护锁。历史报告会保留，下次修复需要重新体检。';
              const confirmed = await useDialog.getState().confirm(title, detail, {
                okLabel: restoring
                  ? '恢复原库并结束维护'
                  : replacing
                    ? '撤销替换并停止维护'
                    : running
                      ? '停止并解除占用'
                      : '解除占用',
                cancelLabel: '继续维护',
                danger: 'outline',
                ownerDocument,
              });
              if (!confirmed) return;
              await end.mutateAsync({ ...scope, decisionId: decision.id });
              if (kind !== 'repair') {
                setLive(null);
                setTab('scan');
              }
              await refresh();
            } finally {
              dismiss();
            }
          }),
        onError: (cause) => {
          dismiss();
          setError(cause.message);
        },
      },
    );
  };
  const startRepair = () =>
    act(async () => {
      if (repairStartBlocked) return;
      const names = selectedReady;
      const detail =
        repairMethod === 'quick'
          ? '将先核验快速修复条件，通过后修复并保留消息记录。'
          : '将抢救可读记录并重建数据库，损坏的记录可能无法恢复。';
      const spaceWarning = canUseLowSpace
        ? '可用空间低于建议值。若中途空间不足，当前数据库的重建可能中断。'
        : '';
      const confirmed = await useDialog
        .getState()
        .confirm(
          canUseLowSpace ? '磁盘空间偏低，仍要修复？' : '修复所选数据库？',
          `${spaceWarning}${detail}修复可以停止，已修复的库会保留结果。`,
          {
            okLabel: canUseLowSpace ? '仍尝试修复' : '开始修复',
            cancelLabel: '继续查看',
            ownerDocument,
          },
        );
      if (!confirmed) return;
      setReportId(undefined);
      setReportScope(scope);
      setLegacyId(undefined);
      setTab('result');
      setStarting({ kind: 'repair', dbNames: names });
      try {
        const result = await repair.mutateAsync({
          ...scope,
          dbNames: names,
          methods,
          backups,
          allowLowSpace: canUseLowSpace,
        });
        updateLive(result.snapshot);
        if (result.closedAccount)
          useDbRepairReturn.getState().arm({
            title: '本轮数据库维护已结束',
            detail: '数据库替换前已关闭当前账号，请从主页重新打开。',
            tone: result.snapshot.operation?.status === 'completed' ? 'ok' : 'warn',
          });
        await refresh();
      } finally {
        setStarting(null);
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
  const operation = live?.operation;
  // 收到新一轮状态后立即使用服务端状态，体检请求会等到整轮结束才返回。
  const startingScan =
    starting &&
    starting.kind !== 'repair' &&
    (!operation || operation.id === starting.previousOperationId)
      ? starting
      : null;
  const busyStarting = !!startingScan || starting?.kind === 'repair';
  const running = operation?.status === 'running' || busyStarting;
  const repairing =
    live?.state === 'repairing' ||
    starting?.kind === 'repair' ||
    (live?.operation?.status === 'running' && live.operation.kind === 'repair');
  const ending = live?.state === 'ending' || end.isLoading;
  const locked = !!live?.locked && live.state !== 'ended';
  const waiting = live?.state === 'waiting' && !ending;
  const operationScanKind = operation?.kind !== 'repair' ? operation?.kind : undefined;
  const paused = !running && !ending && !!operationScanKind && operation?.status === 'cancelled';
  const scanRunning = running && !repairing;
  const available = status.data?.databases.filter((row) => row.exists) ?? [];
  const databases = live?.databases ?? [];
  const maintainedRows = new Map(databases.map((row) => [row.dbName, row]));
  const operationNames = operation?.databaseNames ?? databases.map(({ dbName }) => dbName);
  const activeScanKind = operation?.status === 'running' ? operationScanKind : undefined;
  const startingScanKind = startingScan?.kind;
  const queuedScanKind =
    activeScanKind ?? startingScanKind ?? (paused ? operationScanKind : undefined);
  const queuedScanNames = activeScanKind || paused ? operationNames : (startingScan?.dbNames ?? []);
  const queuedNamesSet = new Set(queuedScanNames);
  const queuedScanKinds = activeScanKind || paused ? operation?.databaseScanKinds : undefined;
  const queuedKindFor = (name: string) =>
    queuedNamesSet.has(name) ? (queuedScanKinds?.[name] ?? queuedScanKind) : undefined;
  const hasQueuedLevel = (name: string, kind: ScanKind) => {
    const queuedKind = queuedKindFor(name);
    return queuedKind === 'checkup' || queuedKind === kind;
  };
  const pendingDeepScan = available.filter(({ dbName }) => {
    const row = maintainedRows.get(dbName);
    if (!row) return true;
    if (row.scanStatus !== 'completed') return row.support !== 'unsupported';
    return row.deepStatus !== 'completed';
  });
  const pendingQuickScan = pendingDeepScan.filter(
    ({ dbName }) => maintainedRows.get(dbName)?.scanStatus !== 'completed',
  );
  const canAppendQuick = pendingQuickScan.some(({ dbName }) => !hasQueuedLevel(dbName, 'scan'));
  const canAppendDeep = pendingDeepScan.some(({ dbName }) => !hasQueuedLevel(dbName, 'checkup'));
  const defaultAppendKind =
    queuedScanKind === 'scan' && !canAppendQuick && canAppendDeep
      ? 'checkup'
      : (queuedScanKind ?? scanKind);
  const setupScanKind = appendKind ?? (scanRunning ? defaultAppendKind : scanKind);
  const scanCandidates =
    !locked && !scanRunning && !paused
      ? available
      : setupScanKind === 'scan'
        ? pendingDeepScan.filter(
            ({ dbName }) =>
              maintainedRows.get(dbName)?.scanStatus !== 'completed' ||
              (paused && queuedScanKinds?.[dbName] === 'checkup'),
          )
        : pendingDeepScan;
  const candidateNames = scanCandidates.map((row) => row.dbName);
  const alreadyQueued = (name: string) => hasQueuedLevel(name, setupScanKind);
  const setupCandidates = scanCandidates.filter(({ dbName }) => !alreadyQueued(dbName));
  const cachedCheck = recentCheck?.id === live?.id ? recentCheck : undefined;
  const previousCheckId =
    operation?.kind === 'repair' && !cachedCheck
      ? reports.data?.find(
          (item) =>
            item.operation.kind !== 'repair' && item.operation.startedAt <= operation.startedAt,
        )?.operation.id
      : undefined;
  const previousCheck = trpc.dbRepair.reportStatus.useQuery(
    { ...scope, reportId: previousCheckId ?? '' },
    { enabled: !!previousCheckId, retry: false },
  );
  const savedCheck =
    previousCheckId && previousCheck.data?.id === live?.id ? previousCheck.data : undefined;
  const currentCheck = operation?.kind !== 'repair' ? live : (cachedCheck ?? savedCheck);
  const otherCheckScope =
    !!openedCheck && (openedCheck.uin !== scope.uin || openedCheck.configId !== scope.configId);
  // 旧提醒仍显示对应结果，修复和追加操作只能作用于当前维护。
  const detachedCheck =
    openedCheck &&
    (otherCheckScope ||
      openedCheck.operation?.id !== operation?.id ||
      operation?.status === 'running')
      ? openedCheck
      : undefined;
  const check = detachedCheck ?? currentCheck;
  const result =
    operation?.kind === 'repair' && operation.status !== 'running'
      ? live
      : live && recentRepair?.id === live.id
        ? recentRepair
        : undefined;
  const resultOperation = result?.operation;
  const resultRows =
    result?.databases.filter(
      (row) => resultOperation?.databaseNames?.includes(row.dbName) ?? !!row.repair,
    ) ?? [];
  const checkOperation = check?.operation;
  const checkRows =
    check?.databases ??
    databases.map((row) => ({
      ...row,
      repair: undefined,
      progress: row.progress?.kind === 'repair' ? row.scanProgress : row.progress,
    }));
  const scanSelectionForAction = paused
    ? (nextScanSelection ?? [
        ...(setupScanKind === operation?.kind ? [] : maintainedRows.keys()),
        ...operationNames,
        ...(additionalNames ?? []),
      ])
    : locked
      ? (nextScanSelection ??
        additionalNames ??
        candidateNames.filter((name) => maintainedRows.has(name)))
      : scanSelection;
  // 选库区的勾选只管理可见选项，续检仍带上隐藏的待检库。
  const scanNames = candidateNames.filter(
    (name) => (paused && alreadyQueued(name)) || (scanSelectionForAction?.includes(name) ?? true),
  );
  const setScanCandidates = locked || paused ? setNextScanSelection : setScanSelection;
  const namesToAppend = setupCandidates
    .map(({ dbName }) => dbName)
    .filter((name) => additionalNames?.includes(name));
  const setupSelection = scanRunning
    ? namesToAppend
    : scanNames.filter((name) => !alreadyQueued(name));
  const additionalScanKind =
    locked && pendingDeepScan.length
      ? operation?.kind === 'scan' && pendingQuickScan.length
        ? 'scan'
        : 'checkup'
      : null;
  const bytesByName = useMemo(
    () => new Map(status.data?.databases.map((row) => [row.dbName, row.bytes]) ?? []),
    [status.data],
  );
  const activeRow =
    checkRows.find((row) => row.dbName === focused) ??
    checkRows.find((row) => row.dbName === checkOperation?.currentDb) ??
    checkRows.find(databaseMaintenanceRowAbnormal) ??
    checkRows[0];
  const resultRow =
    resultRows.find((row) => row.dbName === resultFocused) ??
    resultRows.find((row) => row.dbName === resultOperation?.currentDb) ??
    resultRows[0];
  const repairCandidates = databases.flatMap((row) => {
    const recommended = databaseRepairRecommendation(row);
    if (!recommended) return [];
    const canQuickRepair = recommended === 'quick' || databaseCanCheckQuickRepair(row);
    let disabledReason: string | undefined;
    if (repairMethodOverride === 'quick' && !canQuickRepair) {
      disabledReason =
        row.repair?.nextAction === 'view-deep'
          ? '快速修复未通过复核，请使用深度修复。'
          : '坏页或数据库结构不符合快速修复条件。';
    }
    return [
      {
        dbName: row.dbName,
        bytes: bytesByName.get(row.dbName) ?? null,
        canQuickRepair,
        disabledReason,
      },
    ];
  });
  const availableRepairNames = repairCandidates
    .filter(({ disabledReason }) => !disabledReason)
    .map(({ dbName }) => dbName);
  const selectedCandidates = repairCandidates.filter(
    ({ dbName, disabledReason }) => !disabledReason && selected.includes(dbName),
  );
  const selectedReady = selectedCandidates.map(({ dbName }) => dbName);
  const repairMethod =
    repairMethodOverride ??
    (selectedCandidates.length && selectedCandidates.every(({ canQuickRepair }) => canQuickRepair)
      ? 'quick'
      : 'deep');
  const backupMode = repairBackupMode.data;
  const keepBackup = backupMode === 'all' || (backupMode === 'deep' && repairMethod === 'deep');
  const methods = Object.fromEntries(selectedReady.map((name) => [name, repairMethod]));
  const backups = Object.fromEntries(selectedReady.map((name) => [name, keepBackup]));
  const namesWithBudget = backupMode
    ? selectedReady.filter(
        (name) => repairMethod === 'deep' || !!maintainedRows.get(name)?.quickBudgetBytes,
      )
    : [];
  const scannedCount = checkRows.filter((row) => row.scanStatus === 'completed').length;
  const abnormalCount = checkRows.filter(databaseMaintenanceRowAbnormal).length;
  const scanAction = !locked
    ? '开始体检'
    : !scanCandidates.length
      ? '体检已完成'
      : scanNames.some((name) => !maintainedRows.has(name)) || !scanNames.length
        ? '追加体检'
        : setupScanKind === 'checkup'
          ? '开始补充检查'
          : '继续体检';
  const maintenanceIdle = !running && !starting && !ending && !backupRestore;
  const canScan = !!(status.data?.keyPresent && !status.data.error && maintenanceIdle);
  const hasReportRows =
    checkRows.length > 0 &&
    (scannedCount > 0 ||
      checkRows.some((row) => row.scanStatus === 'failed') ||
      !!(
        checkOperation &&
        checkOperation.status !== 'running' &&
        checkOperation.status !== 'cancelled'
      ));
  const hasReport = hasReportRows || scanRunning || paused || !!diagnostic || !!openedCheck;
  const hasResult = !!resultOperation && resultRows.length > 0;
  const hasRepairPlan =
    waiting && maintenanceIdle && !stop.isLoading && repairCandidates.length > 0;
  const canRepairCheck = hasRepairPlan && !detachedCheck;
  const repairUnavailable = canRepairCheck
    ? undefined
    : operation?.status === 'completed' && !abnormalCount
      ? '本轮体检未发现需要修复的问题。'
      : '当前结果没有可用的修复方案。';
  const enabledTabs = maintenanceTabs.filter(({ id }) => {
    if (id === 'report') return hasReport;
    if (id === 'repair') return repairing || hasRepairPlan;
    if (id === 'result') return repairing || hasResult;
    return true;
  });
  const preferredTab = requestedTab ?? (repairing ? 'result' : hasReport ? 'report' : 'scan');
  const tab = enabledTabs.some(({ id }) => id === preferredTab)
    ? preferredTab
    : preferredTab === 'repair' && hasResult
      ? 'result'
      : preferredTab === 'result' && hasRepairPlan
        ? 'repair'
        : preferredTab === 'repair' && hasReport
          ? 'report'
          : 'scan';
  const showRepairSetup = tab === 'repair' && hasRepairPlan;
  const showScanSetup = tab === 'scan' && !repairing && !ending;
  const needsSourceRecheck =
    !locked &&
    (databases.some((row) => row.repair?.nextAction === 'check-source') ||
      !!live?.maintenanceError);
  const canExportCurrent = !!operation && (operation.status !== 'cancelled' || scannedCount > 0);
  const canExportCheck =
    !!checkOperation && (checkOperation.status !== 'cancelled' || scannedCount > 0);

  const repairStorage = trpc.dbRepair.repairStorage.useQuery(
    { ...scope, dbNames: namesWithBudget, backups, methods },
    {
      enabled: showRepairSetup && namesWithBudget.length > 0,
      retry: false,
      refetchInterval: showRepairSetup && namesWithBudget.length > 0 ? 2000 : false,
    },
  );
  const space = namesWithBudget.length
    ? repairStorage.data?.flatMap((entry) => entry.space)
    : undefined;
  const insufficientSpace = space?.some(
    ({ freeBytes, requiredBytes }) => freeBytes !== null && freeBytes < requiredBytes,
  );
  const canUseLowSpace =
    repairMethod === 'deep' &&
    !!space?.every(
      ({ freeBytes, requiredBytes }) => freeBytes !== null && freeBytes >= requiredBytes,
    ) &&
    !!space?.some(
      ({ freeBytes, recommendedBytes }) => freeBytes !== null && freeBytes < recommendedBytes,
    );
  const spaceTotal = space?.reduce((sum, { requiredBytes }) => sum + requiredBytes, 0);
  const spacePending = !!backupMode && selectedReady.length > namesWithBudget.length;
  const spaceError = namesWithBudget.length ? repairStorage.error?.message : undefined;
  const spaceStatus = spaceError
    ? '空间无法估算'
    : insufficientSpace
      ? '磁盘空间不足'
      : canUseLowSpace
        ? '磁盘空间偏低'
        : undefined;
  const repairStartBlocked = !selectedReady.length
    ? '请选择数据库'
    : ending
      ? '正在结束维护'
      : starting
        ? '正在准备修复'
        : !backupMode
          ? repairBackupMode.error
            ? '无法读取备份设置'
            : '正在读取备份设置'
          : spaceError || insufficientSpace
            ? spaceStatus
            : undefined;
  const repairStartLabel = repairStartBlocked ?? '开始修复';
  const tightVolumes = space?.filter(
    ({ freeBytes, requiredBytes, recommendedBytes }) =>
      freeBytes !== null && freeBytes < (insufficientSpace ? requiredBytes : recommendedBytes),
  );
  const tightVolume = tightVolumes?.[0];
  const workspacePath = repairStorage.data?.[0]?.cachePath;
  const workspaceNeedsSpace =
    workspacePath && tightVolumes?.some(({ paths }) => paths.includes(workspacePath));
  const spaceDeficit =
    tightVolume?.freeBytes == null
      ? undefined
      : (insufficientSpace ? tightVolume.requiredBytes : tightVolume.recommendedBytes) -
        tightVolume.freeBytes;
  const waitingForSpace =
    resultOperation?.status === 'waiting' &&
    resultOperation.id === operation?.id &&
    resultRows.some((row) => row.repair?.nextAction === 'retry-space');

  const alertSnapshot = tab === 'report' ? (detachedCheck ?? live) : live;
  const alerts = [
    ...new Set(
      [
        surface ? '' : error,
        alertSnapshot?.maintenanceError,
        alertSnapshot?.operation?.error,
        alertSnapshot?.reportError,
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
  }, [scope, tab, openedCheck]);
  useEffect(() => {
    if (requestedTab && tab !== requestedTab)
      setRequestedTab((current) => (current === requestedTab ? tab : current));
  }, [requestedTab, tab]);

  const setRepairSelection = (names: string[]) => {
    for (const name of availableRepairNames) touched.current.add(name);
    setSelected((previous) => [
      ...previous.filter((name) => !availableRepairNames.includes(name)),
      ...names,
    ]);
  };
  const closeReport = () => {
    setReportId(undefined);
    setReportScope(scope);
    setLegacyId(undefined);
  };
  const changeCache = () =>
    act(async () => {
      await pickCache.mutateAsync();
      await cache.refetch();
      await utils.dbRepair.preflight.invalidate();
      await utils.dbRepair.repairStorage.invalidate();
    });
  const changeRepairBackupMode = (mode: DatabaseRepairBackupMode) =>
    act(async () => {
      if (mode === backupMode) return;
      if (
        mode === 'off' &&
        !(await useDialog
          .getState()
          .confirm('关闭修复备份？', '关闭后，新修复将不再生成备份。已有备份仍可用于恢复。', {
            okLabel: '关闭备份',
            cancelLabel: '取消',
            ownerDocument,
          }))
      )
        return;
      await setRepairBackupMode.mutateAsync({ mode });
      await repairBackupMode.refetch();
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
      const operationId = operation?.kind === 'repair' ? operation.id : undefined;
      if (
        operationId &&
        !(await useDialog
          .getState()
          .confirm(
            '停止本轮修复？',
            '将中断尚未提交的重建，并跳过后续数据库。已修复成功的数据库和本轮报告会保留。',
            { okLabel: '停止修复', cancelLabel: '继续修复', danger: 'outline', ownerDocument },
          ))
      )
        return;
      const result = await stop.mutateAsync(operationId ? { ...scope, operationId } : scope);
      if (result) updateLive(result);
      await refresh();
    });
  const exportOperation = (
    target: DatabaseMaintenanceOperation,
    format: ReportFormat,
    { uin, configId }: Pick<DbRepairAccountOption, 'uin' | 'configId'> = scope,
  ) => void act(() => exportReport.mutateAsync({ uin, configId, reportId: target.id, format }));
  const showProgress =
    (tab === 'report' && !detachedCheck && (scanRunning || paused)) ||
    (tab === 'result' && repairing);
  const showLiveOperation = showProgress && operation?.status === 'running';
  const showReportSummary =
    tab === 'report' &&
    !showProgress &&
    checkRows.length > 0 &&
    checkOperation?.status !== 'running';
  const showingReport = tab === 'report' || tab === 'result';
  const reportScanKind = checkOperation?.kind === 'repair' ? undefined : checkOperation?.kind;
  const queuedNames = scanRunning ? queuedScanNames : scanNames;
  const waitingForScan = (name: string) => {
    if (!queuedNames.includes(name)) return undefined;
    const kind =
      scanRunning || setupScanKind === operationScanKind
        ? (queuedKindFor(name) ?? setupScanKind)
        : setupScanKind;
    return !activeScanKind || isWaitingForScan(maintainedRows.get(name), kind) ? kind : undefined;
  };
  const repairNames =
    operation?.kind === 'repair' && operation.status === 'running'
      ? (operation.databaseNames ?? [])
      : starting?.kind === 'repair'
        ? starting.dbNames
        : [];
  const displayedDatabases = tab === 'result' ? (repairing ? [] : resultRows) : checkRows;
  const displayedBytes = tab === 'report' && otherCheckScope ? undefined : bytesByName;
  const displayedRows = new Map<string, DatabaseMaintenanceStatusRow | undefined>(
    displayedDatabases.map((row) => [row.dbName, row]),
  );
  if (tab === 'report' && showProgress) {
    for (const name of queuedNames) {
      if (!displayedRows.has(name)) displayedRows.set(name, undefined);
    }
  }
  if (tab === 'result' && repairing) {
    for (const name of repairNames) displayedRows.set(name, maintainedRows.get(name));
  }
  const selectedDetail = tab === 'result' ? (repairing ? undefined : resultRow) : activeRow;
  const processOperation =
    tab === 'result' && !repairing
      ? resultOperation
      : tab === 'report'
        ? checkOperation
        : operation;
  const progress =
    tab === 'result' && !repairing
      ? resultRow?.progress?.kind === 'repair'
        ? resultRow.progress
        : result?.progress?.dbName === resultRow?.dbName
          ? result?.progress
          : undefined
      : tab === 'report'
        ? showProgress && !focused
          ? check?.progress
          : (activeRow?.progress ?? (!focused ? check?.progress : undefined))
        : (databases.find((row) => row.dbName === operation?.currentDb)?.progress ??
          live?.progress);
  const processRunning = processOperation?.status === 'running' || progress?.status === 'running';
  const activeProgress =
    progress && (progress.status === 'running' || progress.steps.length > 0) ? progress : undefined;
  const restoreCount =
    backupRestore?.step.completed !== undefined && backupRestore.step.total !== undefined
      ? `${formatBytesOrUnknown(backupRestore.step.completed)} / ${formatBytesOrUnknown(backupRestore.step.total)}`
      : undefined;
  const restoreProgress = backupRestore ? (
    <section className="weq-db-progress is-compact" aria-label="备份恢复进度">
      <header className="weq-db-progress-heading">
        <strong>{`${backupRestore.dbName} · ${backupRestore.step.message}`}</strong>
        <span>
          <NumericText>{restoreCount}</NumericText>
        </span>
      </header>
      <TaskProgressBar
        value={databaseStepPercent(backupRestore.step)}
        label={backupRestore.step.message}
        valueText={restoreCount}
      />
    </section>
  ) : null;
  const scanCoverage = `${scannedCount} / ${checkRows.length} 已体检`;
  const repairAvailability =
    !detachedCheck && repairCandidates.length ? ` · ${repairCandidates.length} 个可修复` : '';
  const stopping = stop.isLoading || !!operation?.stopping;
  const hasAppendCandidates = canAppendQuick || canAppendDeep;
  const canSubmitAppend = !!(activeScanKind && !stopping && !ending && namesToAppend.length);
  const showAppendButton =
    !ending &&
    (paused
      ? pendingDeepScan.length > 0
      : scanRunning && (startingScan?.resuming || hasAppendCandidates));
  const scanModeControl = (
    <SegmentedControl
      label="体检类型"
      value={setupScanKind}
      options={[
        { value: 'scan', label: '快速体检' },
        { value: 'checkup', label: '深度体检' },
      ]}
      onChange={(kind) => {
        if (scanRunning) setAppendKind(kind);
        else {
          setAppendKind(undefined);
          setScanKind(kind);
        }
      }}
    />
  );
  const deepScan =
    (activeScanKind ? (operation?.currentScanKind ?? activeScanKind) : startingScanKind) ===
    'checkup';
  const progressTitle = repairing
    ? stopping
      ? '正在停止修复'
      : '正在修复数据库'
    : stopping
      ? '正在暂停体检'
      : live?.state === 'locking'
        ? '正在锁定数据库'
        : deepScan
          ? '正在深度体检'
          : '正在快速体检';
  const checkingCount = activeScanKind
    ? databases.filter((row) => row.scanStatus === 'running' || row.deepStatus === 'running').length
    : 0;
  const batchSummary =
    operation && (!busyStarting || operation.status === 'running') ? (
      <>
        <NumericText>{`${operation.completedDatabases} / ${operation.totalDatabases} 个数据库完成`}</NumericText>
        {checkingCount > 1 ? (
          <NumericText>{` · ${checkingCount} 个正在体检`}</NumericText>
        ) : operation.currentDb ? (
          ` · 当前 ${operation.currentDb}`
        ) : null}
      </>
    ) : (
      '正在准备…'
    );
  const appendButton = showAppendButton ? (
    <button
      className="weq-set-btn"
      type="button"
      onClick={() => {
        if (scanRunning && !additionalNames?.length) setAppendKind(defaultAppendKind);
        setTab('scan');
      }}
    >
      <ScanLine size={14} aria-hidden />
      追加体检
    </button>
  ) : null;
  const appendToScan = () =>
    act(async () => {
      if (!activeScanKind || !operation || !namesToAppend.length) return;
      try {
        await appendScan.mutateAsync({
          ...scope,
          operationId: operation.id,
          dbNames: namesToAppend,
          kind: setupScanKind,
        });
      } catch (cause) {
        // 提交期间当前批次可能已结束，刷新状态后仍可使用原来的选择继续。
        await utils.dbRepair.maintenance.invalidate(scope);
        throw cause;
      }
      setAdditionalNames(undefined);
      setAppendKind(undefined);
      setTab('report');
    });

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
              <NumericText>{scope.uin}</NumericText>
            </span>
          ) : null}
          {backupRestore ? (
            <span className="weq-dbm-state" role="status">
              <LockKeyhole size={12} strokeWidth={2} aria-hidden />
              维护中
            </span>
          ) : locked || live?.state === 'locking' || live?.state === 'ending' ? (
            <button
              type="button"
              className="weq-dbm-state"
              aria-label="维护中，结束维护"
              aria-haspopup="dialog"
              onClick={endMaintenance}
            >
              <LockKeyhole size={12} strokeWidth={2} aria-hidden />
              维护中
            </button>
          ) : null}
        </div>
      </header>

      <div className="weq-dbm-steps" role="tablist" aria-label="数据库维护">
        {maintenanceTabs.map(({ id, label, Icon }) => (
          <button
            id={`dbm-tab-${id}`}
            key={id}
            className={`weq-dbm-step${tab === id ? ' is-current' : ''}`}
            type="button"
            role="tab"
            disabled={!enabledTabs.some((item) => item.id === id)}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            aria-controls="dbm-tab-content"
            onClick={() => setTab(id)}
            onKeyDown={(event) => {
              const offset = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
              if (!offset && event.key !== 'Home' && event.key !== 'End') return;
              event.preventDefault();
              const index = enabledTabs.findIndex((item) => item.id === id);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? enabledTabs.length - 1
                    : (index + offset + enabledTabs.length) % enabledTabs.length;
              const target = enabledTabs[next]!;
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
        {surface !== 'history' ? restoreProgress : null}
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
            <section className="weq-dbm-scan-controls is-scan" aria-label="体检设置">
              <button
                className="weq-set-btn weq-set-btn-primary weq-dbm-scan-start"
                type="button"
                disabled={
                  appendScan.isLoading ||
                  (scanRunning ? !canSubmitAppend : !canScan || stopping || !scanNames.length)
                }
                onClick={() =>
                  void (scanRunning ? appendToScan() : startScan(setupScanKind, scanNames))
                }
              >
                {paused ? (
                  <Play size={30} strokeWidth={1.6} aria-hidden />
                ) : (
                  <ScanLine size={30} strokeWidth={1.6} aria-hidden />
                )}
                {scanRunning ? '加入本轮体检' : paused ? '继续体检' : scanAction}
              </button>
              {scanModeControl}
              <p aria-live="polite">
                {setupScanKind === 'scan'
                  ? '逐页签名检查数据库，找出可能损坏的页。'
                  : '进一步检查数据库结构和索引，尝试定位坏页影响的范围，耗时更长。'}
              </p>
              <p role="status">
                {scanRunning
                  ? '追加的体检会在当前批次完成后开始。'
                  : status.data && !status.data.keyPresent && !status.data.error
                    ? '请先用 WeQ 打开一次这个账号，获取数据库密钥后再开始体检。'
                    : paused && scanNames.length > setupSelection.length
                      ? '继续体检时会一并检查已排队的数据库。'
                      : locked
                        ? '已完成的检查会保留。'
                        : available.length && !scanNames.length
                          ? '请在下方至少选择一个数据库。'
                          : '体检只读取所选数据库，维护期间会暂停写入。'}
              </p>
            </section>

            <ScanDatabaseSelection
              candidates={setupCandidates}
              selected={setupSelection}
              onChange={scanRunning ? setAdditionalNames : setScanCandidates}
              rowsByName={locked || scanRunning || paused ? maintainedRows : undefined}
              waitingFor={(name) => (setupSelection.includes(name) ? setupScanKind : undefined)}
              emptyMessage={
                status.isLoading
                  ? '正在读取数据库列表…'
                  : scanRunning
                    ? `没有可追加${setupScanKind === 'checkup' ? '深度体检' : '快速体检'}的数据库。`
                    : paused
                      ? '没有可追加体检的数据库。'
                      : locked
                        ? `没有待${setupScanKind === 'checkup' ? '深度体检' : '快速体检'}的数据库。`
                        : '没有可体检的数据库。'
              }
            />
          </div>
        ) : null}

        {showProgress ? (
          <section className={`weq-dbm-hero${paused ? '' : ' is-run'}`} aria-label="维护进度">
            <span className="weq-dbm-hero-icon" aria-hidden>
              {paused ? <Pause size={22} /> : <Loader2 size={22} className="weq-spin" />}
            </span>
            <div className="weq-dbm-hero-main" role="status">
              <h2>{paused ? '体检已暂停' : progressTitle}</h2>
              <p>
                {batchSummary}
                {paused && locked ? ' · 已完成的检查会保留' : ''}
              </p>
            </div>
            <div className="weq-dbm-hero-actions">
              {paused ? (
                <button
                  className="weq-set-btn weq-set-btn-primary"
                  type="button"
                  disabled={!canScan || stopping || !scanNames.length}
                  onClick={() => void startScan(setupScanKind, scanNames)}
                >
                  <Play size={14} aria-hidden />
                  继续体检
                </button>
              ) : (
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
                      : '暂停体检'}
                </button>
              )}
              {paused && hasRepairPlan ? (
                <button className="weq-set-btn" type="button" onClick={() => setTab('repair')}>
                  <Wrench size={14} aria-hidden />
                  前往修复
                </button>
              ) : null}
              {appendButton}
              {paused && canExportCurrent && operation ? (
                <ReportExportMenu
                  disabled={exportReport.isLoading}
                  onExport={(format) => exportOperation(operation, format)}
                />
              ) : null}
            </div>
          </section>
        ) : null}
        {(tab === 'scan' || tab === 'repair') && repairing ? (
          <p role="status">修复正在继续，可切换到「修复进度与结果」查看进度。</p>
        ) : null}

        {tab === 'report' && !hasReportRows && !openedCheck && diagnostic ? (
          <section className="weq-dbm-callout">
            <AlertTriangle size={16} aria-hidden />
            <div>
              <strong>{diagnostic.title}</strong>
              <p>{diagnostic.message}</p>
              {diagnostic.details.map((detail) => (
                <p key={detail}>{detail}</p>
              ))}
              {diagnostic.reportPath ? (
                <p className="weq-dbm-path">{diagnostic.reportPath}</p>
              ) : null}
            </div>
          </section>
        ) : null}
        {showReportSummary ? (
          <section
            className={`weq-dbm-hero${abnormalCount ? ' is-warn' : ''}`}
            aria-label="本轮检查结论"
          >
            <span className="weq-dbm-hero-icon" aria-hidden>
              {abnormalCount ? <AlertTriangle size={22} /> : <Database size={22} />}
            </span>
            <div className="weq-dbm-hero-main" role="status">
              <h2>
                {abnormalCount
                  ? `${abnormalCount} 个数据库发现异常`
                  : scannedCount === checkRows.length
                    ? '本轮检查完成'
                    : '本轮检查未完成'}
              </h2>
              <p>
                <NumericText>{`${scanCoverage}${repairAvailability}`}</NumericText>
              </p>
              {otherCheckScope && openedCheck ? (
                <p title={openedCheck.configId}>
                  QQ <NumericText>{openedCheck.uin}</NumericText>
                </p>
              ) : null}
            </div>
            <div className="weq-dbm-hero-actions is-summary">
              <button
                className={`weq-set-btn${canRepairCheck && abnormalCount ? ' weq-set-btn-primary' : ''}`}
                type="button"
                aria-disabled={!canRepairCheck || undefined}
                title={repairUnavailable}
                onClick={() => {
                  if (canRepairCheck) setTab('repair');
                }}
              >
                <Wrench size={14} aria-hidden />
                进入修复
              </button>
              {!detachedCheck && needsSourceRecheck ? (
                <button
                  className="weq-set-btn"
                  type="button"
                  onClick={() => {
                    setScanSelection(databases.map((row) => row.dbName));
                    setTab('scan');
                  }}
                >
                  重新核对原库
                </button>
              ) : !detachedCheck && additionalScanKind && !running ? (
                <button
                  className="weq-set-btn"
                  type="button"
                  onClick={() => {
                    setScanKind(additionalScanKind);
                    setAppendKind(undefined);
                    setNextScanSelection(undefined);
                    setTab('scan');
                  }}
                >
                  <ScanLine size={14} aria-hidden />
                  追加体检
                </button>
              ) : null}
              {canExportCheck && checkOperation ? (
                <ReportExportMenu
                  disabled={exportReport.isLoading}
                  onExport={(format) => exportOperation(checkOperation, format, check ?? scope)}
                />
              ) : null}
            </div>
          </section>
        ) : null}
        {tab === 'result' && !repairing && resultOperation ? (
          <section
            className={`weq-dbm-hero${resultOperation.status === 'completed' ? '' : ' is-warn'}`}
            aria-label="本次修复结论"
          >
            <span className="weq-dbm-hero-icon" aria-hidden>
              {resultOperation.status === 'completed' ? (
                <CheckCircle2 size={22} />
              ) : (
                <AlertTriangle size={22} />
              )}
            </span>
            <div className="weq-dbm-hero-main" role="status">
              <h2>{repairConclusion[resultOperation.status]}</h2>
              <p>
                <NumericText>{`${resultRows.filter((row) => row.repair?.status === 'completed').length} / ${resultRows.length} 个数据库修复成功`}</NumericText>
              </p>
            </div>
            <div className="weq-dbm-hero-actions is-summary">
              {hasRepairPlan && operation?.id === resultOperation.id ? (
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-primary"
                  onClick={() => {
                    if (resultRows.some((row) => row.repair?.nextAction === 'view-deep')) {
                      setRepairMethodOverride('deep');
                    }
                    setTab('repair');
                  }}
                >
                  <Wrench size={14} aria-hidden />
                  继续修复
                </button>
              ) : null}
              <ReportExportMenu
                disabled={exportReport.isLoading}
                onExport={(format) => exportOperation(resultOperation, format)}
              />
            </div>
          </section>
        ) : null}
        {tab === 'result' && live?.storage && (repairing || waitingForSpace) ? (
          <RepairStorageWarning storage={live.storage} waiting={waitingForSpace} />
        ) : null}
        {showingReport && displayedRows.size ? (
          <section className="weq-dbm-dbs" aria-label="数据库列表">
            <div className="weq-dbm-dbs-head">
              <h2>数据库</h2>
              {tab === 'report' && !showReportSummary && !repairing && !paused ? (
                <span className="weq-dbm-dbs-meta">
                  <NumericText>{`${scanCoverage}${abnormalCount ? ` · ${abnormalCount} 个异常` : ''}${repairAvailability}`}</NumericText>
                </span>
              ) : null}
            </div>
            <ul className="weq-dbm-list">
              {[...displayedRows].map(([name, row]) => (
                <li key={name}>
                  <DatabaseCard
                    dbName={name}
                    row={row}
                    bytes={displayedBytes?.get(name)}
                    waitingFor={
                      tab !== 'report'
                        ? undefined
                        : showProgress
                          ? waitingForScan(name)
                          : row?.scanStatus === 'pending'
                            ? (checkOperation?.databaseScanKinds?.[name] ?? reportScanKind)
                            : undefined
                    }
                    current={(selectedDetail?.dbName ?? operation?.currentDb) === name}
                    onFocus={
                      row && (tab !== 'result' || !repairing)
                        ? () => {
                            if (tab === 'result') setResultFocused(name);
                            else setFocused(name);
                          }
                        : undefined
                    }
                    repairResult={tab === 'result'}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {(showLiveOperation || showingReport || (showProgress && paused)) && activeProgress ? (
          <details
            className="weq-dbm-process"
            open={processRunning || (showProgress && paused) || undefined}
          >
            <summary>
              <span className="weq-dbm-process-title">
                {processRunning ? (
                  <Loader2 size={14} className="weq-spin" />
                ) : (
                  <History size={14} />
                )}
                {processRunning || (showProgress && paused) ? '执行进度' : '本次执行过程'}
              </span>
              {!processRunning && processOperation ? (
                <span className="weq-dbm-process-hint">
                  {`${operationLabel(processOperation)} · ${operationStates[processOperation.status]} · ${processOperation.completedDatabases} / ${processOperation.totalDatabases} 个数据库`}
                </span>
              ) : null}
              <ChevronDown size={14} className="weq-dbm-chevron" aria-hidden />
            </summary>
            <div className="weq-dbm-process-body">
              <DatabaseMaintenanceProgress
                progress={activeProgress}
                batch={
                  processOperation ? { ...processOperation, locked: locked && !ending } : undefined
                }
                connectionError={connectionError && processRunning}
                showBatch={false}
                showMaintained={false}
              />
            </div>
          </details>
        ) : showLiveOperation ? (
          <p className="weq-dbm-operation" role="status">
            {operationLabel(operation)} · {operationStates[operation.status]} ·{' '}
            <NumericText>{`${operation.completedDatabases} / ${operation.totalDatabases} 个数据库`}</NumericText>
            {operation.error ? `；${operation.error}` : ''}
          </p>
        ) : null}

        {showingReport && selectedDetail ? (
          <DatabaseDetail
            row={selectedDetail}
            bytes={displayedBytes?.get(selectedDetail.dbName)}
            repairResult={tab === 'result'}
          />
        ) : null}
        {showRepairSetup ? (
          <div className="weq-dbm-scan-setup">
            <section className="weq-dbm-scan-controls" aria-label="修复设置">
              <button
                type="button"
                className={`weq-set-btn weq-set-btn-primary weq-dbm-scan-start weq-dbm-repair-start${insufficientSpace ? ' is-short' : spaceStatus ? ' is-warn' : ''}`}
                aria-label={repairStartLabel}
                aria-describedby={selectedReady.length ? spaceEstimateId : undefined}
                title={tightVolume?.paths.join('、')}
                disabled={!!repairStartBlocked}
                onClick={() => void startRepair()}
              >
                {insufficientSpace ? (
                  <AlertTriangle size={26} strokeWidth={1.6} aria-hidden />
                ) : (
                  <ShieldCheck size={26} strokeWidth={1.6} aria-hidden />
                )}
                <span
                  className={
                    repairStartBlocked === spaceStatus && spaceStatus
                      ? 'weq-dbm-space-title'
                      : undefined
                  }
                >
                  {repairStartLabel}
                </span>
                {selectedReady.length ? (
                  <span className="weq-dbm-repair-estimate" id={spaceEstimateId} aria-live="polite">
                    {spaceStatus && !repairStartBlocked ? (
                      <strong className="weq-dbm-space-title">{spaceStatus}</strong>
                    ) : null}
                    {spaceDeficit !== undefined && !spaceError ? (
                      <span>
                        <NumericText>{`${insufficientSpace ? '还需腾出' : '建议再腾出'} ${formatBytesOrUnknown(spaceDeficit)}`}</NumericText>
                      </span>
                    ) : spacePending ? (
                      '开始后核算空间'
                    ) : spaceTotal !== undefined ? (
                      <span>
                        <NumericText>{`空间预算 ${formatBytesOrUnknown(spaceTotal)}`}</NumericText>
                      </span>
                    ) : (
                      !spaceError && '正在估算空间…'
                    )}
                    {tightVolume && !spaceError ? (
                      <span>
                        <NumericText>{`可用 ${formatBytesOrUnknown(tightVolume.freeBytes)}`}</NumericText>
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </button>
              <SegmentedControl<DatabaseRepairMethod>
                label="修复方式"
                value={repairMethod}
                options={[
                  { value: 'quick', label: '快速修复' },
                  { value: 'deep', label: '深度修复' },
                ]}
                onChange={setRepairMethodOverride}
              />
              <p>
                {repairMethod === 'quick'
                  ? '在克隆副本上修复坏页，通过复核后再替换原库。'
                  : '抢救可读记录并重建数据库。'}
              </p>
              {spaceStatus ? (
                <div className="weq-dbm-repair-space-actions">
                  {spaceError ? <p role="alert">{spaceError}</p> : null}
                  {tightVolume && !spaceError ? (
                    <p title={tightVolume.paths.join('、')}>
                      {repairVolumeLabel(tightVolume.paths, workspacePath)}
                      {insufficientSpace ? ' · 腾出空间后可开始修复。' : ' · 可用空间低于建议值。'}
                    </p>
                  ) : null}
                  {spaceError || workspaceNeedsSpace ? (
                    <p>
                      {!spaceError && '可'}
                      <button
                        type="button"
                        className="weq-dbm-text-btn"
                        disabled={pickCache.isLoading}
                        onClick={() => void changeCache()}
                      >
                        更改工作区位置
                      </button>
                      {!spaceError && '到空间更大的磁盘。'}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </section>
            <ScanDatabaseSelection
              candidates={repairCandidates}
              selected={selectedReady}
              onChange={setRepairSelection}
              emptyMessage="没有可修复的数据库。"
              selectionLabel="修复"
            />
          </div>
        ) : null}
      </div>

      {surface === 'settings' ? (
        <Modal
          presentation="popover"
          anchor={surfaceAnchor}
          width={460}
          labelledBy={settingsTitleId}
          onClose={closeSurface}
        >
          <section className="weq-dialog weq-dbm-settings">
            <header className="weq-dialog-head">
              <h2 className="weq-dialog-title" id={settingsTitleId}>
                数据库修复设置
              </h2>
              <button
                type="button"
                className="weq-dialog-x"
                title="关闭"
                aria-label="关闭"
                onClick={closeSurface}
              >
                <X size={16} aria-hidden />
              </button>
            </header>
            <div className="weq-set">
              {error ? (
                <p className="weq-dbm-alert" role="alert">
                  {error}
                </p>
              ) : null}
              <Row
                label="体检并行数量"
                desc={
                  <span id={concurrencyDescriptionId}>
                    同时检查的数据库数量。更改会在下次开始或继续体检时生效。
                  </span>
                }
                control={
                  <FormSelect
                    aria-label="体检并行数量"
                    aria-describedby={concurrencyDescriptionId}
                    className="weq-set-input weq-number"
                    value={checkupSettings.data?.concurrency ?? ''}
                    disabled={!checkupSettings.data || setCheckupConcurrency.isLoading}
                    onChange={(event) => {
                      const concurrency = Number(event.currentTarget.value);
                      void act(async () => {
                        await setCheckupConcurrency.mutateAsync({ concurrency });
                        await checkupSettings.refetch();
                      });
                    }}
                  >
                    {!checkupSettings.data ? <option value="">—</option> : null}
                    {checkupConcurrencyOptions.map((count) => (
                      <option key={count} value={count}>
                        {count}
                      </option>
                    ))}
                  </FormSelect>
                }
              />
              {checkupSettings.error ? (
                <p className="weq-dbm-alert" role="alert">
                  {checkupSettings.error.message}
                </p>
              ) : null}
              <Row
                label="修复前备份"
                desc={backupMode === 'all' ? '快速修复的备份须与原数据库位于同一磁盘。' : undefined}
                control={
                  <SegmentedControl<DatabaseRepairBackupMode>
                    label="修复前备份"
                    value={backupMode ?? null}
                    disabled={!backupMode || repairing || setRepairBackupMode.isLoading}
                    options={[
                      { value: 'off', label: '关闭' },
                      { value: 'deep', label: '仅深度修复' },
                      { value: 'all', label: '开启' },
                    ]}
                    onChange={(mode) => void changeRepairBackupMode(mode)}
                  />
                }
              />
              {repairBackupMode.error ? (
                <p className="weq-dbm-alert" role="alert">
                  {repairBackupMode.error.message}
                </p>
              ) : null}
              <Row
                label="备份与修复工作区位置"
                desc={cache.data?.override ?? '默认 WeQ 缓存目录'}
                control={
                  <div className="weq-set-btn-group">
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-sm"
                      disabled={repairing || pickCache.isLoading || resetCache.isLoading}
                      onClick={() => void changeCache()}
                    >
                      <FolderOpen size={14} aria-hidden />
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
                          await cache.refetch();
                          await utils.dbRepair.preflight.invalidate();
                          await utils.dbRepair.repairStorage.invalidate();
                        })
                      }
                    >
                      <RotateCcw size={14} aria-hidden />
                      使用默认位置
                    </button>
                  </div>
                }
              />
              {cache.error ? (
                <p className="weq-dbm-alert" role="alert">
                  {cache.error.message}
                </p>
              ) : null}
            </div>
          </section>
        </Modal>
      ) : null}

      {surface === 'history' ? (
        <WindowSurface
          mode="anchored"
          anchor={surfaceAnchor}
          width={680}
          title="历史报告与恢复"
          onClose={closeSurface}
        >
          <section className="weq-dbm weq-dbm-overlay">
            <header className="weq-dbm-overlay-head">
              <h2>历史报告与恢复</h2>
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
            <div className="weq-dbm-body" key={reportId ?? legacyId ?? ''}>
              {restoreProgress}
              {error ? (
                <p className="weq-dbm-alert" role="alert">
                  {error}
                </p>
              ) : null}
              {legacyId ? (
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
                        <strong>{operationLabel(item.operation)}</strong>
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
                            disabled={locked || running || !!backupRestore}
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
                          disabled={locked || running || !!backupRestore || deleteRecord.isLoading}
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
  dbName: string;
  bytes: number | null | undefined;
  row?: DatabaseMaintenanceStatusRow;
  waitingFor?: ScanKind;
  selection?: {
    label: string;
    checked: boolean;
    disabledReason?: string;
    onChange: (checked: boolean) => void;
  };
  current?: boolean;
  repairResult?: boolean;
  onFocus?: () => void;
};

function ScanDatabaseSelection({
  candidates,
  selected,
  onChange,
  emptyMessage,
  selectionLabel = '体检',
  rowsByName,
  waitingFor,
}: {
  candidates: { dbName: string; bytes: number | null; disabledReason?: string }[];
  selected: string[];
  onChange: (names: string[]) => void;
  emptyMessage: string;
  selectionLabel?: string;
  rowsByName?: ReadonlyMap<string, DatabaseMaintenanceStatusRow>;
  waitingFor?: (name: string) => ScanKind | undefined;
}) {
  const enabledNames = candidates
    .filter(({ disabledReason }) => !disabledReason)
    .map(({ dbName }) => dbName);
  const allSelected = selected.length === enabledNames.length;
  return (
    <section className="weq-dbm-scan-databases" aria-label="选择数据库">
      <div className="weq-dbm-dbs-head">
        <h2>数据库</h2>
        {candidates.length ? (
          <div className="weq-dbm-dbs-tools">
            <span className="weq-dbm-selected">
              <NumericText>{`已选 ${selected.length} / ${candidates.length}`}</NumericText>
            </span>
            <button
              type="button"
              className="weq-dbm-text-btn"
              disabled={!enabledNames.length}
              onClick={() => onChange(allSelected ? [] : enabledNames)}
            >
              {allSelected ? '取消全选' : '全选'}
            </button>
          </div>
        ) : null}
      </div>
      {candidates.length ? (
        <ul className="weq-dbm-list">
          {candidates.map(({ dbName, bytes, disabledReason }) => (
            <li key={dbName}>
              <DatabaseCard
                dbName={dbName}
                bytes={bytes}
                row={rowsByName?.get(dbName)}
                waitingFor={waitingFor?.(dbName)}
                selection={{
                  label: selectionLabel,
                  disabledReason,
                  checked: selected.includes(dbName),
                  onChange: (checked) =>
                    onChange(
                      checked ? [...selected, dbName] : selected.filter((name) => name !== dbName),
                    ),
                }}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="weq-dbm-empty" role="status">
          {emptyMessage}
        </p>
      )}
    </section>
  );
}

function DatabaseCard(props: DatabaseCardProps) {
  const { dbName, row, waitingFor, selection } = props;
  const purpose = qqDatabasePurpose(dbName);
  const purposeId = useId();
  const reasonId = useId();
  const tone = row && !waitingFor ? rowTone(row) : 'muted';
  const showRowStatus = row && (row.scanStatus !== 'pending' || !!row.repair);
  const label = waitingFor ? waitingScanLabel(waitingFor) : showRowStatus && rowLabel(row);
  const content = (
    <>
      <span className="weq-dbm-db-top">
        <span className="weq-dbm-db-icon" aria-hidden>
          {tone === 'run' ? (
            <Loader2 size={15} className="weq-spin" />
          ) : tone === 'warn' ? (
            <AlertTriangle size={15} strokeWidth={1.9} />
          ) : tone === 'ok' ? (
            <Check size={15} strokeWidth={2.2} />
          ) : (
            <Database size={15} strokeWidth={1.9} />
          )}
        </span>
        {label ? <Chip tone={tone}>{label}</Chip> : null}
      </span>
      <span className="weq-dbm-db-name">{dbName}</span>
      {purpose ? (
        <span className="weq-dbm-db-purpose" id={purposeId}>
          {purpose}
        </span>
      ) : null}
      {showRowStatus ? (
        <span className="weq-dbm-db-note">
          {waitingFor && row.scanStatus === 'completed' ? '快速体检完成 · ' : ''}
          {rowSummary(row)}
        </span>
      ) : null}
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
  if (selection) {
    return (
      <label
        className={`weq-dbm-db is-selectable${selection.checked ? ' is-selected' : ''}`}
        data-tone={tone}
      >
        {content}
        {selection.disabledReason ? (
          <span className="weq-dbm-db-note" id={reasonId}>
            {selection.disabledReason}
          </span>
        ) : null}
        <input
          type="checkbox"
          className="weq-dbm-db-input"
          aria-label={`${selection.label} ${dbName}`}
          aria-describedby={
            [purpose ? purposeId : '', selection.disabledReason ? reasonId : '']
              .filter(Boolean)
              .join(' ') || undefined
          }
          checked={selection.checked}
          disabled={!!selection.disabledReason}
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
      aria-label={`查看 ${dbName} ${props.repairResult ? '修复详情' : '检查详情'}`}
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
  repairResult = false,
}: {
  row: DatabaseMaintenanceStatusRow;
  bytes: number | null | undefined;
  repairResult?: boolean;
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
    <section
      className="weq-dbm-detail"
      aria-label={`${row.dbName}${repairResult ? '修复结果' : '检查结果'}`}
    >
      <header className="weq-dbm-detail-head">
        <span className="weq-dbm-detail-icon" data-tone={tone} aria-hidden>
          <Database size={16} strokeWidth={1.9} />
        </span>
        <div className="weq-dbm-detail-title">
          <h2>{repairResult ? '数据库修复详情' : '数据库检查详情'}</h2>
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
        {repairResult || row.repair ? (
          <div>
            <dt>本次修复</dt>
            <dd className={row.repair?.status === 'failed' ? 'is-warn' : undefined}>
              {row.repair ? repairStates[row.repair.status] : '未开始'}
            </dd>
          </div>
        ) : null}
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
                <NumericText>
                  {object.samplePages.map((page) => page.toLocaleString('zh-CN')).join('、')}
                </NumericText>
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

function repairVolumeLabel(paths: string[], cachePath?: string) {
  if (!cachePath || !paths.includes(cachePath)) return '原数据库所在磁盘';
  return paths.length > 1 ? '原数据库与工作区所在磁盘' : '工作区所在磁盘';
}

function RepairStorageWarning({
  storage,
  waiting,
}: {
  storage: NonNullable<DatabaseMaintenanceStatus['storage']>;
  waiting: boolean;
}) {
  const insufficient = storage.warning === 'insufficient-space';
  const tight = storage.space.flatMap(({ paths, freeBytes, requiredBytes, recommendedBytes }) => {
    const threshold = insufficient ? requiredBytes : recommendedBytes;
    return freeBytes !== null && freeBytes < threshold
      ? [{ paths, freeBytes, deficit: threshold - freeBytes }]
      : [];
  });
  if (!tight.length && !storage.warning) return null;
  return (
    <section
      className={`weq-dbm-storage-warning${insufficient ? ' is-short' : ''}`}
      aria-label="磁盘空间警告"
    >
      <div className="weq-dbm-storage-heading" role={waiting ? 'alert' : 'status'}>
        <AlertTriangle size={17} aria-hidden />
        <strong className="weq-dbm-space-title">
          {insufficient ? '磁盘空间不足' : '磁盘空间偏低'}
        </strong>
      </div>
      <p>
        {waiting
          ? insufficient
            ? '体检结果已保留。清理空间后，点「继续修复」重新检查。'
            : '体检结果已保留。点「继续修复」重新检查空间。'
          : '可先清理对应磁盘的空间。'}
      </p>
      {tight.length ? (
        <dl>
          {tight.map(({ paths, freeBytes, deficit }) => (
            <div key={paths.join(':')}>
              <dt>{repairVolumeLabel(paths, storage.cachePath)}</dt>
              <dd>
                <span>
                  <NumericText>{`${waiting ? '当时可用' : '可用'} ${formatBytesOrUnknown(freeBytes)} · ${insufficient ? '还差' : '建议再腾出'} ${formatBytesOrUnknown(deficit)}`}</NumericText>
                </span>
                <span className="weq-dbm-path">{paths.join('、')}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

const reportFormats = [
  { value: 'html', label: 'HTML' },
  { value: 'md', label: 'Markdown' },
  { value: 'json', label: 'JSON' },
] as const;
type ReportFormat = (typeof reportFormats)[number]['value'];

function ReportExportMenu({
  disabled,
  onExport,
}: {
  disabled: boolean;
  onExport: (format: ReportFormat) => void;
}) {
  const [menu, setMenu] = useState<{ trigger: HTMLButtonElement; x: number; y: number }>();
  const closeMenu = useCallback(() => {
    setMenu(undefined);
    menu?.trigger.focus();
  }, [menu]);
  return (
    <>
      <button
        className="weq-set-btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        disabled={disabled}
        onClick={({ currentTarget }) => {
          if (menu) closeMenu();
          else {
            const rect = currentTarget.getBoundingClientRect();
            setMenu({ trigger: currentTarget, x: rect.right, y: rect.bottom + 4 });
          }
        }}
      >
        <Download size={14} aria-hidden />
        导出报告
        <ChevronDown size={13} aria-hidden />
      </button>
      {menu ? (
        <ConversationActionsMenu
          x={menu.x}
          y={menu.y}
          dropdown
          label="导出报告"
          onClose={closeMenu}
          actions={reportFormats.map(({ value, label }) => ({
            label,
            icon: <Download size={14} aria-hidden />,
            action: () => onExport(value),
          }))}
        />
      ) : null}
    </>
  );
}

function ExportButtons({ onExport }: { onExport: (format: ReportFormat) => void }) {
  return (
    <div className="weq-dbm-export">
      {reportFormats.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          className="weq-set-btn weq-set-btn-sm"
          onClick={() => onExport(value)}
        >
          <Download size={13} />
          {label}
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
  onExport: (format: ReportFormat) => void;
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
          <h2>{operationLabel(operation)}报告</h2>
          <p>
            <NumericText>{view.uin}</NumericText>
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
                dbName={row.dbName}
                row={row}
                bytes={bytesByName.get(row.dbName)}
                waitingFor={
                  row.scanStatus === 'pending' && operation.kind !== 'repair'
                    ? (operation.databaseScanKinds?.[row.dbName] ?? operation.kind)
                    : undefined
                }
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
              {operationLabel(operation)} · {operationStates[operation.status]}
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
  onExport: (format: ReportFormat) => void;
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
        旧报告没有记录逐项支持情况，也没有本次维护的体检与复核过程。只能查看结果和导出。
      </p>
    </>
  );
}
