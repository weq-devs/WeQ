// @ts-nocheck
import { useMemo, useState, type ReactElement } from 'react';
import { Check, FolderOpen, Image, Loader2, X } from 'lucide-react';
import { closeFromScrim, useEscapeToClose } from '../../im-template/template/modalUtils';
import type { GroupAlbumWire } from '../../components/GroupAlbumDialog';

export interface AlbumExportResult {
  outputDir: string;
  selectedAlbums: GroupAlbumWire[];
}

export function AlbumExportLightbox({
  groupName,
  albums,
  outputDir,
  submitting,
  onPickPath,
  onClose,
  onConfirm,
}: {
  groupName: string;
  albums: GroupAlbumWire[];
  outputDir: string | null;
  submitting?: boolean;
  onPickPath: () => Promise<string | null>;
  onClose: () => void;
  onConfirm: (result: AlbumExportResult) => void;
}): ReactElement {
  useEscapeToClose(onClose);
  const [selection, setSelection] = useState<Set<string>>(() => new Set(albums.map((album) => album.id)));
  const [picking, setPicking] = useState(false);
  const selectedAlbums = useMemo(() => albums.filter((album) => selection.has(album.id)), [albums, selection]);

  function toggle(id: string): void {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function pickPath(): Promise<void> {
    setPicking(true);
    try {
      await onPickPath();
    } finally {
      setPicking(false);
    }
  }

  return (
    <div className="modal-scrim weq-exp-modal-scrim" role="presentation" onMouseDown={closeFromScrim(onClose)}>
      <section className="weq-exp-dialog weq-exp-album-dialog" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
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
          <section className="weq-exp-album-path">
            <span className="weq-exp-path" title={outputDir ?? undefined}>
              <FolderOpen size={14} aria-hidden />
              <span className="weq-exp-path-txt">{outputDir ?? '未选择保存目录'}</span>
            </span>
            <button type="button" className="weq-exp-btn" disabled={picking || submitting} onClick={() => void pickPath()}>
              {picking ? <Loader2 size={14} className="weq-exp-spin" /> : <FolderOpen size={14} />}
              选择目录
            </button>
          </section>

          <section className="weq-exp-album-tools">
            <button type="button" className="weq-exp-tool" disabled={albums.length === 0 || submitting} onClick={() => setSelection(new Set(albums.map((album) => album.id)))}>
              全选
            </button>
            <button
              type="button"
              className="weq-exp-tool"
              disabled={albums.length === 0 || submitting}
              onClick={() =>
                setSelection((current) => new Set(albums.filter((album) => !current.has(album.id)).map((album) => album.id)))
              }
            >
              反选
            </button>
            <span className="weq-exp-tools-spacer" />
            <span className="weq-exp-tools-count">已选 {selection.size}</span>
          </section>

          <div className="weq-exp-album-list">
            {albums.length === 0 ? (
              <div className="weq-exp-list-state">这个群暂无相册</div>
            ) : (
              albums.map((album) => (
                <button
                  key={album.id}
                  type="button"
                  className={`weq-exp-album-row${selection.has(album.id) ? ' is-on' : ''}`}
                  disabled={submitting}
                  onClick={() => toggle(album.id)}
                >
                  <AlbumCover album={album} />
                  <span className="weq-exp-row-meta">
                    <strong>{album.title || '未命名相册'}</strong>
                    <small>{album.photoCount ?? 0} 张</small>
                  </span>
                  <span className="weq-exp-row-check">{selection.has(album.id) ? <Check size={14} /> : null}</span>
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
            disabled={submitting || !outputDir || selectedAlbums.length === 0}
            onClick={() => outputDir && onConfirm({ outputDir, selectedAlbums })}
          >
            {submitting ? <Loader2 size={15} className="weq-exp-spin" /> : null}
            开始导出
          </button>
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
      <img src={album.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
    </span>
  );
}
