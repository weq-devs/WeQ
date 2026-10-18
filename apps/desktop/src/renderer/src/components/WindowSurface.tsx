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
import { claimOverlayLayer, hasActiveModal } from '../lib/overlayStack';
import { useRenderDocument } from '../lib/renderDocument';
import { useSurfaceEscape } from '../lib/surfaceEscape';
import { useTabActive } from './RetainedTabs';
import '../styles/window-surface.css';

type Box = { x: number; y: number; width: number; height: number };
const margin = 8;
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(value, Math.max(min, max)));

/** 应用内浮窗与原位任务窗格共用边界、焦点和层级；不创建系统窗口。 */
export function WindowSurface({
  children,
  open = true,
  mode,
  anchor,
  width = 640,
  labelledBy,
  title,
  className,
  onClose,
  role = 'dialog',
}: {
  children: ReactNode;
  open?: boolean;
  mode: 'floating' | 'anchored';
  anchor?: HTMLElement | null;
  width?: number | string;
  labelledBy?: string;
  title?: string;
  className?: string;
  onClose?: () => void;
  role?: 'dialog' | 'presentation';
}) {
  const document = useRenderDocument();
  const view = document.defaultView;
  const active = useTabActive() && open;
  const card = useRef<HTMLDivElement>(null);
  const viewport = useCallback(
    () => ({
      width: Math.max(1, view?.innerWidth ?? 1024),
      height: Math.max(1, view?.innerHeight ?? 768),
    }),
    [view],
  );
  const fit = useCallback(
    (value: Box): Box => {
      const size = viewport();
      const availableWidth = Math.max(1, size.width - margin * 2);
      const availableHeight = Math.max(1, size.height - margin * 2);
      const w = clamp(value.width, Math.min(320, availableWidth), availableWidth);
      const h = clamp(value.height, Math.min(220, availableHeight), availableHeight);
      return {
        width: w,
        height: h,
        x: clamp(value.x, margin, size.width - w - margin),
        y: clamp(value.y, margin, size.height - h - margin),
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
    return fit({ x: (size.width - w) / 2, y: (size.height - h) / 2, width: w, height: h });
  }, [viewport, width, mode, fit]);
  const [box, setBox] = useState(initial);
  const latest = useRef(box);
  latest.current = box;
  const [layer, setLayer] = useState(claimOverlayLayer);
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    box: Box;
    resize: boolean;
  } | null>(null);
  const finish = useCallback(() => {
    const pointer = gesture.current?.pointerId;
    gesture.current = null;
    if (pointer !== undefined && card.current?.hasPointerCapture(pointer))
      card.current.releasePointerCapture(pointer);
  }, []);
  useEffect(() => {
    if (active) setLayer(claimOverlayLayer());
    else finish();
    return finish;
  }, [active, finish]);
  const place = useCallback(() => {
    setBox((current) => {
      let next = fit(current);
      if (mode === 'anchored') {
        const target = anchor?.isConnected ? anchor : null;
        const size = viewport();
        if (!target)
          next = fit({
            ...next,
            x: size.width - next.width - 16,
            y: size.height - next.height - 64,
          });
        else {
          const rect = target.getBoundingClientRect();
          const x =
            rect.right + next.width + 8 <= size.width ? rect.right + 8 : rect.left - next.width - 8;
          const y =
            rect.bottom + next.height + 8 <= size.height
              ? rect.bottom + 8
              : rect.bottom - next.height;
          next = fit({ ...next, x, y });
        }
      }
      return next.x === current.x &&
        next.y === current.y &&
        next.width === current.width &&
        next.height === current.height
        ? current
        : next;
    });
  }, [anchor, mode, fit, viewport]);
  useLayoutEffect(() => {
    if (!active) return;
    place();
    view?.addEventListener('resize', place);
    if (mode === 'anchored') document.addEventListener('scroll', place, true);
    const observer = mode === 'anchored' ? new MutationObserver(place) : null;
    for (
      let element = anchor;
      element && element !== document.body;
      element = element.parentElement
    )
      observer?.observe(element, { attributes: true, attributeFilter: ['style', 'class'] });
    return () => {
      view?.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
      observer?.disconnect();
    };
  }, [active, place, view, mode, document, anchor]);
  useEffect(() => {
    if (!active || mode !== 'anchored' || !onClose) return;
    const outside = (event: globalThis.PointerEvent) => {
      const target = event.target as Node | null;
      if (
        !target ||
        card.current?.contains(target) ||
        anchor?.contains(target) ||
        hasActiveModal(document)
      )
        return;
      if (
        target instanceof Element &&
        target.closest('.weq-dialog-layer, .weq-overlay-layer, .weq-window-layer')
      )
        return;
      onClose();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [active, mode, onClose, anchor, document]);
  useSurfaceEscape(card, onClose, active, false);
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (!active || !event.currentTarget.contains(event.target as Node)) return;
    setLayer(claimOverlayLayer());
    if (mode !== 'floating' || event.button !== 0 || !(event.target instanceof Element)) return;
    const resize = Boolean(event.target.closest('[data-window-resize]'));
    const handle = event.target.closest('[data-window-drag-handle]');
    if (
      !resize &&
      (!handle ||
        event.target.closest('button, input, select, textarea, a, [contenteditable="true"]'))
    )
      return;
    event.preventDefault();
    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      box: { ...latest.current },
      resize,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x,
      dy = event.clientY - current.y;
    setBox(
      fit(
        current.resize
          ? { ...current.box, width: current.box.width + dx, height: current.box.height + dy }
          : { ...current.box, x: current.box.x + dx, y: current.box.y + dy },
      ),
    );
  };
  return createPortal(
    <div
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
        className={`weq-window-surface is-${mode}${className ? ` ${className}` : ''}`}
        style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
        onPointerDownCapture={start}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onFocusCapture={(event) => {
          if (event.currentTarget.contains(event.target as Node)) setLayer(claimOverlayLayer());
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
        <div className="weq-window-content">{children}</div>
        {mode === 'floating' ? (
          <button
            type="button"
            className="weq-window-resize"
            data-window-resize
            title="调整窗口大小"
            aria-label="调整窗口大小"
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
              const step = event.shiftKey ? 64 : 16;
              setBox((current) =>
                fit({
                  ...current,
                  width:
                    current.width +
                    (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
                  height:
                    current.height +
                    (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0),
                }),
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
