import { useEffect, useMemo, useRef, useState } from 'react';
import { DatabaseZap, Loader2, ShieldCheck, Zap } from 'lucide-react';
import type { ExportSavePolicy } from '@weq/service';
import { client, trpc } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';
import { useExportReportDialog } from './ExportReportControl';
import { useViewState } from '../../state/view';
import { useExportSavePolicy } from '../../hooks/useExportSavePolicy';
import { ServerSavePrompt } from '../../components/ServerSavePrompt';
import { DatabasePicker } from './DatabasePicker';
import { fmtBytes } from './types';
import '../../styles/database-plain-export.css';
import '../../styles/export.css';
import { useTabActive } from '../../components/RetainedTabs';
import {
  databaseExportTargetMatches,
  type DatabaseExportTarget,
} from '../../../../shared/database_export_target';

type Mode = 'safe' | 'fast';

export function DatabasePlainExport({
  accountUin,
  onStarted,
  target,
}: {
  accountUin: string;
  onStarted?: () => void;
  target?: DatabaseExportTarget;
}) {
  const tabActive = useTabActive();
  const tabActiveRef = useRef(tabActive);
  tabActiveRef.current = tabActive;
  const dialog = useAppDialog();
  const report = useExportReportDialog();
  const [selected, setSelected] = useState(new Set<string>());
  const [busy, setBusy] = useState<Mode | null>(null);
  const [error, setError] = useState('');
  const active = useRef(true);
  const pending = useRef(false);
  const refreshOnResume = useRef(false);
  const { binding, prepareSave, isCurrent, serverLocation, chooseServerLocation } =
    useExportSavePolicy();
  const matchesSource = !target || databaseExportTargetMatches(target, binding);
  const databases = trpc.account.listDatabases.useQuery(undefined, {
    enabled: tabActive && matchesSource,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  const appliedTarget = useRef<DatabaseExportTarget | null>(null);
  useEffect(() => {
    appliedTarget.current = null;
    refreshOnResume.current = false;
    setSelected(new Set());
    setError('');
    setBusy(null);
  }, [binding?.expectedAccountUin, binding?.expectedAccountConfigId]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const sameSource = () =>
    active.current &&
    useViewState.getState().openedUin === accountUin &&
    binding?.expectedAccountUin === accountUin &&
    matchesSource &&
    isCurrent();
  const current = () => tabActiveRef.current && sameSource();
  useEffect(() => {
    if (!tabActive || !refreshOnResume.current) return;
    refreshOnResume.current = false;
    if (
      active.current &&
      matchesSource &&
      useViewState.getState().openedUin === accountUin &&
      isCurrent()
    )
      onStarted?.();
  }, [tabActive, matchesSource, accountUin, isCurrent, onStarted]);
  const items = useMemo(
    () =>
      (databases.data ?? []).map((database) => ({
        name: database.name,
        path: database.path,
        bytes: Number(database.bytes ?? 0),
        kind: database.kind,
      })),
    [databases.data],
  );
  const chosen = items.filter((item) => selected.has(item.path));
  useEffect(() => {
    if (!target || !matchesSource || !databases.data || appliedTarget.current === target) return;
    appliedTarget.current = target;
    setSelected(new Set(target.dbPaths.filter((path) => items.some((item) => item.path === path))));
  }, [target, matchesSource, databases.data, items]);
  const missingTargets =
    target && databases.data && matchesSource
      ? target.dbPaths.filter((path) => !items.some((item) => item.path === path))
      : [];

  async function run(mode: Mode, intent?: ExportSavePolicy) {
    if (
      pending.current ||
      !chosen.length ||
      !binding ||
      !current() ||
      databases.isError ||
      databases.isLoading ||
      databases.isFetching
    )
      return;
    const targets = chosen.map((item) => ({ ...item }));
    const expected = { ...binding };
    pending.current = true;
    setBusy(mode);
    setError('');
    try {
      if (mode === 'fast' && (await client.account.isQqLoggedIn.query(expected))) {
        if (!current()) return;
        const confirmed = await dialog.confirm(
          '快速解密风险',
          '检测到当前 QQ 账号仍处于登录状态。快速解密可能导致导出的数据库损坏；安全保存更适合 QQ 在线时使用。是否仍继续快速解密？',
          { okLabel: '继续快速解密', cancelLabel: '返回修改', tone: 'warning' },
        );
        if (!confirmed) return;
      }
      if (!current()) return;
      const name = targets.length === 1 ? targets[0]!.name.replace(/\.db$/i, '') : '数据库明文';
      const includeIntegrityReport = targets.length > 1 ? await report.choose() : false;
      if (includeIntegrityReport === null || !current()) return;
      const savePolicy = await prepareSave(
        intent,
        targets.length === 1 ? { kind: 'file', name, format: 'db' } : { kind: 'bundle', name },
      );
      if (!savePolicy || !current()) return;
      await client.account.startDatabasePlainExport.mutate({
        ...expected,
        mode,
        savePolicy,
        dbPaths: targets.map((item) => item.path),
        includeIntegrityReport,
      });
      if (!sameSource()) return;
      setSelected(new Set());
      if (tabActiveRef.current) onStarted?.();
      else refreshOnResume.current = true;
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      if (sameSource()) setBusy(null);
    }
  }

  const totalBytes = chosen.reduce((sum, database) => sum + database.bytes, 0);
  const ready =
    Boolean(binding) &&
    matchesSource &&
    tabActive &&
    chosen.length > 0 &&
    !busy &&
    !databases.isError &&
    !databases.isLoading &&
    !databases.isFetching;

  return (
    <div className="weq-database-plain-export">
      {report.dialog}
      {!matchesSource ? (
        <p className="weq-db-cards-error" role="alert">
          数据库导出来源已变化，请从当前数据库管理页重新打开。
        </p>
      ) : missingTargets.length > 0 ? (
        <p className="weq-db-cards-error" role="alert">
          原选数据库在当前来源中已不存在，请重新选择，不会自动改为全部数据库。
        </p>
      ) : null}
      {serverLocation && (
        <ServerSavePrompt name={serverLocation.name} onChoose={chooseServerLocation} />
      )}
      {databases.isError ? (
        <p className="weq-db-cards-error" role="alert">
          {databases.error.message}
          <button type="button" onClick={() => void databases.refetch()}>
            重试
          </button>
        </p>
      ) : null}

      <DatabasePicker
        items={items}
        loading={databases.isLoading}
        selected={selected}
        onChange={(next) => {
          if (!busy) setSelected(next);
        }}
        disabled={Boolean(busy) || !matchesSource || !tabActive}
      />

      <div className="weq-db-actionbar">
        <div className="weq-db-actionbar-summary">
          {chosen.length ? (
            <span>
              {chosen.length} 个数据库 · {fmtBytes(totalBytes)}
            </span>
          ) : (
            <span>先选中要解密的数据库</span>
          )}
        </div>
        <div className="weq-db-actionbar-buttons">
          <div className="weq-db-export-group">
            <button
              type="button"
              className="weq-db-export is-safe"
              disabled={!ready}
              title="QQ 在线时更稳妥：先让数据库处于一致状态再解密"
              onClick={() => void run('safe')}
            >
              {busy === 'safe' ? (
                <Loader2 size={16} className="weq-exp-spin" />
              ) : (
                <ShieldCheck size={16} />
              )}
              {busy === 'safe' ? '正在安全保存' : '安全保存'}
            </button>
          </div>
          <div className="weq-db-export-group">
            <button
              type="button"
              className="weq-db-export is-fast"
              disabled={!ready}
              title="直接解密，速度更快；QQ 在线时可能损坏导出的库"
              onClick={() => void run('fast')}
            >
              {busy === 'fast' ? <Loader2 size={16} className="weq-exp-spin" /> : <Zap size={16} />}
              {busy === 'fast' ? '正在快速解密' : '快速解密'}
            </button>
          </div>
        </div>
        {error ? (
          <p className="weq-db-cards-error" role="alert">
            <DatabaseZap size={14} />
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
