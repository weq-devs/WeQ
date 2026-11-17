import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  Database,
  Download,
  FolderOpen,
  History,
  LockKeyhole,
  Play,
  RotateCcw,
  ShieldCheck,
  Square,
  Stethoscope,
  UnlockKeyhole,
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
import { client, trpc } from '../trpc/client';
import { useRenderDocument } from '../lib/renderDocument';
import { useDbRepairReturn } from '../state/dbRepairReturn';
import { useDialog } from './Dialog.shared';
import { QqAvatar } from './QqAvatar';
import { DatabaseMaintenanceProgress } from './DatabaseMaintenanceProgress';
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
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState(false);
  const touched = useRef(new Set<string>());
  const bodyRef = useRef<HTMLDivElement>(null);
  const displayedOperation = useRef<string | undefined>(undefined);
  const sessionId = useRef<string | undefined>(undefined);
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
  }, [requestedReportId, account?.reportId, resultRequest, scope]);
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
      window.electron?.ipcRenderer.send('db-repair:scope', scope);
      setReportId(undefined);
      setReportScope(scope);
      setLegacyId(undefined);
      setStarting(true);
      window.electron?.ipcRenderer.send('db-repair:scope', scope);
      setAllowLowSpace(false);
      try {
        setLive(await scan.mutateAsync({ ...scope, kind }));
        await refresh();
      } finally {
        setStarting(false);
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
            `${names.join('、')} 将使用当前维护中已有的扫描结果重建并替换。${backup ? '修复前保留备份。' : '本次不保留备份。'}${allowLowSpace ? '本次明确接受建议余量不足；预计峰值不足仍会中止对应数据库。' : ''}修复过程中可以停止，已成功的库不会回退。`,
            { okLabel: '开始修复', cancelLabel: '继续查看', ownerDocument },
          ))
      ) {
        setAllowLowSpace(false);
        return;
      }
      setReportId(undefined);
      setReportScope(scope);
      setLegacyId(undefined);
      setStarting(true);
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
        setStarting(false);
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
            `${preview.record.dbName} 将恢复为这份备份。${preview.matchesAfter ? '' : '当前数据库在修复后发生过变化，恢复会覆盖这些变化。'}`,
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
  const view = reportId
    ? sameReportScope && live?.operation?.id === reportId
      ? live
      : report.data
    : live;
  const running = live?.operation?.status === 'running' || starting;
  const repairing = live?.state === 'repairing';
  const ending = live?.state === 'ending';
  const locked = !!live?.locked && live.state !== 'ended';
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
  const activeRow =
    databases.find((row) => row.dbName === focused) ??
    databases.find((row) => row.dbName === view?.operation?.currentDb) ??
    databases[0];
  const progress = activeRow?.progress ?? view?.progress;
  const readyNames = live?.databases.filter(databaseReadyForRepair).map((row) => row.dbName) ?? [];
  const selectedReady = selected.filter((name) => readyNames.includes(name));
  const canScan = !!status.data?.keyPresent && !status.data.error && !running && !ending;
  const allScanned = locked && live?.databases.every((row) => row.scanStatus === 'completed');
  useLayoutEffect(() => {
    const operation = live?.operation;
    if (
      !historical &&
      operation?.status === 'running' &&
      displayedOperation.current !== operation.id
    ) {
      if (bodyRef.current) bodyRef.current.scrollTop = 0;
      displayedOperation.current = operation.id;
    }
  }, [live?.operation, historical]);

  return (
    <section className="weq-dbm" aria-label="数据库修复">
      <header className="weq-dbm-header">
        <div>
          <h1>
            <Database size={19} aria-hidden />
            数据库修复
          </h1>
          <p>
            {scope.uin}
            {scope.configId ? ` · ${scope.configId}` : ''}
          </p>
        </div>
        {account ? (
          <span className="weq-dbm-account">
            <QqAvatar uin={account.uin} url={account.avatarUrl} size={30} />
            <span>{account.name}</span>
          </span>
        ) : null}
      </header>
      <div className="weq-dbm-body" ref={bodyRef}>
        <div className="weq-dbm-toolbar">
          <button
            type="button"
            className={`weq-set-btn${!locked ? ' weq-set-btn-primary' : ''}`}
            disabled={!canScan || !!allScanned}
            onClick={() => void startScan('scan')}
          >
            <Play size={14} />
            {locked ? (allScanned ? '常规扫描已完成' : '继续扫描') : '开始扫描'}
          </button>
          <button
            type="button"
            className="weq-set-btn"
            disabled={!canScan}
            onClick={() => void startScan('checkup')}
          >
            <Stethoscope size={15} />
            深度体检
          </button>
          {running ? (
            <button
              type="button"
              className="weq-set-btn"
              disabled={stop.isLoading || live?.operation?.stopping || ending}
              onClick={() =>
                void act(async () => {
                  const result = await stop.mutateAsync(scope);
                  if (result) setLive(result);
                  await refresh();
                })
              }
            >
              <Square size={13} />
              {stop.isLoading || live?.operation?.stopping
                ? '正在停止'
                : repairing
                  ? '停止修复'
                  : '停止检查'}
            </button>
          ) : null}
          {locked && !repairing ? (
            <button
              type="button"
              className="weq-set-btn"
              disabled={end.isLoading || ending}
              onClick={() => void endMaintenance()}
            >
              <UnlockKeyhole size={14} />
              结束维护
            </button>
          ) : null}
          {historical ? (
            <button
              type="button"
              className="weq-set-btn"
              onClick={() => {
                setReportId(undefined);
                setReportScope(scope);
                setLegacyId(undefined);
              }}
            >
              <ArrowLeft size={14} />
              返回本次维护
            </button>
          ) : null}
        </div>
        <p className="weq-dbm-notice">
          建议先退出 QQ。
          {locked
            ? '此账号全部目标数据库已锁定；WeQ 仍可只读浏览，写库操作暂停。'
            : live?.state === 'ended'
              ? '本次维护已结束，数据库已解锁。'
              : live?.state === 'locking'
                ? '正在锁定本次数据源的全部目标数据库。'
                : '尚未启动维护，不会自动扫描。'}
        </p>
        {ending ? (
          <p className="weq-dbm-maintained" role="status">
            正在结束维护并释放全部目标数据库的锁
          </p>
        ) : null}
        {locked && !ending && !running && (!progress || historical) ? (
          <p className="weq-dbm-maintained" role="status">
            <LockKeyhole size={15} />
            数据库仍在维护中，等待决定
          </p>
        ) : null}
        {error || live?.maintenanceError || status.error || status.data?.error || report.error ? (
          <p className="weq-dbm-error" role="alert">
            {error ||
              live?.maintenanceError ||
              status.error?.message ||
              status.data?.error ||
              report.error?.message}
          </p>
        ) : null}
        {maintenance.error ? (
          <p className="weq-dbm-error" role="alert">
            无法读取维护状态：{maintenance.error.message}
          </p>
        ) : null}
        {status.data && !status.data.keyPresent && !status.data.error ? (
          <p className="weq-dbm-error" role="status">
            当前数据源尚无可用的解密配置，无法开始加密数据库扫描。
          </p>
        ) : null}
        {!view?.operation && !historical && account?.diagnostic ? (
          <article className="weq-dbm-result">
            <h2>{account.diagnostic.title}</h2>
            <p>{account.diagnostic.message}</p>
            {account.diagnostic.details.map((detail) => (
              <p key={detail}>{detail}</p>
            ))}
            {account.diagnostic.reportPath ? (
              <p>已有报告：{account.diagnostic.reportPath}</p>
            ) : null}
          </article>
        ) : null}

        {legacyId && legacy.data ? (
          <article className="weq-dbm-result">
            <h2>历史修复报告 · {legacy.data.dbName}</h2>
            <p>
              {dateText(legacy.data.at)} · {recordStates[legacy.data.state]}
            </p>
            <p>
              坏页 {legacy.data.badPages.length} · 源库{' '}
              {formatBytesOrUnknown(legacy.data.beforeBytes)} · 产物{' '}
              {formatBytesOrUnknown(legacy.data.afterBytes)}
            </p>
            <p>修复能力：可能支持修复，旧报告没有记录逐项能力判定。</p>
            {legacy.data.error ? <p role="alert">{legacy.data.error}</p> : null}
            <div className="weq-dbm-actions">
              {(['html', 'md', 'json'] as const).map((format) => (
                <button
                  key={format}
                  type="button"
                  className="weq-set-btn"
                  onClick={() =>
                    void act(() =>
                      exportLegacy.mutateAsync({ ...scope, recordId: legacyId, format }),
                    )
                  }
                >
                  <Download size={14} />
                  {format === 'md' ? 'Markdown' : format.toUpperCase()}
                </button>
              ))}
            </div>
          </article>
        ) : (
          <>
            {reportId && view?.operation ? (
              <div className="weq-dbm-report-heading">
                <h2>
                  历史报告 · {view.uin} · {operationLabels[view.operation.kind]}
                </h2>
                <span>{dateText(view.operation.startedAt)}</span>
              </div>
            ) : null}
            <ul className="weq-dbm-databases" aria-label="数据库列表">
              {databases.map((row) => (
                <li
                  key={row.dbName}
                  className="weq-dbm-db"
                  data-current={activeRow?.dbName === row.dbName || undefined}
                >
                  <div className="weq-dbm-db-title">
                    {!historical ? (
                      <input
                        type="checkbox"
                        aria-label={`修复 ${row.dbName}`}
                        disabled={!locked || !databaseReadyForRepair(row) || running || ending}
                        checked={selected.includes(row.dbName)}
                        onChange={(event) => {
                          touched.current.add(row.dbName);
                          setAllowLowSpace(false);
                          setSelected((values) =>
                            event.target.checked
                              ? [...new Set([...values, row.dbName])]
                              : values.filter((name) => name !== row.dbName),
                          );
                        }}
                      />
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setFocused(row.dbName)}
                      aria-pressed={activeRow?.dbName === row.dbName}
                    >
                      {row.dbName}
                    </button>
                  </div>
                  <span>{rowLabel(row)}</span>
                  {databaseMaintenanceRowAbnormal(row) ? (
                    <span className="weq-dbm-abnormal">
                      <AlertTriangle size={13} />
                      {row.issues.filter((issue) => issue.diagnostic !== false).length
                        ? `扫描发现 ${row.issues.filter((issue) => issue.diagnostic !== false).length} 项异常`
                        : '检查已发现异常'}
                    </span>
                  ) : row.support === 'unsupported' ? (
                    <span>不支持修复</span>
                  ) : row.scanStatus === 'completed' ? (
                    <span>
                      <Check size={13} />
                      未检出异常
                    </span>
                  ) : (
                    <span>
                      {row.scanStatus === 'failed'
                        ? '诊断未判定'
                        : row.scanStatus === 'running'
                          ? '尚无诊断结论'
                          : '等待检查'}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {progress ? (
              <DatabaseMaintenanceProgress
                progress={progress}
                batch={
                  view?.operation
                    ? { ...view.operation, locked: !historical && locked && !ending }
                    : undefined
                }
                connectionError={connectionError && running}
              />
            ) : view?.operation ? (
              <div className="weq-dbm-operation" role="status">
                {operationLabels[view.operation.kind]} · {operationStates[view.operation.status]} ·{' '}
                {view.operation.completedDatabases} / {view.operation.totalDatabases} 个数据库
                {view.operation.error ? `；${view.operation.error}` : ''}
              </div>
            ) : status.isLoading ? (
              <p role="status">正在读取数据库列表</p>
            ) : null}
            {activeRow ? <DatabaseResult row={activeRow} /> : null}
            {!historical && locked && !repairing ? (
              <section className="weq-dbm-selection" aria-label="修复选项">
                <div className="weq-dbm-selection-title">
                  <h2>修复对象</h2>
                  <span>
                    已选 {selectedReady.length} 个 · {readyNames.length} 个可修复
                  </span>
                </div>
                {selectedReady.map((name) => (
                  <RepairBudget
                    key={`${name}:${cache.data?.override ?? ''}`}
                    scope={scope}
                    dbName={name}
                    enabled={!running}
                  />
                ))}
                <div className="weq-dbm-options">
                  <label>
                    <input
                      type="checkbox"
                      checked={backup}
                      disabled={running}
                      onChange={(event) => setBackup(event.target.checked)}
                    />
                    修复前保留备份
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={strictPages}
                      disabled={running}
                      onChange={(event) => setStrictPages(event.target.checked)}
                    />
                    严格页模式（丢弃坏页内容）
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={allowLowSpace}
                      disabled={running}
                      onChange={(event) => setAllowLowSpace(event.target.checked)}
                    />
                    接受磁盘建议余量不足
                  </label>
                </div>
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-primary"
                  disabled={running || ending || !selectedReady.length}
                  onClick={() => void startRepair()}
                >
                  <ShieldCheck size={15} />
                  修复所选数据库
                </button>
              </section>
            ) : null}
            {view?.operation && view.operation.status !== 'running' ? (
              <div className="weq-dbm-export">
                <span>导出本次报告</span>
                {(['html', 'md', 'json'] as const).map((format) => (
                  <button
                    key={format}
                    type="button"
                    className="weq-set-btn"
                    disabled={exportReport.isLoading}
                    onClick={() =>
                      void act(() =>
                        exportReport.mutateAsync({
                          ...(reportId ? reportScope : scope),
                          reportId: view.operation!.id,
                          format,
                        }),
                      )
                    }
                  >
                    <Download size={14} />
                    {format === 'md' ? 'Markdown' : format.toUpperCase()}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
        <details className="weq-dbm-history">
          <summary>
            <History size={15} />
            历史报告
            <ChevronRight className="weq-dbm-chevron" size={14} />
          </summary>
          {reports.data?.length || history.data?.length ? null : <p>暂无历史报告</p>}
          {reports.data?.map((item) => (
            <div className="weq-dbm-history-row" key={item.id}>
              <div>
                <strong>{operationLabels[item.operation.kind]}</strong>
                <span>
                  {dateText(item.operation.startedAt)} · {operationStates[item.operation.status]}
                </span>
              </div>
              <button
                type="button"
                className="weq-set-btn"
                onClick={() => {
                  setReportId(item.id);
                  setReportScope(scope);
                  setLegacyId(undefined);
                }}
              >
                <History size={14} />
                查看结果
              </button>
            </div>
          ))}
          {history.data?.map((record) => (
            <div className="weq-dbm-history-row" key={record.id}>
              <div>
                <strong>
                  {record.dbName} · {recordStates[record.state]}
                </strong>
                <span>{dateText(record.at)}</span>
              </div>
              <div className="weq-dbm-actions">
                <button
                  type="button"
                  className="weq-set-btn"
                  onClick={() => {
                    setLegacyId(record.id);
                    setReportId(undefined);
                  }}
                >
                  <History size={14} />
                  查看旧报告
                </button>
                {record.canRestore ? (
                  <button
                    type="button"
                    className="weq-set-btn"
                    disabled={locked || running}
                    onClick={() => void restore(record.id)}
                  >
                    <RotateCcw size={14} />
                    恢复备份
                  </button>
                ) : null}
              </div>
            </div>
          ))}
          {reports.error || history.error ? (
            <p role="alert">历史报告读取失败：{reports.error?.message || history.error?.message}</p>
          ) : null}
        </details>
        <details className="weq-dbm-cache">
          <summary>
            <FolderOpen size={15} />
            重建缓存位置
            <ChevronRight className="weq-dbm-chevron" size={14} />
          </summary>
          <p>{cache.data?.override ?? '默认 WeQ 缓存目录'}</p>
          <div className="weq-dbm-actions">
            <button
              type="button"
              className="weq-set-btn"
              disabled={repairing || pickCache.isLoading}
              onClick={() =>
                void act(async () => {
                  await pickCache.mutateAsync();
                  setAllowLowSpace(false);
                  await cache.refetch();
                  await utils.dbRepair.preflight.invalidate();
                })
              }
            >
              <FolderOpen size={14} />
              更改位置
            </button>
            <button
              type="button"
              className="weq-set-btn"
              disabled={repairing || resetCache.isLoading || !cache.data?.override}
              onClick={() =>
                void act(async () => {
                  await resetCache.mutateAsync();
                  setAllowLowSpace(false);
                  await cache.refetch();
                  await utils.dbRepair.preflight.invalidate();
                })
              }
            >
              <RotateCcw size={14} />
              使用默认位置
            </button>
          </div>
        </details>
      </div>
    </section>
  );
}

function RepairBudget({
  scope,
  dbName,
  enabled,
}: {
  scope: { uin: string; configId?: string };
  dbName: string;
  enabled: boolean;
}) {
  const budget = trpc.dbRepair.preflight.useQuery({ ...scope, dbName }, { enabled, retry: false });
  if (budget.error)
    return (
      <p className="weq-dbm-error">
        {dbName}：{budget.error.message}
      </p>
    );
  if (!budget.data) return null;
  return (
    <div className="weq-dbm-budget">
      <strong>{dbName}</strong>
      {budget.data.space?.map((volume) => (
        <p key={volume.paths.join(':')}>
          {volume.paths.join('、')} · 可用 {formatBytesOrUnknown(volume.freeBytes)} · 预计新增峰值{' '}
          {formatBytesOrUnknown(volume.requiredBytes)} · 建议预留{' '}
          {formatBytesOrUnknown(volume.recommendedBytes)}
        </p>
      ))}
    </div>
  );
}

function DatabaseResult({ row }: { row: DatabaseMaintenanceRow }) {
  return (
    <article className="weq-dbm-result" aria-label={`${row.dbName}检查结果`}>
      <h2>{row.dbName}</h2>
      <p>
        常规扫描：{row.scanStatus === 'completed' ? '执行完成' : (row.scanError ?? rowLabel(row))}
      </p>
      {row.scan?.plaintext ? (
        <p>明文数据库；未执行加密页签名检查，当前不支持重建。</p>
      ) : row.scan ? (
        <p>
          已扫描 {row.scan.pageCount.toLocaleString('zh-CN')} 页 · 坏页{' '}
          {row.scan.badPages.length.toLocaleString('zh-CN')} · 全零页{' '}
          {row.scan.zeroPages.length.toLocaleString('zh-CN')}
        </p>
      ) : null}
      {row.integrity ? (
        <p>
          深度体检：
          {row.deepStatus === 'cancelled'
            ? '已停止'
            : row.deepStatus === 'partial'
              ? '部分完成'
              : row.integrity.ran
                ? '执行完成'
                : '未完成'}{' '}
          · 诊断：
          {row.integrity.ran
            ? row.integrity.healthy
              ? row.integrity.complete === false
                ? '已检查部分正常，仍有未核验项'
                : '结构正常'
              : row.integrity.complete === false
                ? '发现结构异常，另有未核验项'
                : '发现结构异常'
            : row.integrity.corrupt
              ? '发现结构损坏'
              : '尚未判定'}
        </p>
      ) : null}
      {row.integrity?.ran && row.integrity.unverifiedTables?.length ? (
        <p>未核验结构：{row.integrity.unverifiedTables.join('、')}</p>
      ) : null}
      {row.scanStatus === 'completed' || row.support === 'unsupported' ? (
        <p className="weq-dbm-support">{databaseRepairSupportLabel[row.support]}</p>
      ) : null}
      {row.issues.map((issue) => (
        <p key={`${issue.stage ?? 'scan'}:${issue.message}`} className="weq-dbm-issue">
          <span>{issue.message}</span>
          <strong>{databaseRepairSupportLabel[issue.support]}</strong>
        </p>
      ))}
      {row.integrity && !row.integrity.ran ? <p>{row.integrity.error}</p> : null}
      {row.repair ? (
        <p>
          {repairStates[row.repair.status]}
          {row.repair.error ? `：${row.repair.error}` : ''}
        </p>
      ) : null}
      {row.repair?.record?.verification ? (
        <p>
          修复产物复核：
          {row.repair.record.verification.healthy
            ? row.repair.record.verification.complete === false
              ? '已检查部分正常，仍有未核验项'
              : '结构正常'
            : '结构异常'}{' '}
          · 坏页 {row.repair.record.verification.badPages.length}
        </p>
      ) : null}
      {row.repair?.record?.verification?.unverifiedTables?.length ? (
        <p>产物未核验结构：{row.repair.record.verification.unverifiedTables.join('、')}</p>
      ) : null}
    </article>
  );
}
