import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { MoveDiagonal2 } from 'lucide-react';
import { OverlayLayerContext, hasActiveModal, useOverlayLayerScope } from '../lib/overlayStack';
import { OverlayAnchorContext, useOverlayAnchor } from '../lib/overlayAnchor.shared';
import { useRenderDocument } from '../lib/renderDocument';
import { useSurfaceEscape } from '../lib/surfaceEscape';
import { useTabActive } from './RetainedTabs.shared';
import '../styles/window-surface.css';
import { useSurfaceOutside } from '../lib/surfaceOutside';
import { visibleViewport } from '../lib/visibleViewport';
import { useMobileWebViewport } from '../hooks/useMobileWebViewport';
import { IS_WEB } from '../lib/target.shared';

type Box = { x: number; y: number; width: number; height: number };
const resizeHandles = ['n', 'e', 's', 'w', 'nw', 'ne', 'sw'] as const;
type ResizeHandle = (typeof resizeHandles)[number] | 'se';
const margin = 8;
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(value, Math.max(min, max)));

function resizeBox(
  box: Box,
  edge: ResizeHandle,
  dx: number,
  dy: number,
  viewport: ReturnType<typeof visibleViewport>,
): Box {
  const left = viewport.left + margin;
  const top = viewport.top + margin;
  const right = viewport.left + viewport.width - margin;
  const bottom = viewport.top + viewport.height - margin;
  const minWidth = Math.min(320, Math.max(1, right - left));
  const minHeight = Math.min(220, Math.max(1, bottom - top));
  const west = edge.includes('w');
  const north = edge.includes('n');
  const width = west
    ? clamp(box.width - dx, minWidth, box.x + box.width - left)
    : edge.includes('e')
      ? clamp(box.width + dx, minWidth, right - box.x)
      : box.width;
  const height = north
    ? clamp(box.height - dy, minHeight, box.y + box.height - top)
    : edge.includes('s')
      ? clamp(box.height + dy, minHeight, bottom - box.y)
      : box.height;
  return {
    width,
    height,
    x: west ? box.x + box.width - width : box.x,
    y: north ? box.y + box.height - height : box.y,
  };
}

