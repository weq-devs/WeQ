import { useEffect, useMemo, useRef, useState } from 'react';
import { DatabaseZap, Download, FolderOpen, Loader2, ShieldCheck, Zap } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';
import { useViewState } from '../../state/view';
import { IS_WEB } from '../../lib/target';
import { DatabasePicker } from './DatabasePicker';
import { fmtBytes } from './types';
import '../../styles/database-plain-export.css';
import '../../styles/export.css';

type Receipt = Awaited<ReturnType<typeof client.account.decryptDatabases.mutate>>[number];
type Mode = 'safe' | 'fast';

export function DatabasePlainExport({ accountUin }: { accountUin: string }) {
  const databases = trpc.account.listDatabases.useQuery(undefined, { refetchOnMount: 'always' });
  const dialog = useAppDialog();
  const [selected, setSelected] = useState(new Set<string>());
  const [directory, setDirectory] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<Mode | null>(null);
  const [error, setError] = useState('');
  const active = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const current = () => active.current && useViewState.getState().openedUin === accountUin;
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

  async function pick() {
    setPicking(true);
    setError('');
    try {
      const path = await client.account.pickDecryptOutputDir.mutate();
      if (current() && path) setDirectory(path);
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current()) setPicking(false);
    }
  }

  function showReceipts(result: Receipt[]) {
    const ok = result.filter((receipt) => receipt.ok).length;
    dialog.info(
      `解密完成 · 成功 ${ok} / ${result.length}`,
      <div className="weq-db-receipts">
        <ul>
          {result.map((receipt) => (
            <li key={receipt.dbPath} className={receipt.ok ? 'is-ok' : 'is-fail'}>
              <strong>{receipt.name}</strong>
              <span>{receipt.ok ? receipt.outPath : receipt.error}</span>
              {receipt.ok && receipt.downloadUrl ? (
                <a
                  href={receipt.downloadUrl}
                  download={receipt.name}
                  title="下载明文数据库"
                  aria-label={`下载 ${receipt.name}`}
                >
                  <Download size={15} />
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      </div>,
    );
  }

  async function run(mode: Mode) {
    if (pending.current || !chosen.length || !directory || !current()) return;
    const targets = [...chosen];
    pending.current = true;
    setBusy(mode);
    setError('');
    try {
      if (mode === 'fast' && (await client.account.isQqLoggedIn.query())) {
        const confirmed = await dialog.confirm(
          '快速解密风险',
          '检测到当前 QQ 账号仍处于登录状态。快速解密可能导致导出的数据库损坏；安全保存更适合 QQ 在线时使用。是否仍继续快速解密？',
          { okLabel: '继续快速解密', cancelLabel: '返回修改', tone: 'warning' },
        );
        if (!confirmed) return;
      }
      if (!current()) return;
      const stamp = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
        .format(new Date())
        .replace(/[-: ]/g, '');
      const outputDir = `${directory.replace(/[\\/]+$/, '')}/数据库明文_${stamp}_${crypto.randomUUID().slice(0, 8)}`;
      const names = new Set<string>();
      const result = await client.account.decryptDatabases.mutate({
        expectedAccountUin: accountUin,
        mode,
        outputDir,
        concurrency: 3,
        items: targets.map((database, index) => {
          const name = names.has(database.name.toLocaleLowerCase())
            ? `${index + 1}-${database.name}`
            : database.name;
          names.add(name.toLocaleLowerCase());
          return { dbPath: database.path, name };
        }),
      });
      if (!current()) return;
      if (result.every((receipt) => receipt.ok)) setSelected(new Set());
      showReceipts(result);
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      if (current()) setBusy(null);
    }
  }

  const totalBytes = chosen.reduce((sum, database) => sum + database.bytes, 0);
  const ready = Boolean(directory) && chosen.length > 0 && !busy && !picking;

  return (
    <div className="weq-database-plain-export">
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
        <div className="weq-db-actionbar-target">
          <FolderOpen size={15} aria-hidden />
          <span className="weq-db-actionbar-label">保存位置{IS_WEB ? '（服务端）' : ''}</span>
          <code title={directory ?? undefined}>{directory || '未选择保存位置'}</code>
          <button
            type="button"
            className="weq-db-actionbar-pick"
            aria-label="选择保存文件夹"
            title="选择保存文件夹"
            disabled={Boolean(busy) || picking}
            onClick={() => void pick()}
          >
            {picking ? <Loader2 size={15} className="weq-exp-spin" /> : '选择…'}
          </button>
        </div>
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
