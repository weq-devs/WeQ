import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayAnchor } from '../lib/overlayAnchor.shared';
import { useOverlayLayer } from '../lib/overlayStack';
import { useRenderDocument } from '../lib/renderDocument';
import '../styles/qzone-actions.css';

export function HoverPopover({
  trigger,
  children,
  label = '点赞列表',
  keepMounted = false,
  classPrefix = 'weq-qzn-like',
  clickOnly = false,
  contextMenu = false,
}: {
  trigger: ReactNode | ((open: boolean) => ReactNode);
  children?: ReactNode | ((open: boolean, close: () => void) => ReactNode);
  label?: string;
  keepMounted?: boolean;
  classPrefix?: string;
  clickOnly?: boolean;
  contextMenu?: boolean;
}) {
  const document = useRenderDocument();
  const anchor = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<'hover' | 'contextmenu' | null>(null);
  const open = mode !== null;
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const placement = useOverlayAnchor(layer, open, true, anchor.current);
  const zIndex = useOverlayLayer(open);
  const cancelClose = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  };
  const show = () => {
    cancelClose();
    setMode((current) => current ?? 'hover');
  };
  const leave = () => {
    cancelClose();
    closeTimer.current = setTimeout(
      () => setMode((current) => (current === 'hover' ? null : current)),
      120,
    );
  };
  const dismiss = () => {
    cancelClose();
    setMode(null);
  };
  const dismissFromLayer = () => {
    if (layer.current?.contains(document.activeElement)) {
      anchor.current?.querySelector<HTMLElement>('button')?.focus();
    }
    dismiss();
  };
  const blur = (target: EventTarget | null) => {
    // 触屏点名单时，部分浏览器会让原按钮失焦，但不给 relatedTarget。
    if (!target && mode === 'contextmenu') return;
    const NodeType = document.defaultView?.Node;
    if (
      NodeType &&
      target instanceof NodeType &&
      (anchor.current?.contains(target) || layer.current?.contains(target))
    )
      return;
    dismiss();
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        clearTimeout(closeTimer.current);
        if (
          (clickOnly || mode === 'contextmenu') &&
          layer.current?.contains(document.activeElement)
        ) {
          anchor.current?.querySelector<HTMLElement>('button')?.focus();
        }
        setMode(null);
      }
    };
    const outside = (event: PointerEvent) => {
      const NodeType = document.defaultView?.Node;
      if (
        NodeType &&
        event.target instanceof NodeType &&
        !anchor.current?.contains(event.target) &&
        !layer.current?.contains(event.target)
      )
        setMode(null);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', close);
      document.removeEventListener('pointerdown', outside);
    };
  }, [open, document, clickOnly, mode]);
  return (
    <>
      <div
        ref={anchor}
        className={`${classPrefix}-hover`}
        data-weq-touch-context={contextMenu || undefined}
        onMouseEnter={clickOnly ? undefined : show}
        onMouseLeave={clickOnly ? undefined : leave}
        onFocus={clickOnly ? undefined : show}
        onClick={clickOnly ? (open ? dismiss : show) : show}
        onContextMenu={
          contextMenu
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                cancelClose();
                setMode('contextmenu');
              }
            : undefined
        }
        onBlur={(event) => blur(event.relatedTarget)}
        onKeyDown={(event) => {
          if (open && event.key === 'Tab' && !event.shiftKey) {
            const first = layer.current?.querySelector<HTMLElement>(
              'button:not(:disabled), a[href], [tabindex="0"]',
            );
            if (first) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        {typeof trigger === 'function' ? trigger(open) : trigger}
      </div>
      {open || keepMounted
        ? createPortal(
            <div
              ref={layer}
              className={`${classPrefix}-layer`}
              data-weq-surface
              hidden={!open}
              style={{ ...placement.position, zIndex }}
            >
              <div
                className={`${classPrefix}-popover`}
                role="region"
                aria-label={label}
                onMouseEnter={cancelClose}
                onMouseLeave={clickOnly ? undefined : leave}
                onFocus={cancelClose}
                onBlur={(event) => blur(event.relatedTarget)}
              >
                {typeof children === 'function' ? children(open, dismissFromLayer) : children}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
