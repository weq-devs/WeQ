/**
 * 下载文件 browser — files recorded in `file_assistant.db` (文件助手). Same
 * category / search / sort toolbar as the File 目录 view, but each row's
 * on-disk existence is probed per page: QQ may have downloaded a file to the
 * user's own directory and it can later be moved or deleted, so cards carry a
 * 「存在 / 已删除」 badge. Existing files can be located / opened; missing ones
 * are dimmed. Rendered as a list (paths matter here more than thumbnails).
 */

import { useState, type ReactElement } from 'react';
import { FolderOpen, ExternalLink, CheckCircle2, XCircle } from 'lucide-react';
import type { DownloadFileEntry } from '@weq/service';
import { client } from '../../trpc/client';
import { fileIconUrl } from '../../lib/resourceUrl';
import {
  FileResourceToolbar,
  ListFooter,
  usePagedList,
  fmtBytes,
  fmtDate,
  cn,
  type ToolbarState,
} from './FileResourceShared';

export function DownloadFileExplorer(): ReactElement {
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [state, setState] = useState<ToolbarState>({
    category: 'all',
    search: '',
    sort: 'time',
    order: 'desc',
  });
  const onChange = (next: Partial<ToolbarState>): void => setState((s) => ({ ...s, ...next }));

  const list = usePagedList<DownloadFileEntry>(
    (offset, limit) =>
      client.account.fileResource.download.list.query({
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
      setRefreshKey((k) => k + 1);
    } finally {
      setRefreshing(false);
    }
  };

  // The db snapshot is the source of counts; we don't have a cheap per-category
  // summary here, so the tabs show the current total and 全部 only. Passing
  // `null` counts hides the per-category badges (still lets 全部 through).
  return (
    <div className="weq-filebrowser">
      <FileResourceToolbar
        state={state}
        onChange={onChange}
        counts={null}
        total={list.total}
        onRefresh={() => void onRefresh()}
        refreshing={refreshing}
      />

      <div className="weq-filebrowser-scroll">
        {list.error && list.entries.length === 0 ? (
          <div className="weq-cache-grid-state is-error">{list.error}</div>
        ) : (
          <>
            <div className="weq-filebrowser-list">
              {list.entries.map((e) => (
                <DownloadRow key={`${e.msgId}:${e.localPath}:${e.fileName}`} entry={e} />
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
              <div className="weq-cache-grid-state">读取文件助手记录中…</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** One db-recorded file row: icon/preview + name + size/date/path + existence badge. */
function DownloadRow({ entry }: { entry: DownloadFileEntry }): ReactElement {
  const [msg, setMsg] = useState<string | null>(null);

  const reveal = (): void => {
    if (!entry.exists) return;
    void client.account.fileResource.download.reveal
      .mutate({ path: entry.localPath })
      .then((r) => {
        if (!r.ok) setMsg(r.error ?? '定位失败');
      })
      .catch((e) => setMsg(e instanceof Error ? e.message : String(e)));
  };
  const open = (ev: React.MouseEvent): void => {
    ev.stopPropagation();
    if (!entry.exists) return;
    void client.account.fileResource.download.open
      .mutate({ path: entry.localPath })
      .then((r) => {
        if (!r.ok) setMsg(r.error ?? '打开失败');
      })
      .catch((e) => setMsg(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div
      className={cn('weq-filerow', !entry.exists && 'is-gone')}
      role={entry.exists ? 'button' : undefined}
      title={entry.exists ? `${entry.localPath}\n点击在文件夹中定位` : '文件已不在原位置'}
      onClick={entry.exists ? reveal : undefined}
    >
      <div className="weq-filerow-thumb">
        <img className="weq-filerow-icon" src={fileIconUrl(entry.icon)} alt="" draggable={false} />
      </div>

      <div className="weq-filerow-meta">
        <div className="weq-filerow-name" title={entry.fileName}>
          {entry.fileName || '[文件]'}
        </div>
        <div className={cn('weq-filerow-sub', msg && 'is-error')}>
          {msg
            ? msg
            : `${fmtBytes(entry.fileSize)} · ${fmtDate(entry.timestamp)}${
                entry.localPath ? ` · ${entry.localPath}` : ''
              }`}
        </div>
      </div>

      <span className={cn('weq-filerow-badge', entry.exists ? 'is-ok' : 'is-gone')}>
        {entry.exists ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
        {entry.exists ? '存在' : '已删除'}
      </span>

      {entry.exists ? (
        <div className="weq-filerow-actions">
          <button type="button" title="在文件夹中定位" onClick={(e) => { e.stopPropagation(); reveal(); }}>
            <FolderOpen size={14} />
          </button>
          <button type="button" title="打开文件" onClick={open}>
            <ExternalLink size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
