import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft,
  ChevronRight,
  Images,
  Loader2,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useOverlayLayer } from '../lib/overlayStack';
import { QzoneAlbumNavigationContext } from '../lib/qzoneNavigation';
import { useZoomPan } from './useZoomPan';
import '../styles/qzone-preview.css';

export interface PreviewAlbum {
  hostUin: string;
  topicId: string;
  name: string;
}

export interface QzonePreviewMedia {
  key: string;
  kind: 'image' | 'video';
  src: string;
  poster?: string;
  title?: string;
  load?: () => Promise<{ src: string; kind: 'image' | 'video' }>;
}

export function QzoneMediaPreview({
  items,
  initialIndex,
  album: knownAlbum,
  resolveAlbum,
  onClose,
  onAlbum,
}: {
  items: QzonePreviewMedia[];
  initialIndex: number;
  album?: PreviewAlbum;
  resolveAlbum?: () => Promise<PreviewAlbum | null>;
  onClose: () => void;
  onAlbum?: (album: PreviewAlbum) => void;
}) {
  const [index, setIndex] = useState(initialIndex);
  const item = items[index];
  const [resolved, setResolved] = useState<{
    key: string;
    src: string;
    kind: 'image' | 'video';
  } | null>(null);
  const [error, setError] = useState('');
  const [album, setAlbum] = useState(knownAlbum ?? null);
  const [albumState, setAlbumState] = useState(resolveAlbum && !knownAlbum ? 'loading' : 'ready');
  const [albumRetry, setAlbumRetry] = useState(0);
  const navigate = useContext(QzoneAlbumNavigationContext);
  const root = useRef<HTMLDivElement>(null);
  const layer = useOverlayLayer(true);
  const current = resolved?.key === item?.key ? resolved : item?.load ? null : item;
  const zoom = useZoomPan(item?.key, { clickZoom: current?.kind !== 'video' });

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (knownAlbum || !resolveAlbum) return;
    let live = true;
    setAlbumState('loading');
    void resolveAlbum()
      .then((value) => {
        if (live) {
          setAlbum(value);
          setAlbumState('ready');
        }
      })
      .catch(() => {
        if (live) setAlbumState('error');
      });
    return () => {
      live = false;
    };
  }, [knownAlbum, resolveAlbum, albumRetry]);

  useEffect(() => {
    let live = true;
    setError('');
    if (item?.load)
      void item
        .load()
        .then((value) => {
          if (live) setResolved({ ...value, key: item.key });
        })
        .catch(() => {
          if (live) setError('媒体读取失败');
        });
    return () => {
      live = false;
    };
  }, [item]);

  function move(delta: number) {
    setIndex((value) => Math.max(0, Math.min(items.length - 1, value + delta)));
  }

  if (!item) return null;
  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label="空间媒体预览"
      tabIndex={-1}
      className="weq-qz-preview"
      style={{ zIndex: layer }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          if ((event.target as HTMLElement).tagName === 'VIDEO') return;
          event.preventDefault();
          event.stopPropagation();
          move(event.key === 'ArrowLeft' ? -1 : 1);
        }
        if (event.key === 'Tab') {
          const controls = [
            ...(root.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), video[controls]',
            ) ?? []),
          ];
          const first = controls[0],
            last = controls[controls.length - 1];
          if (
            event.shiftKey &&
            (document.activeElement === first || document.activeElement === root.current)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <header className="weq-qz-preview-toolbar">
        <span aria-live="polite">
          {index + 1} / {items.length}
        </span>
        <div>
          {current?.kind === 'image' ? (
            <>
              <button
                type="button"
                title="缩小"
                aria-label="缩小"
                disabled={!zoom.zoomed}
                onClick={zoom.zoomOut}
              >
                <ZoomOut size={19} />
              </button>
              <output aria-label="缩放比例">{Math.round(zoom.scale * 100)}%</output>
              <button
                type="button"
                title="放大"
                aria-label="放大"
                disabled={zoom.scale >= 8}
                onClick={zoom.zoomIn}
              >
                <ZoomIn size={19} />
              </button>
              <button type="button" title="适应窗口" aria-label="适应窗口" onClick={zoom.reset}>
                <RotateCcw size={18} />
              </button>
            </>
          ) : null}
          <button type="button" title="关闭" aria-label="关闭预览" onClick={onClose}>
            <X size={22} />
          </button>
        </div>
      </header>
      <div
        className="weq-qz-preview-viewport"
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const left = event.clientX < rect.left + rect.width / 2;
          event.currentTarget.style.cursor = (left ? index > 0 : index < items.length - 1)
            ? left
              ? 'w-resize'
              : 'e-resize'
            : 'default';
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          move(event.clientX < rect.left + rect.width / 2 ? -1 : 1);
        }}
      >
        <button
          className="weq-qz-preview-side is-left"
          type="button"
          title="上一项"
          aria-label="上一项媒体"
          disabled={index === 0}
          onClick={() => move(-1)}
        >
          <ChevronLeft size={26} />
        </button>
        <div className="weq-qz-preview-stage">
          {error ? (
            <p role="alert">{error}</p>
          ) : !current ? (
            <Loader2 className="weq-spin" aria-label="正在加载媒体" />
          ) : current.kind === 'image' ? (
            <img
              key={item.key}
              ref={zoom.setEl}
              src={current.src}
              alt={item.title || '空间照片'}
              draggable={false}
              style={zoom.style}
              onMouseDown={zoom.onMouseDown}
              onError={() => setError('图片暂时无法加载')}
            />
          ) : (
            <video
              key={item.key}
              src={current.src}
              poster={item.poster}
              controls
              autoPlay
              onError={() => setError('视频暂时无法播放')}
            />
          )}
        </div>
        <button
          className="weq-qz-preview-side is-right"
          type="button"
          title="下一项"
          aria-label="下一项媒体"
          disabled={index === items.length - 1}
          onClick={() => move(1)}
        >
          <ChevronRight size={26} />
        </button>
      </div>
      <footer className="weq-qz-preview-footer">
        {album ? (
          <button
            type="button"
            className="weq-qz-preview-album"
            title={album.name}
            onClick={() => {
              onClose();
              if (onAlbum) onAlbum(album);
              else navigate?.(album.hostUin, album.topicId, album.name);
            }}
            disabled={!onAlbum && !navigate}
          >
            <Images size={17} />
            <span>{album.name || '未命名相册'}</span>
          </button>
        ) : albumState === 'loading' ? (
          <span role="status">
            <Loader2 size={14} className="weq-spin" />
            正在读取相册…
          </span>
        ) : (
          <span>
            相册信息暂不可用
            {albumState === 'error' ? (
              <button
                type="button"
                title="重试读取相册"
                aria-label="重试读取相册"
                onClick={() => setAlbumRetry((v) => v + 1)}
              >
                <RotateCcw size={15} />
              </button>
            ) : null}
          </span>
        )}
      </footer>
    </div>,
    document.body,
  );
}
