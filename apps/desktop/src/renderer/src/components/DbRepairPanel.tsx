import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  Database,
  Download,
  FolderOpen,
  HardDrive,
  History,
  Info,
  Loader2,
  LockKeyhole,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Settings2,
  Square,
  Stethoscope,
  Trash2,
  UnlockKeyhole,
  Wrench,
  X,
} from 'lucide-react';
import {
  databaseReadyForRepair,
  databaseRepairSupportLabel,
  databaseMaintenanceRowAbnormal,
  databaseMaintenanceKindLabel as operationLabels,
  databaseMaintenanceStatusLabel as operationStates,
  databaseRepairStatusLabel as repairStates,
  type DatabaseMaintenanceSnapshot,
  type DatabaseMaintenanceRow,
} from '@weq/service/db-checkup';
import type { DatabaseTaskProgress } from '@weq/service/db-progress';
import { client, trpc } from '../trpc/client';
import { useRenderDocument } from '../lib/renderDocument';
import { useDbRepairReturn } from '../state/dbRepairReturn';
import { useDialog } from './Dialog.shared';
import { QqAvatar } from './QqAvatar';
import { DatabaseMaintenanceProgress } from './DatabaseMaintenanceProgress';
import { SegmentedControl } from './SegmentedControl';
import { WindowSurface } from './WindowSurface';
import { formatBytesOrUnknown } from '../lib/format';
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
const dateText = (at: number | string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(at));

type Tone = 'ok' | 'warn' | 'run' | 'muted';

