import { ImageOff, Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import { TransferRing } from './TransferRing';
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
  if (status === 'error')
    return (
      <button
        type="button"
        className="weq-media-load-status weq-media-load-error"
        aria-label={`重试加载${kind}`}
        onClick={(event) => {
          event.currentTarget
            .closest('.weq-lightbox-layer')
            ?.querySelector<HTMLButtonElement>('.weq-lightbox-close')
            ?.focus({ preventScroll: true });
          onRetry();
        }}
      >
        <ImageOff size={24} aria-hidden />
        <span>
          {kind}暂时无法{kind === '视频' ? '播放' : '加载'}
        </span>
        <span>点击重试加载</span>
      </button>
    );
  return (
    <div className="weq-media-load-status" role="status">
      <TransferRing progress={{ phase: 'preparing' }} label={`正在加载${kind}`} size={24} />
      <span>正在加载{kind}…</span>
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
  const percent = Math.round(zoom.scale * 100);
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
        <span className="weq-number weq-number-inherit">{percent}</span>%
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
        className="weq-lightbox-action weq-media-zoom-reset"
        aria-label="适应窗口"
        aria-description={`当前缩放 ${percent}%`}
        title="适应窗口"
        disabled={disabled || !zoom.canReset}
        onClick={zoom.reset}
      >
        <Maximize size={18} aria-hidden />
        <span className="weq-media-zoom-compact weq-number weq-number-inherit" aria-hidden>
          {percent}%
        </span>
      </button>
    </div>
  );
}
