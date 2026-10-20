import { useEffect, useMemo, useRef, useState } from 'react';
import { DatabaseZap, Loader2, ShieldCheck, Zap } from 'lucide-react';
import type { ExportSavePolicy } from '@weq/service';
import { client, trpc } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';
import { useViewState } from '../../state/view';
import { useExportSavePolicy } from '../../hooks/useExportSavePolicy';
import { ExportSaveActions } from '../../components/ExportSaveActions';
import { ServerSavePrompt } from '../../components/ServerSavePrompt';
import { DatabasePicker } from './DatabasePicker';
import { fmtBytes } from './types';
import '../../styles/database-plain-export.css';
import '../../styles/export.css';

type Mode = 'safe' | 'fast';

export function DatabasePlainExport({
  accountUin,
  onStarted,
}: {
  accountUin: string;
  onStarted?: () => void;
}) {
  const databases = trpc.account.listDatabases.useQuery(undefined, { refetchOnMount: 'always' });
  const dialog = useAppDialog();
  const [selected, setSelected] = useState(new Set<string>());
  const [busy, setBusy] = useState<Mode | null>(null);
  const [error, setError] = useState('');
  const active = useRef(true);
  const pending = useRef(false);
  const { binding, prepareSave, isCurrent, serverLocation, chooseServerLocation } =
    useExportSavePolicy();
  useEffect(() => {
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
  const current = () =>
    active.current &&
    useViewState.getState().openedUin === accountUin &&
    binding?.expectedAccountUin === accountUin &&
    isCurrent();
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

  async function run(mode: Mode, intent?: ExportSavePolicy) {
    if (pending.current || !chosen.length || !binding || !current()) return;
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
      });
      if (!current()) return;
      setSelected(new Set());
      onStarted?.();
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      if (current()) setBusy(null);
    }
  }

  const totalBytes = chosen.reduce((sum, database) => sum + database.bytes, 0);
  const ready = Boolean(binding) && chosen.length > 0 && !busy;

  return (
    <div className="weq-database-plain-export">
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
        disabled={Boolean(busy)}
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
            <ExportSaveActions
              label="安全保存的本次保存选项"
              disabled={!ready}
              onSelect={(intent) => void run('safe', intent)}
            />
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
            <ExportSaveActions
              label="快速解密的本次保存选项"
              disabled={!ready}
              onSelect={(intent) => void run('fast', intent)}
            />
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
