/**
 * Full-screen image lightbox — click a chat image to view it large.
 *
 *   - openLightbox(src, alt?)  imperative open; opening the SAME src that's
 *     already shown is a no-op, so clicking one image repeatedly never stacks
 *     multiple overlays (built-in de-dup).
 *   - <ImageLightbox/>         mount once near the root; renders the overlay
 *     for whatever the store currently holds (a single global portal).
 *
 * Click the backdrop or press ESC to close. Scroll to zoom (anchored at the
 * cursor), click the image to toggle 2× zoom, drag to pan when zoomed.
 */

import { useEffect, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { X } from 'lucide-react';
import { useZoomPan } from './useZoomPan';

interface LightboxStore {
  src: string | null;
  alt: string;
  open(src: string, alt?: string): void;
  close(): void;
}

const useLightbox = create<LightboxStore>((set, get) => ({
  src: null,
  alt: '',
  open(src, alt = '') {
    if (!src || get().src === src) return; // de-dup: same image already open
    set({ src, alt });
  },
  close() {
    set({ src: null, alt: '' });
  },
}));

/** Open the lightbox for `src`. No-op if that exact src is already showing. */
export function openLightbox(src: string, alt?: string): void {
  useLightbox.getState().open(src, alt);
}

/** Mount once. Renders the active large-image overlay, if any. */
export function ImageLightbox(): ReactElement | null {
  const src = useLightbox((s) => s.src);
  const alt = useLightbox((s) => s.alt);
  const close = useLightbox((s) => s.close);
  const zoom = useZoomPan(src);

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
        <img
          ref={zoom.setEl}
          className="weq-lightbox-image"
          src={src}
          alt={alt}
          draggable={false}
          style={zoom.style}
          onMouseDown={zoom.onMouseDown}
        />
      </div>
    </div>,
    document.body,
  );
}