function rowLabel(row: DatabaseMaintenanceRow) {
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
function rowTone(row: DatabaseMaintenanceRow): Tone {
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
function rowSummary(row: DatabaseMaintenanceRow): string {
  if (row.repair?.status === 'running') return '正在重建这个数据库，期间不要打开这个账号的 QQ。';
  if (row.repair?.status === 'failed') return '修复没有完成，原因见问题明细。';
  if (row.repair?.status === 'waiting') return '已保留扫描结果，处理问题后可重试。';
  if (row.repair?.status === 'cancelled') return '本轮修复已停止，这个库没有提交替换。';
  if (row.repair?.status === 'completed')
    return row.repair.record?.verification?.healthy === false
      ? '重建产物已替换，但复核发现结构异常；请查看下方的复核结果。'
      : '重建产物已替换，并完成了结构复核。';
  if (row.scanStatus === 'pending') return '还没扫描这个数据库。';
  if (row.scanStatus === 'running') {
    const current = row.progress?.current;
    return current?.message ? `${current.message}…` : '正在检查页签名。';
  }
  if (row.scanStatus === 'failed') return '扫描没有完成，暂时没有可用结论。';
  if (row.scan?.plaintext) return '明文数据库，当前重建工具不支持处理它。';
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
    if (row.scan.badPages.length)
      return `扫出 ${row.scan.badPages.length.toLocaleString('zh-CN')} 个坏页，重建会把它们排除在外。`;
    if (row.scan.plaintext) return '明文数据库，没有可校验的加密页签名。';
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

function StepRail({
  phase,
  scanned,
  total,
  ready,
  repaired,
  operationKind,
}: {
  phase: 'idle' | 'scan' | 'review' | 'repair' | 'done';
  scanned: number;
  total: number;
  ready: number;
  repaired: number;
  operationKind?: 'scan' | 'checkup' | 'repair';
}) {
  const active = phase === 'idle' || phase === 'scan' ? 0 : phase === 'review' ? 1 : 2;
  const allDone = phase === 'done';
  const steps = [
    {
      title: '扫描检查',
      caption:
        phase === 'scan'
          ? '进行中'
          : scanned > 0 && scanned === total
            ? `${total} 个库完成`
            : scanned > 0
              ? `${scanned} / ${total} 个库`
              : '未开始',
    },
    {
      title: '查看结果',
      caption:
        phase === 'review'
          ? '待决定'
          : phase === 'repair' || allDone
            ? `${ready} 个可修复`
            : '等待扫描',
    },
    {
      title: '重建修复',
      caption:
        phase === 'repair'
          ? '修复中'
          : repaired > 0
            ? `${repaired} 个已完成`
            : allDone
              ? operationKind === 'repair'
                ? '本轮已结束'
                : '未执行'
              : '未开始',
    },
  ];
  return (
    <ol className="weq-dbm-steps" aria-label="数据库维护流程">
      {steps.map((step, index) => {
        const done = allDone ? operationKind === 'repair' || index < 2 : index < active;
        const current = !allDone && index === active;
        return (
          <li
            key={step.title}
            className={`weq-dbm-step${done ? ' is-done' : ''}${current ? ' is-current' : ''}`}
            aria-current={current ? 'step' : undefined}
          >
            <span className="weq-dbm-step-dot" aria-hidden>
              {done ? <Check size={12} strokeWidth={2.6} /> : index + 1}
            </span>
            <span className="weq-dbm-step-text">
              <strong>{step.title}</strong>
              <em>{step.caption}</em>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

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
  const [live, setLive] = useState<DatabaseMaintenanceSnapshot | null>(null);
  const [reportId, setReportId] = useState(requestedReportId ?? account?.reportId);
  const [reportScope, setReportScope] = useState(scope);
  const sameReportScope = reportScope.uin === scope.uin && reportScope.configId === scope.configId;
  const [legacyId, setLegacyId] = useState<string>();
  const [focused, setFocused] = useState(account?.dbName);
  const [selected, setSelected] = useState<string[]>([]);
  const [backup, setBackup] = useState(true);
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
  const report = trpc.dbRepair.report.useQuery(
    { ...reportScope, reportId: reportId ?? '' },
    {
      enabled: !!reportId,
      retry: false,
      cacheTime: 0,
      refetchInterval: (value) =>
        !sameReportScope && value?.operation.status === 'running' ? 1000 : false,
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
    }
    const defaults = live.databases
      .filter(
        (row) =>
          databaseReadyForRepair(row) &&
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
  const startScan = (kind: 'scan' | 'checkup') =>
    act(async () => {
      if (
        rescanning &&
        !(await useDialog
          .getState()
          .confirm(
            '重新扫描数据库？',
            '将重新检查全部目标数据库，替换当前页内结果。已有历史报告会保留，扫描不会执行修复。',
            { okLabel: '重新扫描', cancelLabel: '继续查看', ownerDocument },
          ))
      )
        return;
      window.electron?.ipcRenderer.send('db-repair:scope', scope);
      setReportId(undefined);
      setReportScope(scope);
      setLegacyId(undefined);
      setStarting(kind);
      setAllowLowSpace(false);
      try {
        if (rescanning) await end.mutateAsync(scope);
        setLive(await scan.mutateAsync({ ...scope, kind }));
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
      const names = selected.filter((name) =>
        live?.databases.some((row) => row.dbName === name && databaseReadyForRepair(row)),
      );
      if (!names.length) return;
      if (
        !(await useDialog
          .getState()
          .confirm(
            '修复所选数据库？',
            `${names.join('、')} 将使用当前维护中已有的扫描结果重建并替换。${backup ? '修复前保留备份，本次维护中已成功的备份会直接复用。' : '本次不保留备份。'}${allowLowSpace ? '本次允许在预留空间不足时尝试修复；实际空间不足时会返回查看结果。' : ''}修复过程中可以停止，已成功的库不会回退。`,
            { okLabel: '开始修复', cancelLabel: '继续查看', ownerDocument },
          ))
      ) {
        setAllowLowSpace(false);
        return;
      }
      setReportId(undefined);
      setReportScope(scope);
      setLegacyId(undefined);
      setStarting('repair');
      try {
        const result = await repair.mutateAsync({
          ...scope,
          dbNames: names,
          backup,
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
    (running && live?.operation?.kind === 'repair');
  const ending = live?.state === 'ending';
  const locked = !!live?.locked && live.state !== 'ended';
  const waiting = live?.state === 'waiting' && !ending;
  const paused =
    waiting && live?.operation?.kind !== 'repair' && live?.operation?.status === 'cancelled';
  const rescanning = !!live?.operation && !paused;
  const databases =
    view?.databases ??
    status.data?.databases
      .filter((row) => row.exists)
      .map(
        (row): DatabaseMaintenanceRow => ({
          dbName: row.dbName,
          scanStatus: 'pending',
          support: 'possible',
          issues: [],
        }),
      ) ??
    [];
  const bytesByName = useMemo(
    () => new Map(status.data?.databases.map((row) => [row.dbName, row.bytes]) ?? []),
    [status.data],
  );
  const activeRow =
    databases.find((row) => row.dbName === focused) ??
    databases.find((row) => row.dbName === view?.operation?.currentDb) ??
    databases[0];
  const progressOwner = view?.operation?.currentDb
    ? (databases.find((row) => row.dbName === view.operation?.currentDb) ?? activeRow)
    : activeRow;
  const progress = progressOwner?.progress ?? view?.progress;
  const readyNames = live?.databases.filter(databaseReadyForRepair).map((row) => row.dbName) ?? [];
  const selectedReady = selected.filter((name) => readyNames.includes(name));
  const scannedCount = databases.filter((row) => row.scanStatus === 'completed').length;
  const abnormalCount = databases.filter((row) => databaseMaintenanceRowAbnormal(row)).length;
  const unsupportedCount = databases.filter((row) => row.support === 'unsupported').length;
  const failedCount = databases.filter((row) => row.scanStatus === 'failed').length;
  const repairedCount = databases.filter((row) => row.repair?.status === 'completed').length;
  const allScanned = databases.length > 0 && scannedCount === databases.length;
  const canScan =
    !!status.data?.keyPresent && !status.data.error && !running && !ending && !repairing;
  const showFooter = waiting && !running && !repairing && !ending && readyNames.length > 0;
  const operation = view?.operation;
  const stepPhase: 'idle' | 'scan' | 'review' | 'repair' | 'done' =
    ending || repairing
      ? 'repair'
      : waiting
        ? 'review'
        : running ||
            live?.state === 'locking' ||
            live?.state === 'scanning' ||
            live?.state === 'checking'
          ? 'scan'
          : live?.state === 'ended'
            ? 'done'
            : 'idle';
  const activeProgress =
    progress && (progress.status === 'running' || progress.steps.length > 0) ? progress : undefined;
  const alerts = [
    ...new Set(
      [
        surface ? '' : error,
        live?.maintenanceError,
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
  }, [scope]);

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
  const scanControls = (
    <div className="weq-dbm-scan-controls">
      <SegmentedControl
        label="体检模式"
        value={scanKind}
        options={[
          { value: 'scan', label: '快速体检', title: '检查数据库页签名' },
          { value: 'checkup', label: '深度体检', title: '检查页签名、整库结构与索引' },
        ]}
        disabled={running || ending || repairing}
        onChange={setScanKind}
      />
      {running && !repairing ? (
        <button
          type="button"
          className="weq-set-btn"
          disabled={stop.isLoading || !!live?.operation?.stopping}
          onClick={() =>
            void act(async () => {
              const result = await stop.mutateAsync(scope);
              if (result) setLive(result);
              await refresh();
            })
          }
        >
          <Pause size={14} />
          {stop.isLoading || live?.operation?.stopping ? '正在暂停' : '暂停扫描'}
        </button>
      ) : (
        <button
          type="button"
          className={`weq-set-btn${rescanning ? '' : ' weq-set-btn-primary'}`}
          disabled={!canScan}
          onClick={() => void startScan(scanKind)}
        >
          {rescanning ? <RefreshCw size={14} /> : <Play size={14} />}
          {paused ? '继续扫描' : rescanning ? '重新扫描' : '开始扫描'}
        </button>
      )}
    </div>
  );

  const hero = (() => {
    if (!account)
      return {
        tone: 'muted' as Tone,
        icon: <Database size={22} strokeWidth={1.9} />,
        title: '没有可用的账号',
        sub: '先在 WeQ 里登录一个账号，再回来检查它的数据库。',
        actions: null,
      };
    if (status.data && !status.data.keyPresent && !status.data.error)
      return {
        tone: 'warn' as Tone,
        icon: <AlertTriangle size={22} strokeWidth={1.9} />,
        title: '缺少数据库密钥',
        sub: '先用 WeQ 打开一次这个账号，拿到密钥后回到这里扫描。没有密钥无法检查加密数据库。',
        actions: null,
      };
    if (ending)
      return {
        tone: 'run' as Tone,
        icon: <Loader2 size={22} strokeWidth={2} className="weq-spin" />,
        title: '正在结束维护',
        sub: '正在释放这个账号全部目标数据库的维护锁，完成后数据库会恢复可写。',
        actions: null,
      };
    if (repairing) {
      const completed = operation?.completedDatabases ?? 0;
      const total = operation?.totalDatabases ?? selectedReady.length;
      return {
        tone: 'run' as Tone,
        icon: <Loader2 size={22} strokeWidth={2} className="weq-spin" />,
        title: operation?.stopping ? '正在停止修复' : '正在修复数据库',
        sub: `${completed} / ${total} 个数据库完成${
          operation?.currentDb ? ` · 当前 ${operation.currentDb}` : ''
        }${operation?.stopping ? ' · 停止后不再开始后续数据库，已成功的库不回退' : ''}`,
        actions: (
          <button
            type="button"
            className="weq-set-btn"
            disabled={stop.isLoading || !!operation?.stopping}
            onClick={() =>
              void act(async () => {
                const result = await stop.mutateAsync(scope);
                if (result) setLive(result);
                await refresh();
              })
            }
          >
            <Square size={13} />
            {stop.isLoading || operation?.stopping ? '正在停止' : '停止修复'}
          </button>
        ),
      };
    }
    if (
      running ||
      live?.state === 'locking' ||
      live?.state === 'scanning' ||
      live?.state === 'checking'
    ) {
      const deep =
        starting === 'checkup' ||
        live?.state === 'checking' ||
        (live?.operation?.kind === 'checkup' && live.operation.status === 'running');
      const total = operation?.totalDatabases ?? databases.length;
      const completed = operation?.completedDatabases ?? 0;
      return {
        tone: 'run' as Tone,
        icon: <Loader2 size={22} strokeWidth={2} className="weq-spin" />,
        title:
          live?.state === 'locking' ? '正在锁定数据库' : deep ? '正在深度体检' : '正在扫描数据库',
        sub:
          live?.state === 'locking'
            ? '正在为本次数据源的全部目标数据库加维护锁。锁定期间 WeQ 只能只读浏览，写库操作会暂停。'
            : `${completed} / ${total} 个数据库完成${
                operation?.currentDb ? ` · 正在检查 ${operation.currentDb}` : ''
              }`,
        actions: scanControls,
      };
    }
    if (waiting) {
      const tone: Tone = abnormalCount || failedCount ? 'warn' : unsupportedCount ? 'muted' : 'ok';
      const title =
        abnormalCount > 0
          ? `${abnormalCount} 个数据库发现异常`
          : failedCount > 0
            ? `${failedCount} 个数据库扫描未完成`
            : databases.length === 0
              ? '没有可维护的数据库'
              : scannedCount < databases.length
                ? '只完成了部分扫描'
                : unsupportedCount > 0
                  ? `${unsupportedCount} 个数据库不支持修复`
                  : '全部数据库检查通过';
      const sub =
        databases.length === 0
          ? '这个账号的数据库目录里没有可维护的文件。'
          : `数据库仍在维护中，等待决定 · ${scannedCount} / ${databases.length} 个数据库已扫描 · ${readyNames.length} 个可以重建修复${
              unsupportedCount ? ` · ${unsupportedCount} 个不支持修复` : ''
            }${failedCount ? ` · ${failedCount} 个没有结论` : ''}`;
      return {
        tone,
        icon:
          tone === 'ok' ? (
            <ShieldCheck size={22} strokeWidth={1.9} />
          ) : (
            <AlertTriangle size={22} strokeWidth={1.9} />
          ),
        title:
          operation?.status === 'waiting'
            ? '已返回查看结果，等待处理后重试'
            : paused
              ? '扫描已暂停'
              : title,
        sub:
          operation?.status === 'waiting'
            ? '维护锁和未替换数据库的扫描结果仍保留，处理问题后可直接重试；已成功修复的库不会重复修复。'
            : paused
              ? `已保留完成的检查和维护锁，可切换体检模式后继续扫描。${scannedCount} / ${databases.length} 个数据库已有页扫描结果。`
              : sub,
        actions: (
          <>
            {scanControls}
            <button
              type="button"
              className="weq-set-btn"
              disabled={end.isLoading || ending || repairing}
              title="释放维护锁；本次扫描结果会被放弃，历史报告仍保留"
              onClick={() => void endMaintenance()}
            >
              <UnlockKeyhole size={14} />
              结束维护
            </button>
          </>
        ),
      };
    }
    if (live?.state === 'ended')
      return {
        tone: 'muted' as Tone,
        icon: <CheckCircle2 size={22} strokeWidth={1.9} />,
        title:
          operation?.kind !== 'repair' && operation?.status === 'cancelled' && !scannedCount
            ? '扫描已停止'
            : '本次维护已结束',
        sub:
          operation?.kind !== 'repair' && operation?.status === 'cancelled' && !scannedCount
            ? '本次没有完成任何数据库的扫描，维护锁已释放，未保存报告。'
            : `数据库已解锁。本次${operation ? operationLabels[operation.kind] : '维护'}报告已保留，可随时重新扫描。`,
        actions: scanControls,
      };
    const qqHint = status.data?.qqPid
      ? `QQ 正在运行（PID ${status.data.qqPid}），建议先退出。`
      : '建议先退出 QQ。';
    return {
      tone: 'muted' as Tone,
      icon: <Stethoscope size={22} strokeWidth={1.9} />,
      title: '先扫描一次数据库',
      sub: databases.length
        ? `${qqHint}扫描是只读的，但会锁定本次数据源的 ${databases.length} 个目标数据库；打开这个窗口不会自动开始检查。`
        : `${qqHint}扫描是只读的，但会锁定本次数据源的目标数据库；打开这个窗口不会自动开始检查。`,
      actions: scanControls,
    };
  })();

  return (
    <section className="weq-dbm" aria-label="数据库修复">
      <header className="weq-dbm-head">
        <div className="weq-dbm-title">
          <span className="weq-dbm-title-icon" aria-hidden>
            <Database size={17} strokeWidth={1.9} />
          </span>
          <div>
            <h1>数据库修复</h1>
            <p>扫描、检查并重建这个账号的 QQ 数据库</p>
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
          {locked ? (
            <span
              className="weq-dbm-state"
              title={repairing ? '修复中' : '维护中'}
              aria-label={repairing ? '修复中' : '维护中'}
            >
              <LockKeyhole size={12} strokeWidth={2} aria-hidden />
              {repairing ? '修复中' : '维护中'}
            </span>
          ) : null}
        </div>
      </header>

      <StepRail
        phase={stepPhase}
        scanned={scannedCount}
        total={databases.length}
        ready={readyNames.length}
        repaired={repairedCount}
        operationKind={operation?.kind}
      />

      <div className="weq-dbm-body" ref={bodyRef}>
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

        {hero ? (
          <section className={`weq-dbm-hero is-${hero.tone}`} aria-label="维护状态">
            <span className="weq-dbm-hero-icon" aria-hidden>
              {hero.icon}
            </span>
            <div className="weq-dbm-hero-main">
              <h2>{hero.title}</h2>
              <p>{hero.sub}</p>
            </div>
            {hero.actions ? <div className="weq-dbm-hero-actions">{hero.actions}</div> : null}
          </section>
        ) : null}

        <RepairStorageWarning
          scope={scope}
          names={selectedReady.length ? selectedReady : readyNames}
          backup={backup}
          enabled={waiting && !running}
          storage={waiting || repairing ? live?.storage : undefined}
          onChangeCache={() => void changeCache()}
          cacheDisabled={repairing || pickCache.isLoading || resetCache.isLoading}
        />

        {!view?.operation && account?.diagnostic ? (
          <section className="weq-dbm-callout">
            <AlertTriangle size={16} aria-hidden />
            <div>
              <strong>{account.diagnostic.title}</strong>
              <p>{account.diagnostic.message}</p>
              {account.diagnostic.details.map((detail) => (
                <p key={detail}>{detail}</p>
              ))}
              {account.diagnostic.reportPath ? (
                <p className="weq-dbm-path">已有报告：{account.diagnostic.reportPath}</p>
              ) : null}
            </div>
          </section>
        ) : null}

        {databases.length === 0 && status.isLoading ? (
          <p className="weq-dbm-loading" role="status">
            <Loader2 size={15} className="weq-spin" />
            正在读取数据库列表…
          </p>
        ) : databases.length === 0 ? (
          <p className="weq-dbm-empty">
            <Database size={20} strokeWidth={1.6} aria-hidden />
            这个账号的数据库目录里没有可维护的文件。
          </p>
        ) : (
          <section className="weq-dbm-dbs" aria-label="数据库列表">
            <div className="weq-dbm-dbs-head">
              <h2>数据库</h2>
              <span className="weq-dbm-dbs-meta">
                {scannedCount} / {databases.length} 已扫描
                {abnormalCount ? ` · ${abnormalCount} 个异常` : ''}
                {readyNames.length ? ` · ${readyNames.length} 个可修复` : ''}
              </span>
              {waiting && readyNames.length ? (
                <span className="weq-dbm-dbs-tools">
                  <span className="weq-dbm-selected">
                    已选 {selectedReady.length} / {readyNames.length}
                  </span>
                  <button
                    type="button"
                    className="weq-dbm-text-btn"
                    onClick={() => selectAll(!allReadySelected)}
                  >
                    {allReadySelected ? '取消全选' : '全选可修复'}
                  </button>
                </span>
              ) : null}
            </div>
            <ul className={`weq-dbm-list${waiting ? ' is-selectable' : ''}`}>
              {databases.map((row) => (
                <li key={row.dbName}>
                  <DatabaseCard
                    row={row}
                    bytes={bytesByName.get(row.dbName)}
                    selected={selected.includes(row.dbName)}
                    current={activeRow?.dbName === row.dbName}
                    selectable={waiting && databaseReadyForRepair(row)}
                    disabled={running || ending || !databaseReadyForRepair(row)}
                    onFocus={() => setFocused(row.dbName)}
                    onSelect={(checked) => {
                      touched.current.add(row.dbName);
                      setAllowLowSpace(false);
                      setSelected((values) =>
                        checked
                          ? [...new Set([...values, row.dbName])]
                          : values.filter((name) => name !== row.dbName),
                      );
                    }}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}

        {activeProgress ? (
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
        ) : operation ? (
          <p className="weq-dbm-operation" role="status">
            {operationLabels[operation.kind]} · {operationStates[operation.status]} ·{' '}
            {operation.completedDatabases} / {operation.totalDatabases} 个数据库
            {operation.error ? `；${operation.error}` : ''}
          </p>
        ) : null}

        {activeRow && (view?.operation || activeRow.scanStatus !== 'pending') ? (
          <DatabaseDetail row={activeRow} bytes={bytesByName.get(activeRow.dbName)} />
        ) : null}

        {waiting && !allScanned ? (
          <p className="weq-dbm-note">
            <Info size={14} aria-hidden />
            还有 {databases.length - scannedCount} 个数据库没有扫描结果；它们不会参与本轮修复。
          </p>
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
                ? `${namesText(selectedReady)} · ${backup ? '修复前保留备份' : '不保留备份'}`
                : `${readyNames.length} 个数据库可以重建修复`}
            </span>
          </div>
          <div className="weq-dbm-foot-actions">
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
                <label className="weq-dbm-option">
                  <input
                    type="checkbox"
                    checked={backup}
                    disabled={!!starting}
                    onChange={(event) => setBackup(event.target.checked)}
                  />
                  <span>
                    <strong>修复前保留备份</strong>
                    <em>修复后可在历史记录里恢复这一份备份。</em>
                  </span>
                </label>
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
                <label className="weq-dbm-option">
                  <input
                    type="checkbox"
                    checked={allowLowSpace}
                    disabled={!!starting}
                    onChange={(event) => setAllowLowSpace(event.target.checked)}
                  />
                  <span>
                    <strong>预留空间不足时仍尝试修复</strong>
                    <em>仍需满足预计写入空间；后续空间不足时保留扫描结果，腾出空间后可重试。</em>
                  </span>
                </label>
                {selectedReady.length ? (
                  <div className="weq-dbm-space">
                    <span className="weq-dbm-space-title">
                      <HardDrive size={13} />
                      空间检查
                    </span>
                    {selectedReady.map((name) => (
                      <RepairBudget
                        key={`${name}:${cache.data?.override ?? ''}`}
                        scope={scope}
                        dbName={name}
                        enabled={!starting}
                        backup={backup}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            </details>
            <button
              type="button"
              className="weq-set-btn weq-set-btn-primary"
              disabled={!selectedReady.length || !!starting || ending}
              onClick={() => void startRepair()}
            >
              <ShieldCheck size={15} />
              修复所选数据库
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
                          {dateText(item.operation.startedAt)} ·{' '}
                          {operationStates[item.operation.status]} ·{' '}
                          {item.operation.completedDatabases} / {item.operation.totalDatabases}{' '}
                          个数据库
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
                        <span>{dateText(record.at)}</span>
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

function DatabaseCard({
  row,
  bytes,
  selected,
  current,
  selectable,
  disabled,
  onFocus,
  onSelect,
}: {
  row: DatabaseMaintenanceRow;
  bytes: number | null | undefined;
  selected: boolean;
  current: boolean;
  selectable: boolean;
  disabled: boolean;
  onFocus: () => void;
  onSelect: (checked: boolean) => void;
}) {
  const tone = rowTone(row);
  const content = (
    <>
      <span className="weq-dbm-db-top">
        <span className="weq-dbm-db-icon" aria-hidden>
          {row.scanStatus === 'running' ||
          row.deepStatus === 'running' ||
          row.repair?.status === 'running' ? (
            <Loader2 size={15} className="weq-spin" />
          ) : tone === 'warn' ? (
            <AlertTriangle size={15} strokeWidth={1.9} />
          ) : tone === 'ok' ? (
            <Check size={15} strokeWidth={2.2} />
          ) : (
            <Database size={15} strokeWidth={1.9} />
          )}
        </span>
        <Chip tone={tone}>{rowLabel(row)}</Chip>
      </span>
      <span className="weq-dbm-db-name">{row.dbName}</span>
      <span className="weq-dbm-db-note">{rowSummary(row)}</span>
      <span className="weq-dbm-db-foot">
        <span>{formatBytesOrUnknown(bytes)}</span>
        {row.scan ? <span>{row.scan.pageCount.toLocaleString('zh-CN')} 页</span> : null}
        {row.scan?.badPages.length ? (
          <span className="is-warn">{row.scan.badPages.length.toLocaleString('zh-CN')} 坏页</span>
        ) : null}
        {row.deepStatus === 'partial' ||
        (row.integrity?.ran && row.integrity.complete === false) ? (
          <span className="is-warn">有未核验项</span>
        ) : null}
      </span>
    </>
  );
  return (
    <div className="weq-dbm-db-wrap">
      <button
        type="button"
        className={`weq-dbm-db${selectable ? ' is-selectable' : ''}${current ? ' is-current' : ''}${selectable && selected ? ' is-selected' : ''}`}
        data-tone={tone}
        aria-label={`查看 ${row.dbName} 检查详情`}
        aria-pressed={current}
        onClick={onFocus}
      >
        {content}
      </button>
      {selectable ? (
        <input
          type="checkbox"
          className="weq-dbm-db-input"
          aria-label={`修复 ${row.dbName}`}
          checked={selected}
          disabled={disabled}
          onChange={(event) => onSelect(event.target.checked)}
          onFocus={onFocus}
        />
      ) : null}
    </div>
  );
}

function DatabaseDetail({
  row,
  bytes,
}: {
  row: DatabaseMaintenanceRow;
  bytes: number | null | undefined;
}) {
  const tone = rowTone(row);
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
          <span>{row.dbName}</span>
        </div>
        <Chip tone={tone}>{rowLabel(row)}</Chip>
        <span className="weq-dbm-detail-support">{databaseRepairSupportLabel[row.support]}</span>
      </header>
      {!row.scan?.plaintext ? <p className="weq-dbm-verdict">{rowSummary(row)}</p> : null}
      <dl className="weq-dbm-metrics">
        <div>
          <dt>文件大小</dt>
          <dd>{formatBytesOrUnknown(bytes)}</dd>
        </div>
        <div>
          <dt>页数</dt>
          <dd>{row.scan ? row.scan.pageCount.toLocaleString('zh-CN') : '—'}</dd>
        </div>
        <div>
          <dt>坏页</dt>
          <dd className={row.scan?.badPages.length ? 'is-warn' : undefined}>
            {row.scan ? row.scan.badPages.length.toLocaleString('zh-CN') : '—'}
          </dd>
        </div>
        <div>
          <dt>全零页</dt>
          <dd>{row.scan ? row.scan.zeroPages.length.toLocaleString('zh-CN') : '—'}</dd>
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
      {row.repair?.record?.verification ? (
        <div className="weq-dbm-verify">
          <CheckCircle2 size={15} aria-hidden />
          <span>
            修复产物复核：
            {row.repair.record.verification.healthy
              ? row.repair.record.verification.complete === false
                ? '已检查部分正常，仍有未核验项'
                : '结构正常'
              : '结构异常'}{' '}
            · 坏页 {row.repair.record.verification.badPages.length}
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
}: {
  scope: { uin: string; configId?: string };
  dbName: string;
  enabled: boolean;
  backup: boolean;
}) {
  const budget = trpc.dbRepair.preflight.useQuery(
    { ...scope, dbName, backup },
    { enabled, retry: false },
  );
  if (budget.error)
    return (
      <p className="weq-dbm-budget is-warn">
        <strong>{dbName}</strong>
        <span>{budget.error.message}</span>
      </p>
    );
  if (!budget.data) return null;
  const tight = budget.data.space?.some(
    (volume) => volume.freeBytes !== null && volume.freeBytes < volume.recommendedBytes,
  );
  return (
    <div className={`weq-dbm-budget${tight ? ' is-warn' : ''}`}>
      <strong>{dbName}</strong>
      {budget.data.space?.map((volume) => (
        <span key={volume.paths.join(':')}>
          可用 {formatBytesOrUnknown(volume.freeBytes)} · 预计新增峰值{' '}
          {formatBytesOrUnknown(volume.requiredBytes)} · 建议预留{' '}
          {formatBytesOrUnknown(volume.recommendedBytes)}
        </span>
      ))}
    </div>
  );
}

function RepairStorageWarning({
  scope,
  names,
  backup,
  enabled,
  storage,
  onChangeCache,
  cacheDisabled,
}: {
  scope: { uin: string; configId?: string };
  names: string[];
  backup: boolean;
  enabled: boolean;
  storage?: DatabaseMaintenanceSnapshot['storage'];
  onChangeCache: () => void;
  cacheDisabled: boolean;
}) {
  const budget = trpc.dbRepair.repairStorage.useQuery(
    { ...scope, dbNames: names, backup },
    { enabled: enabled && names.length > 0, retry: false, refetchInterval: enabled ? 2000 : false },
  );
  const estimates =
    !enabled && storage ? [storage] : enabled ? (budget.data ?? (storage ? [storage] : [])) : [];
  const tight = estimates.flatMap((item) =>
    item.space
      .filter((volume) => volume.freeBytes !== null && volume.freeBytes < volume.recommendedBytes)
      .map((volume) => ({ ...volume, cachePath: item.cachePath })),
  );
  const previousWarning = enabled && storage?.warning;
  if (!tight.length && !previousWarning)
    return budget.error && enabled ? (
      <p className="weq-dbm-alert" role="alert">
        无法检查备份与修复工作区空间：{budget.error.message}
      </p>
    ) : null;
  const grouped = new Map<string, (typeof tight)[number]>();
  const displayed = tight.length
    ? tight
    : estimates.flatMap((item) =>
        item.space.map((volume) => ({ ...volume, cachePath: item.cachePath })),
      );
  for (const volume of displayed) {
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
          {!tight.length && previousWarning
            ? '上次修复遇到空间不足'
            : tight.some((volume) => volume.freeBytes! < volume.requiredBytes)
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
                可用 {formatBytesOrUnknown(volume.freeBytes)} · {!enabled ? '后续' : '预计'}新增峰值{' '}
                {formatBytesOrUnknown(volume.requiredBytes)}
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
  view: DatabaseMaintenanceSnapshot;
  operation: NonNullable<DatabaseMaintenanceSnapshot['operation']>;
  bytesByName: Map<string, number | null>;
  progress?: DatabaseTaskProgress;
  activeRow?: DatabaseMaintenanceRow;
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
            {view.configId ? ` · ${view.configId}` : ''} · {dateText(operation.startedAt)}
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
            {operation.completedDatabases} / {operation.totalDatabases} 完成
          </dd>
        </div>
        <div>
          <dt>异常</dt>
          <dd className={abnormal ? 'is-warn' : undefined}>{abnormal} 个</dd>
        </div>
        <div>
          <dt>{operation.kind === 'repair' ? '修复成功' : '可修复'}</dt>
          <dd>{operation.kind === 'repair' ? repaired : ready} 个</dd>
        </div>
        <div>
          <dt>未完成</dt>
          <dd className={operation.failedDatabases ? 'is-warn' : undefined}>
            {operation.failedDatabases ?? 0} 个
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
                selected={false}
                current={activeRow?.dbName === row.dbName}
                selectable={false}
                disabled
                onFocus={() => onFocus(row.dbName)}
                onSelect={() => {}}
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
            {dateText(data.at)} · {recordStates[data.state]}
          </p>
        </div>
        <ExportButtons onExport={onExport} />
      </header>
      <dl className="weq-dbm-report-metrics">
        <div>
          <dt>坏页</dt>
          <dd className={data.badPages.length ? 'is-warn' : undefined}>{data.badPages.length}</dd>
        </div>
        <div>
          <dt>源库大小</dt>
          <dd>{formatBytesOrUnknown(data.beforeBytes)}</dd>
        </div>
        <div>
          <dt>产物大小</dt>
          <dd>{formatBytesOrUnknown(data.afterBytes)}</dd>
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
