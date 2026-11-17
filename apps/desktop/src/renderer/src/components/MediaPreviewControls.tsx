import { ImageOff, Loader2, Maximize, RefreshCw, ZoomIn, ZoomOut } from 'lucide-react';
import type { ZoomPan } from './useZoomPan';
import '../styles/media-preview.css';

export type MediaLoadState = 'loading' | 'ready' | 'error';

export function MediaLoadStatus({
  kind,
  status,
  onRetry,
}: {
  kind: '图片' | '视频';
  status: MediaLoadState;
  onRetry: () => void;
}) {
  if (status === 'ready') return null;
  return (
    <div
      className={`weq-media-load-status${status === 'error' ? ' weq-media-load-error' : ''}`}
      role="status"
    >
      {status === 'loading' ? (
        <Loader2 className="weq-spin" size={24} aria-hidden />
      ) : (
        <ImageOff size={24} aria-hidden />
      )}
      <span>
        {status === 'loading'
          ? `正在加载${kind}…`
          : `${kind}暂时无法${kind === '视频' ? '播放' : '加载'}`}
      </span>
      {status === 'error' ? (
        <button
          type="button"
          className="weq-lightbox-action"
          aria-label={`重试加载${kind}`}
          onClick={(event) => {
            event.currentTarget
              .closest('.weq-lightbox-layer')
              ?.querySelector<HTMLButtonElement>('.weq-lightbox-close')
              ?.focus({ preventScroll: true });
            onRetry();
          }}
        >
          <RefreshCw size={16} aria-hidden />
          重试
        </button>
      ) : null}
    </div>
  );
}

export function MediaZoomControls({
  zoom,
  disabled = false,
}: {
  zoom: ZoomPan;
  disabled?: boolean;
}) {
  return (
    <div className="weq-media-zoom-controls" role="group" aria-label="预览缩放">
      <button
        type="button"
        className="weq-lightbox-action"
        aria-label="缩小"
        title="缩小"
        disabled={disabled || zoom.scale <= 1}
        onClick={zoom.zoomOut}
      >
        <ZoomOut size={18} aria-hidden />
      </button>
      <output aria-label="缩放比例">
        <span className="weq-number weq-number-inherit">{Math.round(zoom.scale * 100)}</span>%
      </output>
      <button
        type="button"
        className="weq-lightbox-action"
        aria-label="放大"
        title="放大"
        disabled={disabled || zoom.scale >= 8}
        onClick={zoom.zoomIn}
      >
        <ZoomIn size={18} aria-hidden />
      </button>
      <button
        type="button"
        className="weq-lightbox-action"
        aria-label="适应窗口"
        title="适应窗口"
        disabled={disabled || !zoom.canReset}
        onClick={zoom.reset}
      >
        <Maximize size={18} aria-hidden />
      </button>
    </div>
  );
}
