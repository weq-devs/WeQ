/**
 * Zoom / pan interaction for lightbox media (image or video).
 *
 *   - 滚轮：以光标为锚点连续缩放（放大处在鼠标下的点保持不动）。
 *   - 单击：在 1× 与 CLICK_ZOOM 之间切换（可用 clickZoom:false 关闭，
 *     视频用它把单击留给播放/暂停）。
 *   - 拖拽：放大后按住拖动平移；1× 时不平移（让视频进度条等原生控件可用）。
 *   - 触摸：双指以中点连续缩放，松开一指后可继续平移；未放大时横滑翻图。
 *   - resetKey（一般传 src）变化时自动复位到 1×、居中。
 *
 * 返回一个 callback ref（挂到媒体元素上，用于绑定 passive:false 的 wheel
 * 监听，以便 preventDefault 阻止页面滚动）、以及要展开到元素上的样式与事件。
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const WHEEL_STEP = 1.15; // 每格滚轮的缩放倍率（越接近 1 越平滑）
const CLICK_ZOOM = 2; // 单击放大到的倍率
const DRAG_THRESHOLD = 4; // 超过该位移(px)才算拖拽，否则视为单击
const SWIPE_THRESHOLD = 48;

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
  onPointerDown(event: React.PointerEvent): void;
  panBy(dx: number, dy: number): void;
  /**
   * 以某个坐标点为中心缩放一档（滚轮步进）。
   *
   * 给「想让整块容器都能滚轮缩放」的调用方用 —— 灯箱把 wheel 转发到这里，
   * 锚点仍然按**媒体元素**的包围盒算，所以光标下的那个点保持不动。
   */
  wheelAt(clientX: number, clientY: number, deltaY: number): void;
  /** 是否处于放大状态（供外层决定是否显示「重置」按钮等）。 */
  zoomed: boolean;
  scale: number;
  canReset: boolean;
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
}

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

