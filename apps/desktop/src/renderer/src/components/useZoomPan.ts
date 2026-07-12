/**
 * Zoom / pan interaction for lightbox media (image or video).
 *
 *   - 滚轮：以光标为锚点连续缩放（放大处在鼠标下的点保持不动）。
 *   - 单击：在 1× 与 CLICK_ZOOM 之间切换（可用 clickZoom:false 关闭，
 *     视频用它把单击留给播放/暂停）。
 *   - 拖拽：放大后按住拖动平移；1× 时不平移（让视频进度条等原生控件可用）。
 *   - resetKey（一般传 src）变化时自动复位到 1×、居中。
 *
 * 返回一个 callback ref（挂到媒体元素上，用于绑定 passive:false 的 wheel
 * 监听，以便 preventDefault 阻止页面滚动）、以及要展开到元素上的样式与事件。
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const WHEEL_STEP = 1.35; // 每格滚轮的缩放倍率
const CLICK_ZOOM = 2; // 单击放大到的倍率
const DRAG_THRESHOLD = 4; // 超过该位移(px)才算拖拽，否则视为单击

interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

const IDENTITY: Transform = { scale: 1, tx: 0, ty: 0 };

export interface ZoomPan {
  /** 挂到媒体元素（img/video）上的 callback ref。 */
  setEl(el: HTMLElement | null): void;
  /** 展开到媒体元素上的 transform / cursor 样式。 */
  style: CSSProperties;
  onMouseDown(event: React.MouseEvent): void;
  /** 是否处于放大状态（供外层决定是否显示「重置」按钮等）。 */
  zoomed: boolean;
  reset(): void;
}

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

export function useZoomPan(resetKey: unknown, opts?: { clickZoom?: boolean }): ZoomPan {
  const clickZoom = opts?.clickZoom ?? true;

  const [t, setT] = useState<Transform>(IDENTITY);
  const [dragging, setDragging] = useState(false);
  const [el, setEl] = useState<HTMLElement | null>(null);

  // 事件处理里需要读到「当前」变换，用 ref 镜像 state 避免闭包旧值。
  const ref = useRef(t);
  ref.current = t;

  const reset = useCallback(() => setT(IDENTITY), []);

  // 切换媒体（或关闭再开）时复位。
  useEffect(() => setT(IDENTITY), [resetKey]);

  /** 以 (clientX, clientY) 为锚点缩放到 nextScale，锚点在屏幕上保持不动。 */
  const zoomAt = useCallback((clientX: number, clientY: number, nextScale: number, rect: DOMRect) => {
    const cur = ref.current;
    const s = clampScale(nextScale);
    if (s === cur.scale) return;
    if (s <= 1) {
      setT(IDENTITY);
      return;
    }
    // rect 是元素当前（已变换）的包围盒，其中心即当前屏幕中心。
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const k = 1 - s / cur.scale;
    setT({ scale: s, tx: cur.tx + (clientX - cx) * k, ty: cur.ty + (clientY - cy) * k });
  }, []);

  // 滚轮缩放：用原生 non-passive 监听，才能 preventDefault 阻止页面滚动。
  useEffect(() => {
    if (!el) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
      zoomAt(event.clientX, event.clientY, ref.current.scale * factor, rect);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [el, zoomAt]);

  const onMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (event.button !== 0) return;
      // 阻止冒泡到遮罩层（否则会触发关闭）。
      event.stopPropagation();
      const startX = event.clientX;
      const startY = event.clientY;
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const start = ref.current;
      let moved = false;

      const onMove = (ev: MouseEvent): void => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
          moved = true;
          setDragging(true);
        }
        // 仅在放大后平移；1× 时不动，避免影响视频原生控件的拖动。
        if (moved && start.scale > 1) {
          setT({ scale: start.scale, tx: start.tx + dx, ty: start.ty + dy });
        }
      };
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        setDragging(false);
        // 没拖动过 = 单击：在 1× / CLICK_ZOOM 间切换。
        if (!moved && clickZoom) {
          const next = ref.current.scale > 1 ? 1 : CLICK_ZOOM;
          zoomAt(startX, startY, next, rect);
        }
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [clickZoom, zoomAt],
  );

  const style: CSSProperties = {
    transform: `translate3d(${t.tx}px, ${t.ty}px, 0) scale(${t.scale})`,
    transition: dragging ? 'none' : 'transform 140ms ease',
    cursor: t.scale > 1 ? (dragging ? 'grabbing' : 'grab') : clickZoom ? 'zoom-in' : 'default',
    willChange: 'transform',
  };

  return { setEl, style, onMouseDown, zoomed: t.scale > 1, reset };
}
