import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Loader2, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useOverlayLayer } from '../lib/overlayStack';
import { topSurface } from '../lib/surfaceEscape';
import { useZoomPan } from './useZoomPan';
import '../styles/qzone-preview.css';

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
  onClose,
  label = '空间媒体预览',
  renderActions,
}: {
  items: QzonePreviewMedia[];
  initialIndex: number;
  onClose: () => void;
  label?: string;
  renderActions?: (item: QzonePreviewMedia) => ReactNode;
}) {
  const [index, setIndex] = useState(initialIndex);
  const item = items[index];
  const [resolved, setResolved] = useState<{
    key: string;
    src: string;
    kind: 'image' | 'video';
  } | null>(null);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState(false);
  const [mediaRetry, setMediaRetry] = useState(0);
  const mediaLoads = useRef(
    new Map<
      string,
      {
        load: NonNullable<QzonePreviewMedia['load']>;
        promise: ReturnType<NonNullable<QzonePreviewMedia['load']>>;
      }
    >(),
  );
  const root = useRef<HTMLDivElement>(null);
  const layer = useOverlayLayer(true);
  const current =
    resolved?.key === item?.key ? resolved : item?.load && item.kind === 'video' ? null : item;
  const zoom = useZoomPan(item?.key, { clickZoom: current?.kind !== 'video' });

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    let live = true;
    setError('');
    setDetailError(false);
    if (item?.load) {
      let cached = mediaLoads.current.get(item.key);
      if (!cached || cached.load !== item.load) {
        const promise = Promise.resolve().then(item.load);
        cached = { load: item.load, promise };
        mediaLoads.current.set(item.key, cached);
        void promise.catch(() => {
          if (mediaLoads.current.get(item.key)?.promise === promise)
            mediaLoads.current.delete(item.key);
        });
      }
      void cached.promise
        .then((value) => {
          if (live) setResolved({ ...value, key: item.key });
        })
        .catch(() => {
          if (!live) return;
          if (item.kind === 'image' && item.src) setDetailError(true);
          else setError('媒体读取失败');
        });
    }
    return () => {
      live = false;
    };
  }, [item, mediaRetry]);

  function move(delta: number) {
    setIndex((value) => Math.max(0, Math.min(items.length - 1, value + delta)));
  }

  if (!item) return null;
  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      className={`weq-qz-preview${renderActions ? ' has-actions' : ''}`}
      style={{ zIndex: layer }}
      onKeyDown={(event) => {
        const top = topSurface(document);
        if (top && top !== root.current) return;
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          const target = event.target as HTMLElement;
          if (
            target.closest(
              'input, textarea, select, video, [contenteditable="true"], [role="menu"]',
            )
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          move(event.key === 'ArrowLeft' ? -1 : 1);
        }
        if (event.key === 'Tab') {
          const controls = [
            ...(root.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), video[controls]',
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
          {detailError ? (
            <button
              type="button"
              title="原图读取失败，重试"
              aria-label="重试读取原图"
              onClick={() => setMediaRetry((v) => v + 1)}
            >
              <RotateCcw size={15} />
            </button>
          ) : null}
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
      <div className="weq-qz-preview-viewport">
        <button
          type="button"
          className="weq-qz-preview-blank is-left"
          aria-hidden="true"
          tabIndex={-1}
          disabled={index === 0}
          onClick={() => move(-1)}
        />
        <button
          type="button"
          className="weq-qz-preview-blank is-right"
          aria-hidden="true"
          tabIndex={-1}
          disabled={index === items.length - 1}
          onClick={() => move(1)}
        />
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
              onError={() => {
                if (current.src !== item.src && item.src) {
                  mediaLoads.current.delete(item.key);
                  setResolved({ key: item.key, kind: 'image', src: item.src });
                  setDetailError(true);
                } else setError('图片暂时无法加载');
              }}
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
      {renderActions && <footer className="weq-qz-preview-actions">{renderActions(item)}</footer>}
    </div>,
    document.body,
  );
}
