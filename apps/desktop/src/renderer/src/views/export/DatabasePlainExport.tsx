import { useEffect, useMemo, useRef, useState } from 'react';
import { DatabaseZap, Download, FolderOpen, Loader2 } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';
import { useViewState } from '../../state/view';
import { IS_WEB } from '../../lib/target';
import { DatabasePicker } from './DatabasePicker';
import { Segmented } from './widgets';
import { fmtBytes } from './types';
import '../../styles/database-plain-export.css';
import '../../styles/export.css';

type Receipt = Awaited<ReturnType<typeof client.account.decryptDatabases.mutate>>[number];

export function DatabasePlainExport({ accountUin }: { accountUin: string }) {
  const databases = trpc.account.listDatabases.useQuery(undefined, { refetchOnMount: 'always' });
  const dialog = useAppDialog();
  const [selected, setSelected] = useState(new Set<string>());
  const [mode, setMode] = useState<'safe' | 'fast'>('safe');
  const [directory, setDirectory] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipts, setReceipts] = useState<Receipt[]>([]);
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

  async function run() {
    if (pending.current || !chosen.length || !directory || !current()) return;
    const targets = [...chosen];
    pending.current = true;
    setBusy(true);
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
      setReceipts([]);
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
      setReceipts(result);
      if (result.every((receipt) => receipt.ok)) setSelected(new Set());
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }

  return (
    <div className="weq-database-plain-export">
      <div className="weq-db-plain-picker">
        {databases.isError ? (
          <p role="alert">
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
          disabled={busy}
        />
      </div>
      <div className="weq-db-plain-options">
        <fieldset disabled={busy || picking}>
          <legend>保存位置{IS_WEB ? '（服务端）' : ''}</legend>
          <div className="weq-db-plain-path">
            <code>{directory || '未选择保存位置'}</code>
            <button
              type="button"
              className="icon-button"
              aria-label="选择保存文件夹"
              title="选择保存文件夹"
              onClick={() => void pick()}
            >
              <FolderOpen size={17} />
            </button>
          </div>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>解密方式</legend>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: 'safe', label: '安全保存' },
              { value: 'fast', label: '快速解密' },
            ]}
          />
        </fieldset>
        <div className="weq-db-plain-submit">
          <span>
            {chosen.length} 个数据库 ·{' '}
            {fmtBytes(chosen.reduce((sum, database) => sum + database.bytes, 0))}
          </span>
          <button
            type="button"
            className="weq-action-primary"
            disabled={busy || picking || !directory || !chosen.length}
            onClick={() => void run()}
          >
            {busy ? <Loader2 size={16} className="spin" /> : <DatabaseZap size={16} />}
            {busy ? '正在解密' : '开始解密'}
          </button>
        </div>
        {error ? <p role="alert">{error}</p> : null}
        {receipts.length ? (
          <div className="weq-db-plain-results" role="status">
            <strong>
              成功 {receipts.filter((receipt) => receipt.ok).length}，失败{' '}
              {receipts.filter((receipt) => !receipt.ok).length}
            </strong>
            <ul>
              {receipts.map((receipt) => (
                <li key={receipt.dbPath}>
                  <strong>{receipt.name}</strong>
                  <span>{receipt.ok ? receipt.outPath : receipt.error}</span>
                  {receipt.ok && receipt.downloadUrl ? (
                    <a
                      href={receipt.downloadUrl}
                      download={receipt.name}
                      title="下载明文数据库"
                      aria-label={`下载 ${receipt.name}`}
                    >
                      <Download size={16} />
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
