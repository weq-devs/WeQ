/**
 * File 目录 browser — the recursive `nt_data/File/Ori` walk (chat files on
 * disk). Category tabs + name search + time/name/size sorting drive an
 * offset-paged, infinite-scroll grid of cards; the backend scans once into a
 * cached snapshot so filtering/sorting never re-hits the disk. Image files get
 * an inline preview (`weq-media://localfile`); everything else shows the same
 * extension icon the chat uses. Clicking a card reveals it in the OS file
 * manager; the 打开 button opens it with the default app.
 */

import { useMemo, useState, type ReactElement } from 'react';
import { FolderOpen, ExternalLink, AlertTriangle } from 'lucide-react';
import type { FileResourceEntry } from '@weq/service';
import { trpc, client } from '../../trpc/client';
import { fileIconUrl, localFileUrl } from '../../lib/resourceUrl';
import {
  FileResourceToolbar,
  ListFooter,
  usePagedList,
  fmtBytes,
  fmtDate,
  isImageCategory,
  cn,
  type ToolbarState,
} from './FileResourceShared';

export function FileDirExplorer(): ReactElement {
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const summary = trpc.account.fileResource.fileDir.summary.useQuery(
    { refresh: false },
    { refetchOnWindowFocus: false },
  );

  const [state, setState] = useState<ToolbarState>({
    category: 'all',
    search: '',
    sort: 'time',
    order: 'desc',
  });
  const onChange = (next: Partial<ToolbarState>): void => setState((s) => ({ ...s, ...next }));

  const list = usePagedList<FileResourceEntry>(
    (offset, limit) =>
      client.account.fileResource.fileDir.list.query({
        category: state.category,
        search: state.search,
        sort: state.sort,
        order: state.order,
        offset,
        limit,
      }),
    [state.category, state.search, state.sort, state.order, refreshKey],
  );

  const onRefresh = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await client.account.fileResource.refresh.mutate();
      await summary.refetch();
      setRefreshKey((k) => k + 1);
    } finally {
      setRefreshing(false);
    }
  };

  const counts = summary.data?.byCategory ?? null;
  const total = summary.data?.total ?? 0;
  const present = summary.data?.present ?? true;

  if (!summary.isLoading && !present) {
    return (
      <div className="weq-cache-grid-state">
        未找到该账号的 File 目录（nt_data/File/Ori）
      </div>
    );
  }

  return (
    <div className="weq-filebrowser">
      <FileResourceToolbar
        state={state}
        onChange={onChange}
        counts={counts}
        total={total}
        onRefresh={() => void onRefresh()}
        refreshing={refreshing || summary.isFetching}
      />

      {summary.data?.truncated ? (
        <div className="weq-filebrowser-warn">
          <AlertTriangle size={13} /> 文件过多，仅加载了前 {total} 个
        </div>
      ) : null}

      <div className="weq-filebrowser-scroll">
        {list.error && list.entries.length === 0 ? (
          <div className="weq-cache-grid-state is-error">{list.error}</div>
        ) : (
          <>
            <div className="weq-filebrowser-grid">
              {list.entries.map((e) => (
                <FileCard key={e.relPath} entry={e} />
              ))}
            </div>
            {list.entries.length > 0 || list.done ? (
              <ListFooter
                loading={list.loading}
                done={list.done}
                count={list.entries.length}
                sentinelRef={list.sentinelRef}
              />
            ) : (
              <div className="weq-cache-grid-state">扫描 File 目录中…</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** One file card: image preview or extension icon + name + size + date. */
function FileCard({ entry }: { entry: FileResourceEntry }): ReactElement {
  const showPreview = useMemo(() => isImageCategory(entry.category), [entry.category]);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const reveal = (): void => {
    void client.account.fileResource.fileDir.reveal
      .mutate({ path: entry.absPath })
      .then((r) => {
        if (!r.ok) setMsg(r.error ?? '定位失败');
      })
      .catch((e) => setMsg(e instanceof Error ? e.message : String(e)));
  };
  const open = (ev: React.MouseEvent): void => {
    ev.stopPropagation();
    void client.account.fileResource.fileDir.open
      .mutate({ path: entry.absPath })
      .then((r) => {
        if (!r.ok) setMsg(r.error ?? '打开失败');
      })
      .catch((e) => setMsg(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div
      className="weq-filecard"
      role="button"
      title={msg ?? `${entry.name}\n${entry.relPath}\n点击在文件夹中定位`}
      onClick={reveal}
    >
      <div className="weq-filecard-thumb">
        {showPreview && !previewFailed ? (
          <img
            src={localFileUrl(entry.absPath)}
            alt={entry.name}
            loading="lazy"
            onError={() => setPreviewFailed(true)}
          />
        ) : (
          <img
            className="weq-filecard-icon"
            src={fileIconUrl(entry.icon)}
            alt=""
            draggable={false}
          />
        )}
        <span className="weq-filecard-ext">{entry.ext ? entry.ext.toUpperCase() : '—'}</span>
      </div>
      <div className="weq-filecard-meta">
        <div className="weq-filecard-name" title={entry.name}>
          {entry.name}
        </div>
        <div className={cn('weq-filecard-sub', msg && 'is-error')}>
          {msg ? msg : `${fmtBytes(entry.size)} · ${fmtDate(entry.mtimeMs)}`}
        </div>
      </div>
      <div className="weq-filecard-actions">
        <button type="button" title="在文件夹中定位" onClick={(e) => { e.stopPropagation(); reveal(); }}>
          <FolderOpen size={14} />
        </button>
        <button type="button" title="打开文件" onClick={open}>
          <ExternalLink size={14} />
        </button>
      </div>
    </div>
  );
}
