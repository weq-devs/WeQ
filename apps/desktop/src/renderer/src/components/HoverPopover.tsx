import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayAnchor } from '../lib/overlayAnchor';
import { useOverlayLayer } from '../lib/overlayStack';
import { useRenderDocument } from '../lib/renderDocument';
import '../styles/qzone-actions.css';

export function HoverPopover({
  trigger,
  children,
  label = '点赞列表',
  keepMounted = false,
  classPrefix = 'weq-qzn-like',
}: {
  trigger: ReactNode | ((open: boolean) => ReactNode);
  children?: ReactNode | ((open: boolean) => ReactNode);
  label?: string;
  keepMounted?: boolean;
  classPrefix?: string;
}) {
  const document = useRenderDocument();
  const anchor = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const placement = useOverlayAnchor(layer, open, true, anchor.current);
  const zIndex = useOverlayLayer(open);
  const cancelClose = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  };
  const show = () => {
    cancelClose();
    setOpen(true);
  };
  const leave = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };
  const blur = (target: EventTarget | null) => {
    const NodeType = document.defaultView?.Node;
    if (
      NodeType &&
      target instanceof NodeType &&
      (anchor.current?.contains(target) || layer.current?.contains(target))
    )
      return;
    cancelClose();
    setOpen(false);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        clearTimeout(closeTimer.current);
        setOpen(false);
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
        setOpen(false);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', close);
      document.removeEventListener('pointerdown', outside);
    };
  }, [open, document]);
  return (
    <>
      <div
        ref={anchor}
        className={`${classPrefix}-hover`}
        onMouseEnter={show}
        onMouseLeave={leave}
        onFocus={show}
        onClick={show}
        onBlur={(event) => blur(event.relatedTarget)}
        onKeyDown={(event) => {
          if (open && event.key === 'Tab' && !event.shiftKey) {
            const first = layer.current?.querySelector<HTMLElement>(
              'button, a[href], [tabindex="0"]',
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
                onMouseLeave={leave}
                onFocus={cancelClose}
                onBlur={(event) => blur(event.relatedTarget)}
              >
                {typeof children === 'function' ? children(open) : children}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
