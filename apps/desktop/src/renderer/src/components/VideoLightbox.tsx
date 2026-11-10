/**
 * Full-screen video lightbox — click a local video's cover to play it large.
 *
 *   - openVideoLightbox(src, poster?)  imperative open; opening the SAME src
 *     that's already shown is a no-op (built-in de-dup).
 *   - <VideoLightbox/>                 mount once near the root; renders the
 *     overlay for whatever the store currently holds (a single global portal).
 *
 * Sibling of {@link ImageLightbox}; kept separate because it renders a `<video>`
 * (controls / autoplay / range streaming) rather than an `<img>`. Click the
 * backdrop or press ESC to close. Scroll to zoom (anchored at the cursor) and
 * drag to pan when zoomed; single click is left to the native play/pause.
 *
 * 底部操作条只放「另存为」—— 视频不做 OCR（识别文字是图片的事），也不做「复制到
 * 剪贴板」（把一段视频塞进剪贴板没有意义）。
 */

import { useEffect, useRef, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { X } from 'lucide-react';
import { useOverlayLayer } from '../lib/overlayStack';
import { MediaSourceSave } from './MediaSaveControls';
import { useZoomPan } from './useZoomPan';
import { useSurfaceEscape } from '../lib/surfaceEscape';
import { mediaRetryUrl } from '../lib/mediaRetryUrl';
import {
  MediaLoadStatus,
  MediaZoomControls,
  mediaZoomKeyDown,
  type MediaLoadState,
} from './MediaPreviewControls';

interface VideoLightboxStore {
  src: string | null;
  poster: string;
  /** 另存为对话框里的默认文件名（调用方手上的原始名字）。 */
  name: string;
  attempt: number;
  status: MediaLoadState;
  open(src: string, poster?: string, name?: string): void;
  loaded(src: string, attempt: number, status: MediaLoadState): void;
  retry(): void;
  close(): void;
}

const useVideoLightbox = create<VideoLightboxStore>((set, get) => ({
  src: null,
  poster: '',
  name: '',
  attempt: 0,
  status: 'loading',
  open(src, poster = '', name = '') {
    if (!src || get().src === src) return; // de-dup: same video already open
    set({ src, poster, name, attempt: 0, status: 'loading' });
  },
  loaded(src, attempt, status) {
    if (get().src === src && get().attempt === attempt) set({ status });
  },
  retry() {
    set({ attempt: get().attempt + 1, status: 'loading' });
  },
  close() {
    set({ src: null, poster: '', name: '' });
  },
}));

/** Open the video lightbox for `src`. No-op if that exact src is already showing. */
export function openVideoLightbox(src: string, poster?: string, name?: string): void {
  useVideoLightbox.getState().open(src, poster, name);
}

/** Mount once. Renders the active video overlay, if any. */
export function VideoLightbox(): ReactElement | null {
  const src = useVideoLightbox((s) => s.src);
  const poster = useVideoLightbox((s) => s.poster);
  const posterName = useVideoLightbox((s) => s.name);
  const close = useVideoLightbox((s) => s.close);
  const status = useVideoLightbox((s) => s.status);
  const attempt = useVideoLightbox((s) => s.attempt);
  const loaded = useVideoLightbox((s) => s.loaded);
  const retry = useVideoLightbox((s) => s.retry);
  const zoom = useZoomPan(`${src}:${attempt}`, { clickZoom: false });
  const layer = useOverlayLayer(src !== null);
  const layerRef = useRef<HTMLDivElement>(null);
  useSurfaceEscape(layerRef, close, src !== null, true);

  useEffect(() => () => close(), [close]);

  if (typeof document === 'undefined' || !src) return null;

  return createPortal(
    <div
      ref={layerRef}
      className="weq-lightbox-layer weq-media-preview-layer weq-anim-fade"
      role="dialog"
      aria-modal="true"
      aria-label={posterName ? `视频预览：${posterName}` : '视频预览'}
      tabIndex={-1}
      style={{ zIndex: layer }}
      onMouseDown={close}
      onKeyDown={(event) => {
        if (status === 'ready') mediaZoomKeyDown(event, zoom);
      }}
    >
      <button className="weq-lightbox-close" type="button" onClick={close} aria-label="关闭">
        <X size={22} />
      </button>
      <div className="weq-lightbox-stage-wrap weq-anim-pop">
        <div
          className="weq-lightbox-stage"
          data-media-state={status}
          aria-busy={status === 'loading'}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            key={`${src}:${attempt}`}
            ref={zoom.setEl}
            className="weq-lightbox-image"
            src={mediaRetryUrl(src, attempt)}
            poster={poster || undefined}
            controls
            autoPlay
            style={{ ...zoom.style, touchAction: zoom.zoomed ? 'none' : 'auto' }}
            onMouseDown={zoom.onMouseDown}
            onPointerDown={zoom.onPointerDown}
            onCanPlay={() => loaded(src, attempt, 'ready')}
            onError={() => loaded(src, attempt, 'error')}
          />
          <MediaLoadStatus kind="视频" status={status} onRetry={retry} />
        </div>
        <div className="weq-lightbox-actions" onMouseDown={(event) => event.stopPropagation()}>
          <MediaZoomControls zoom={zoom} disabled={status !== 'ready'} />
          <MediaSourceSave
            key={src}
            source={{ kind: 'url', url: src, name: posterName }}
            className="weq-lightbox-action"
            label="保存视频"
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
