import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayAnchor } from '../lib/overlayAnchor';
import { useOverlayLayer } from '../lib/overlayStack';
import { useRenderDocument } from '../lib/renderDocument';
import '../styles/qzone-actions.css';

export function QzoneLikesPopover({
  trigger,
  children,
}: {
  trigger: ReactNode;
  children?: ReactNode;
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
        className="weq-qzn-like-hover"
        onMouseEnter={show}
        onMouseLeave={leave}
        onFocus={show}
        onBlur={(event) => blur(event.relatedTarget)}
      >
        {trigger}
      </div>
      {open
        ? createPortal(
            <div
              ref={layer}
              className="weq-qzn-like-layer"
              style={{ ...placement.position, zIndex }}
            >
              <div
                className="weq-qzn-like-popover"
                role="region"
                aria-label="点赞列表"
                onMouseEnter={cancelClose}
                onMouseLeave={leave}
                onFocus={cancelClose}
                onBlur={(event) => blur(event.relatedTarget)}
              >
                {children}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