/** 应用内浮窗与原位任务窗格共用边界、焦点和层级；不创建系统窗口。 */
export function WindowSurface({
  children,
  open = true,
  mode,
  anchor,
  centered = false,
  resizeEdges = false,
  width = 640,
  labelledBy,
  title,
  className,
  onClose,
  role = 'dialog',
  dismissOnOutside = true,
}: {
  children: ReactNode;
  open?: boolean;
  mode: 'floating' | 'anchored';
  anchor?: HTMLElement | null;
  centered?: boolean;
  resizeEdges?: boolean;
  width?: number | string;
  labelledBy?: string;
  title?: string;
  className?: string;
  onClose?: () => void;
  role?: 'dialog' | 'presentation';
  dismissOnOutside?: boolean;
}) {
  const document = useRenderDocument();
  const view = document.defaultView;
  const active = useTabActive() && open;
  const card = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  useMobileWebViewport(layerRef, active && IS_WEB);
  const placement = useOverlayAnchor(card, active, false, anchor);
  const origin = mode === 'floating' && centered ? null : placement.anchor;
  const viewport = useCallback(() => visibleViewport(view), [view]);
  const fitViewport = useCallback(
    (value: Box): Box => {
      const size = viewport();
      const availableWidth = Math.max(1, size.width - margin * 2);
      const availableHeight = Math.max(1, size.height - margin * 2);
      const w = clamp(value.width, Math.min(320, availableWidth), availableWidth);
      const h = clamp(value.height, Math.min(220, availableHeight), availableHeight);
      return {
        width: w,
        height: h,
        x: clamp(value.x, size.left + margin, size.left + size.width - w - margin),
        y: clamp(value.y, size.top + margin, size.top + size.height - h - margin),
      };
    },
    [viewport],
  );
  const initial = useCallback(() => {
    const size = viewport();
    const w = typeof width === 'number' ? width : 640;
    const h = Math.min(
      mode === 'anchored' ? 540 : 680,
      size.height * (mode === 'anchored' ? 0.7 : 0.8),
    );
    return fitViewport({
      x: origin?.rect.left ?? size.left + (size.width - w) / 2,
      y: origin
        ? origin.rect.bottom + h + margin <= size.height
          ? origin.rect.bottom + margin
          : origin.rect.top - h - margin
        : size.top + (size.height - h) / 2,
      width: w,
      height: h,
    });
  }, [viewport, width, mode, fitViewport, origin]);
  const [box, setBox] = useState(initial);
  const latest = useRef(box);
  latest.current = box;
  const [layerRevision, setLayerRevision] = useState(0);
  const { layer, scope } = useOverlayLayerScope(active, layerRevision);
  const raise = () => setLayerRevision((current) => current + 1);
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    box: Box;
    edge: ResizeHandle | undefined;
    capture: Element;
  } | null>(null);
  const finish = useCallback((event?: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || (event && event.pointerId !== current.pointerId)) return;
    gesture.current = null;
    if (current.capture.hasPointerCapture(current.pointerId))
      current.capture.releasePointerCapture(current.pointerId);
  }, []);
  useEffect(() => {
    if (!active) finish();
    return finish;
  }, [active, finish]);
  const place = useCallback(() => {
    setBox((current) => {
      let next = fitViewport(current);
      if (mode === 'anchored') {
        const target = anchor?.isConnected ? anchor : origin?.element;
        const size = viewport();
        if (!target)
          next = fitViewport({
            ...next,
            x: size.width - next.width - 16,
            y: size.height - next.height - 64,
          });
        else {
          const rect = target.getClientRects().length
            ? target.getBoundingClientRect()
            : (origin?.rect ?? target.getBoundingClientRect());
          const x =
            rect.right + next.width + 8 <= size.width ? rect.right + 8 : rect.left - next.width - 8;
          const y =
            rect.bottom + next.height + 8 <= size.height
              ? rect.bottom + 8
              : rect.bottom - next.height;
          next = fitViewport({ ...next, x, y });
        }
      }
      return next.x === current.x &&
        next.y === current.y &&
        next.width === current.width &&
        next.height === current.height
        ? current
        : next;
    });
  }, [anchor, mode, fitViewport, viewport, origin]);
  useLayoutEffect(() => {
    if (!active) return;
    place();
    view?.addEventListener('resize', place);
    view?.visualViewport?.addEventListener('resize', place);
    view?.visualViewport?.addEventListener('scroll', place);
    if (mode === 'anchored') document.addEventListener('scroll', place, true);
    const observer = mode === 'anchored' ? new MutationObserver(place) : null;
    for (
      let element: HTMLElement | null | undefined = anchor ?? origin?.element;
      element && element !== document.body;
      element = element.parentElement
    )
      observer?.observe(element, { attributes: true, attributeFilter: ['style', 'class'] });
    return () => {
      view?.removeEventListener('resize', place);
      view?.visualViewport?.removeEventListener('resize', place);
      view?.visualViewport?.removeEventListener('scroll', place);
      document.removeEventListener('scroll', place, true);
      observer?.disconnect();
    };
  }, [active, place, view, mode, document, anchor, origin?.element]);
  useSurfaceOutside(card, onClose, active && mode === 'anchored' && dismissOnOutside, {
    anchor: anchor ?? origin?.element,
  });
  useSurfaceEscape(card, onClose, active, false, 100, scope);
  const start = (event: PointerEvent<HTMLDivElement>) => {
    placement.capture(event);
    if (!active || !event.currentTarget.contains(event.target as Node)) return;
    // 模态确认框打开期间不再抢层：它和本窗是两个互不相关的 body portal，
    // 这里每 pointerdown 一次都抬高的话，会把确认框压到任务窗下面。
    if (!hasActiveModal(document)) raise();
    if (mode !== 'floating' || event.button !== 0 || !(event.target instanceof Element)) return;
    const resizeHandle = event.target.closest<HTMLElement>('[data-window-resize]');
    const edge = resizeHandle?.dataset.windowResize as ResizeHandle | undefined;
    const handle = event.target.closest('[data-window-drag-handle]');
    if (
      !edge &&
      (!handle ||
        event.target.closest('button, input, select, textarea, a, [contenteditable="true"]'))
    )
      return;
    const capture = resizeHandle ?? handle ?? event.currentTarget;
    event.preventDefault();
    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      box: { ...latest.current },
      edge,
      capture,
    };
    capture.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x,
      dy = event.clientY - current.y;
    setBox(
      current.edge
        ? resizeBox(current.box, current.edge, dx, dy, viewport())
        : fitViewport({ ...current.box, x: current.box.x + dx, y: current.box.y + dy }),
    );
  };
  return createPortal(
    <div
      ref={layerRef}
      className="weq-window-layer"
      hidden={!active}
      inert={!active}
      style={{ zIndex: layer, display: active ? undefined : 'none' }}
    >
      <div
        ref={card}
        tabIndex={-1}
        role={role}
        aria-labelledby={role === 'dialog' ? labelledBy : undefined}
        aria-label={role === 'dialog' && !labelledBy ? title : undefined}
        data-resize-edges={mode === 'floating' && resizeEdges ? '' : undefined}
        className={`weq-window-surface is-${mode}${className ? ` ${className}` : ''}`}
        style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
        onPointerDownCapture={start}
        onClickCapture={placement.capture}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onFocusCapture={(event) => {
          if (!hasActiveModal(document) && event.currentTarget.contains(event.target as Node))
            raise();
        }}
        onDoubleClick={(event) => {
          if (
            mode === 'floating' &&
            event.target instanceof Element &&
            event.target.closest('[data-window-drag-handle]') &&
            !event.target.closest('button, input, select, textarea')
          )
            setBox(initial());
        }}
      >
        <div className="weq-window-content">
          <OverlayLayerContext.Provider value={scope}>
            <OverlayAnchorContext.Provider value={placement.trigger}>
              {children}
            </OverlayAnchorContext.Provider>
          </OverlayLayerContext.Provider>
        </div>
        {mode === 'floating' && resizeEdges
          ? resizeHandles.map((edge) => (
              <span
                className="weq-window-resize-edge"
                data-window-resize={edge}
                key={edge}
                aria-hidden
              />
            ))
          : null}
        {mode === 'floating' ? (
          <button
            type="button"
            className="weq-window-resize"
            data-window-resize="se"
            title="调整窗口大小"
            aria-label="调整窗口大小"
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
              const step = event.shiftKey ? 64 : 16;
              setBox((current) =>
                resizeBox(
                  current,
                  'se',
                  event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0,
                  event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0,
                  viewport(),
                ),
              );
            }}
          >
            <MoveDiagonal2 size={14} />
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
