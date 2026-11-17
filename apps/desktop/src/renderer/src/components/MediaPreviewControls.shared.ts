import type { KeyboardEvent } from 'react';
import type { ZoomPan } from './useZoomPan';
import { topSurface } from '../lib/surfaceEscape';
import '../styles/media-preview.css';

export function mediaZoomKeyDown(event: KeyboardEvent<HTMLDivElement>, zoom: ZoomPan): void {
  const surface = topSurface(event.currentTarget.ownerDocument);
  if (
    event.defaultPrevented ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    (surface && surface !== event.currentTarget)
  )
    return;
  const target = event.target as HTMLElement;
  if (target.closest('input, textarea, select, [contenteditable="true"], video, .weq-ocr-panel'))
    return;
  const actions: Record<string, () => void> = {
    '+': zoom.zoomIn,
    '=': zoom.zoomIn,
    '-': zoom.zoomOut,
    '0': zoom.reset,
    ArrowLeft: () => zoom.panBy(40, 0),
    ArrowRight: () => zoom.panBy(-40, 0),
    ArrowUp: () => zoom.panBy(0, 40),
    ArrowDown: () => zoom.panBy(0, -40),
  };
  const action = actions[event.key];
  if (!action || (event.key.startsWith('Arrow') && !zoom.zoomed)) return;
  event.preventDefault();
  event.stopPropagation();
  action();
}
