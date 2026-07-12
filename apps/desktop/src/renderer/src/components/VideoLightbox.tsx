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
 */

import { useEffect, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { X } from 'lucide-react';
import { useZoomPan } from './useZoomPan';

interface VideoLightboxStore {
  src: string | null;
  poster: string;
  open(src: string, poster?: string): void;
  close(): void;
}

const useVideoLightbox = create<VideoLightboxStore>((set, get) => ({
  src: null,
  poster: '',
  open(src, poster = '') {
    if (!src || get().src === src) return; // de-dup: same video already open
    set({ src, poster });
  },
  close() {
    set({ src: null, poster: '' });
  },
}));

/** Open the video lightbox for `src`. No-op if that exact src is already showing. */
export function openVideoLightbox(src: string, poster?: string): void {
  useVideoLightbox.getState().open(src, poster);
}

/** Mount once. Renders the active video overlay, if any. */
export function VideoLightbox(): ReactElement | null {
  const src = useVideoLightbox((s) => s.src);
  const poster = useVideoLightbox((s) => s.poster);
  const close = useVideoLightbox((s) => s.close);
  const zoom = useZoomPan(src, { clickZoom: false });

  useEffect(() => {
    if (!src) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [src, close]);

  if (typeof document === 'undefined' || !src) return null;

  return createPortal(
    <div className="weq-lightbox-layer weq-anim-fade" onMouseDown={close}>
      <button className="weq-lightbox-close" type="button" onClick={close} aria-label="关闭">
        <X size={22} />
      </button>
      <div className="weq-lightbox-stage weq-anim-pop" onMouseDown={(event) => event.stopPropagation()}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={zoom.setEl}
          className="weq-lightbox-image"
          src={src}
          poster={poster || undefined}
          controls
          autoPlay
          style={zoom.style}
          onMouseDown={zoom.onMouseDown}
        />
      </div>
    </div>,
    document.body,
  );
}