export function useZoomPan(
  resetKey: unknown,
  opts?: {
    clickZoom?: boolean;
    onSwipe?: (direction: 'left' | 'right') => void;
    onTapOutside?: (clientX: number, element: HTMLElement) => void;
  },
): ZoomPan {
  const clickZoom = opts?.clickZoom ?? true;
  const callbacks = useRef(opts);
  callbacks.current = opts;

  const [t, setT] = useState<Transform>(IDENTITY);
  const [dragging, setDragging] = useState(false);
  const [el, setEl] = useState<HTMLElement | null>(null);

  // 事件处理里需要读到「当前」变换，用 ref 镜像 state 避免闭包旧值。
  const ref = useRef(t);
  ref.current = t;
  const endDrag = useRef<(() => void) | null>(null);
  const addPointer = useRef<((event: React.PointerEvent) => void) | null>(null);
  const update = useCallback((next: Transform) => {
    ref.current = next;
    setT(next);
  }, []);

  const reset = useCallback(() => {
    endDrag.current?.();
    setDragging(false);
    update(IDENTITY);
  }, [update]);

  // 切换媒体（或关闭再开）时复位。
  useEffect(() => {
    reset();
    return () => endDrag.current?.();
  }, [resetKey, reset]);
  useEffect(() => () => endDrag.current?.(), [el]);

  /** 以 (clientX, clientY) 为锚点缩放到 nextScale，锚点在屏幕上保持不动。 */
  const zoomAt = useCallback(
    (clientX: number, clientY: number, nextScale: number, rect: DOMRect) => {
      const cur = ref.current;
      const s = clampScale(nextScale);
      if (s === cur.scale) return;
      if (s === 1) {
        update(IDENTITY);
        return;
      }
      // rect 是元素当前（已变换）的包围盒，其中心即当前屏幕中心。
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const k = 1 - s / cur.scale;
      update({ scale: s, tx: cur.tx + (clientX - cx) * k, ty: cur.ty + (clientY - cy) * k });
    },
    [update],
  );

  /** 滚轮一档：以 (clientX, clientY) 为锚点缩放。 */
  const wheelAt = useCallback(
    (clientX: number, clientY: number, deltaY: number): void => {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const factor = deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
      zoomAt(clientX, clientY, ref.current.scale * factor, rect);
    },
    [el, zoomAt],
  );

  // 滚轮缩放：用原生 non-passive 监听，才能 preventDefault 阻止页面滚动。
  useEffect(() => {
    if (!el) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      wheelAt(event.clientX, event.clientY, event.deltaY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [el, wheelAt]);

  const onMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (event.button !== 0 || addPointer.current) return;
      endDrag.current?.();
      // 阻止冒泡到遮罩层（否则会触发关闭）。
      event.stopPropagation();
      const startX = event.clientX;
      const startY = event.clientY;
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const viewport = event.currentTarget.ownerDocument.defaultView ?? window;
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
          update({ scale: start.scale, tx: start.tx + dx, ty: start.ty + dy });
        }
      };
      const onUp = (): void => {
        endDrag.current?.();
        setDragging(false);
        // 没拖动过 = 单击：在 1× / CLICK_ZOOM 间切换。
        if (!moved && clickZoom) {
          const next = ref.current.scale > 1 ? 1 : CLICK_ZOOM;
          zoomAt(startX, startY, next, rect);
        }
      };
      viewport.addEventListener('mousemove', onMove);
      viewport.addEventListener('mouseup', onUp);
      endDrag.current = () => {
        viewport.removeEventListener('mousemove', onMove);
        viewport.removeEventListener('mouseup', onUp);
        viewport.removeEventListener('blur', cancel);
        setDragging(false);
        endDrag.current = null;
      };
      const cancel = () => endDrag.current?.();
      viewport.addEventListener('blur', cancel);
    },
    [clickZoom, zoomAt, update],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.pointerType === 'mouse') return;
      if (
        (event.target as HTMLElement).closest(
          'button, input, textarea, select, [contenteditable="true"], .weq-ocr-cover',
        )
      )
        return;
      if (addPointer.current) {
        event.preventDefault();
        event.stopPropagation();
        addPointer.current(event);
        return;
      }
      if (!event.isPrimary || (!clickZoom && ref.current.scale <= 1)) return;
      endDrag.current?.();
      event.preventDefault();
      event.stopPropagation();
      const element = event.currentTarget as HTMLElement;
      const media = el ?? element;
      const startedOnMedia = media.contains(event.target as Node);
      const viewport = element.ownerDocument.defaultView ?? window;
      const points = new Map<number, { x: number; y: number }>();
      let single = { x: event.clientX, y: event.clientY, transform: ref.current };
      let rect = media.getBoundingClientRect();
      let pinch: {
        x: number;
        y: number;
        distance: number;
        cx: number;
        cy: number;
        transform: Transform;
      } | null = null;
      let moved = false;
      let multiple = false;
      const pair = () => {
        const [a, b] = [...points.values()];
        return {
          x: (a!.x + b!.x) / 2,
          y: (a!.y + b!.y) / 2,
          distance: Math.hypot(a!.x - b!.x, a!.y - b!.y),
        };
      };
      const cancel = () => endDrag.current?.();
      const add = (next: React.PointerEvent) => {
        if (points.has(next.pointerId)) return;
        // 第三指中断本轮，避免剩余手指被当作新的点击或翻页。
        if (points.size === 2) {
          cancel();
          return;
        }
        points.set(next.pointerId, { x: next.clientX, y: next.clientY });
        element.setPointerCapture?.(next.pointerId);
        if (points.size === 2) {
          multiple = true;
          moved = true;
          rect = media.getBoundingClientRect();
          pinch = {
            ...pair(),
            cx: rect.left + rect.width / 2,
            cy: rect.top + rect.height / 2,
            transform: ref.current,
          };
        }
      };
      const move = (next: PointerEvent) => {
        if (!points.has(next.pointerId)) return;
        points.set(next.pointerId, { x: next.clientX, y: next.clientY });
        if (points.size === 2 && pinch) {
          const current = pair();
          if (pinch.distance < 1) {
            pinch = { ...pinch, ...current };
            return;
          }
          const scale = clampScale((pinch.transform.scale * current.distance) / pinch.distance);
          const k = 1 - scale / pinch.transform.scale;
          update({
            scale,
            tx: pinch.transform.tx + current.x - pinch.x + (pinch.x - pinch.cx) * k,
            ty: pinch.transform.ty + current.y - pinch.y + (pinch.y - pinch.cy) * k,
          });
          return;
        }
        const dx = next.clientX - single.x,
          dy = next.clientY - single.y;
        if (Math.hypot(dx, dy) > DRAG_THRESHOLD) moved = true;
        if (moved && single.transform.scale > 1) {
          update({
            scale: single.transform.scale,
            tx: single.transform.tx + dx,
            ty: single.transform.ty + dy,
          });
        }
      };
      const finish = (next: PointerEvent) => {
        if (!points.has(next.pointerId)) return;
        move(next);
        points.delete(next.pointerId);
        if (points.size) {
          const remaining = [...points.values()][0]!;
          single = { ...remaining, transform: ref.current };
          pinch = null;
          return;
        }
        const dx = next.clientX - single.x,
          dy = next.clientY - single.y;
        cancel();
        if (ref.current.scale <= 1) update({ scale: ref.current.scale, tx: 0, ty: 0 });
        if (multiple) return;
        if (!moved && clickZoom && startedOnMedia)
          zoomAt(single.x, single.y, single.transform.scale > 1 ? 1 : CLICK_ZOOM, rect);
        else if (!moved && !startedOnMedia) callbacks.current?.onTapOutside?.(single.x, element);
        else if (
          single.transform.scale <= 1 &&
          ref.current.scale <= 1 &&
          Math.abs(dx) >= SWIPE_THRESHOLD &&
          Math.abs(dx) > Math.abs(dy) * 1.5
        )
          callbacks.current?.onSwipe?.(dx < 0 ? 'left' : 'right');
      };
      const cancelled = (next: PointerEvent) => {
        if (points.has(next.pointerId)) cancel();
      };
      viewport.addEventListener('pointermove', move);
      viewport.addEventListener('pointerup', finish);
      viewport.addEventListener('pointercancel', cancelled);
      viewport.addEventListener('lostpointercapture', cancelled);
      viewport.addEventListener('blur', cancel);
      endDrag.current = () => {
        endDrag.current = null;
        addPointer.current = null;
        viewport.removeEventListener('pointermove', move);
        viewport.removeEventListener('pointerup', finish);
        viewport.removeEventListener('pointercancel', cancelled);
        viewport.removeEventListener('lostpointercapture', cancelled);
        viewport.removeEventListener('blur', cancel);
        for (const id of points.keys())
          if (element.hasPointerCapture?.(id)) element.releasePointerCapture(id);
        points.clear();
        setDragging(false);
      };
      addPointer.current = add;
      setDragging(true);
      add(event);
    },
    [clickZoom, zoomAt, update, el],
  );

  const style: CSSProperties = {
    transform: `translate3d(${t.tx}px, ${t.ty}px, 0) scale(${t.scale})`,
    transition: dragging ? 'none' : 'transform 140ms ease',
    cursor: t.scale > 1 ? (dragging ? 'grabbing' : 'grab') : clickZoom ? 'zoom-in' : 'default',
    willChange: 'transform',
  };

  const step = (factor: number): void => {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    zoomAt(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      ref.current.scale * factor,
      rect,
    );
  };
  return {
    setEl,
    style,
    onMouseDown,
    onPointerDown,
    panBy: (dx, dy) =>
      setT((previous) =>
        previous.scale > 1 ? { ...previous, tx: previous.tx + dx, ty: previous.ty + dy } : previous,
      ),
    wheelAt,
    zoomed: t.scale > 1,
    scale: t.scale,
    canReset: t.scale !== 1 || t.tx !== 0 || t.ty !== 0,
    zoomIn: () => step(1.25),
    zoomOut: () => step(1 / 1.25),
    reset,
  };
}
