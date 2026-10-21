import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Check, Image, Loader2, X } from 'lucide-react';
import type { ExportSavePolicy } from '@weq/service';
import { ExportSaveActions } from '../../components/ExportSaveActions';
import '../../styles/resource-export.css';
import { closeFromScrim, useEscapeToClose } from '../../im-template/template/modalUtils';
import { client } from '../../trpc/client';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import type { GroupAlbumWire } from '../../components/GroupAlbumDialog';
import { ShimmerImage } from '../../components/ShimmerImage';

export interface AlbumExportResult {
  selectedAlbums: GroupAlbumWire[];
  saveIntent?: ExportSavePolicy;
}

export function AlbumExportLightbox({
  groupCode,
  groupName,
  submitting,
  onClose,
  onConfirm,
}: {
  groupCode: string;
  groupName: string;
  submitting?: boolean;
  onClose: () => void;
  onConfirm: (result: AlbumExportResult) => void;
}): ReactElement {
  useEscapeToClose(onClose);
  const [albums, setAlbums] = useState<GroupAlbumWire[]>([]);
  const [loadingAlbums, setLoadingAlbums] = useState(true);
  const [albumError, setAlbumError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const selectedAlbums = useMemo(
    () => albums.filter((album) => selection.has(album.id)),
    [albums, selection],
  );

  useEffect(() => {
    let cancelled = false;
    setLoadingAlbums(true);
    setAlbumError(null);
    setAlbums([]);
    setSelection(new Set());

    client.account.listGroupAlbums
      .query({ groupCode })
      .then((page) => {
        if (cancelled) return;
        const nextAlbums = page as GroupAlbumWire[];
        setAlbums(nextAlbums);
        setSelection(new Set(nextAlbums.map((album) => album.id)));
      })
      .catch((e) => {
        if (cancelled) return;
        setAlbumError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingAlbums(false);
      });

    return () => {
      cancelled = true;
    };
  }, [groupCode]);

  const multi = useMultiSelection({
    ids: albums.map((album) => album.id),
    selected: selection,
    onChange: setSelection,
    disabled: submitting,
  });

  return (
    <div
      className="modal-scrim weq-exp-modal-scrim weq-resource-export-scrim"
      role="presentation"
      onMouseDown={closeFromScrim(onClose)}
    >
      <section
        className="weq-exp-dialog weq-exp-album-dialog weq-resource-export-dialog"
        {...multi.rootProps}
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="weq-exp-dialog-head">
          <div className="weq-exp-dialog-title">
            <strong>导出群相册</strong>
            <span title={groupName}>{groupName}</span>
          </div>
          <button type="button" className="weq-exp-dialog-close" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="weq-exp-dialog-body">
          <section className="weq-exp-album-tools">
            <button
              type="button"
              className="weq-exp-tool"
              disabled={loadingAlbums || albums.length === 0 || submitting}
              onClick={() => setSelection(new Set(albums.map((album) => album.id)))}
            >
              全选
            </button>
            <button
              type="button"
              className="weq-exp-tool"
              disabled={loadingAlbums || albums.length === 0 || submitting}
              onClick={() =>
                setSelection(
                  (current) =>
                    new Set(
                      albums.filter((album) => !current.has(album.id)).map((album) => album.id),
                    ),
                )
              }
            >
              反选
            </button>
            <span className="weq-exp-tools-spacer" />
            <span className="weq-exp-tools-count">已选 {selection.size}</span>
          </section>

          <div className="weq-exp-album-list">
            {loadingAlbums ? (
              <div className="weq-exp-list-state">
                <Loader2 size={18} className="weq-exp-spin" />
                <span>正在查询群相册列表喵~</span>
              </div>
            ) : albumError ? (
              <div className="weq-exp-list-state is-error">{albumError}</div>
            ) : albums.length === 0 ? (
              <div className="weq-exp-list-state">这个群暂无相册</div>
            ) : (
              albums.map((album) => (
                <button
                  key={album.id}
                  type="button"
                  className={`weq-exp-album-row${selection.has(album.id) ? ' is-on' : ''}`}
                  disabled={submitting}
                  {...multi.itemProps(album.id, submitting)}
                >
                  <AlbumCover album={album} />
                  <span className="weq-exp-row-meta">
                    <strong>{album.title || '未命名相册'}</strong>
                    <small>{album.photoCount ?? 0} 张</small>
                  </span>
                  <span className="weq-exp-row-check">
                    {selection.has(album.id) ? <Check size={14} /> : null}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>

        <footer className="weq-exp-dialog-foot">
          <button type="button" className="weq-exp-btn" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="button"
            className="weq-exp-btn is-primary"
            disabled={
              submitting || loadingAlbums || Boolean(albumError) || selectedAlbums.length === 0
            }
            onClick={() => onConfirm({ selectedAlbums })}
          >
            {submitting ? <Loader2 size={15} className="weq-exp-spin" /> : null}
            开始导出
          </button>
          <ExportSaveActions
            disabled={
              submitting || loadingAlbums || Boolean(albumError) || selectedAlbums.length === 0
            }
            onSelect={(saveIntent) => onConfirm({ selectedAlbums, saveIntent })}
          />
        </footer>
      </section>
    </div>
  );
}

function AlbumCover({ album }: { album: GroupAlbumWire }): ReactElement {
  const [broken, setBroken] = useState(false);
  if (!album.coverUrl || broken) {
    return (
      <span className="weq-exp-album-cover is-empty">
        <Image size={18} />
      </span>
    );
  }
  return (
    <span className="weq-exp-album-cover">
      <ShimmerImage
        src={album.coverUrl}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    </span>
  );
}
