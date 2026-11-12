import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useOverlayLayer } from '../lib/overlayStack';
import { topSurface, useSurfaceEscape } from '../lib/surfaceEscape';
import { useViewState } from '../state/view';
import { useRenderDocument } from '../lib/renderDocument';
import '../styles/unified-media-preview.css';

const ownershipEvent = 'weq-media-preview-open';

/** 所有媒体预览共用同一文档的占用权，业务对话框仍可正常叠在预览之上。 */
export function MediaPreviewShell({
  children,
  title,
  ariaLabel = title,
  count,
  onClose,
  ownerDocument: suppliedDocument,
  active = true,
  onKeyDown,
  onBackdrop,
  onWheelAt,
  onEscape = onClose,
  footer,
  className = '',
}: {
  children: ReactNode;
  title: string;
  ariaLabel?: string;
  count?: ReactNode;
  onClose: () => void;
  ownerDocument?: Document;
  active?: boolean;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onBackdrop?: (side: 'left' | 'right') => void;
  onWheelAt?: (x: number, y: number, delta: number) => void;
  onEscape?: () => void;
  footer?: ReactNode;
  className?: string;
}) {
  const contextDocument = useRenderDocument();
  const ownerDocument = suppliedDocument ?? contextDocument;
  const root = useMemo(() => ({ current: null as HTMLDivElement | null }), [ownerDocument]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const account = useViewState((state) => state.openedUin);
  const previousAccount = useRef(account);
  useEffect(() => {
    if (previousAccount.current !== account) {
      previousAccount.current = account;
      closeRef.current();
    }
  }, [account]);
  const layer = useOverlayLayer(active);
  useEffect(() => {
    const element = root.current;
    if (!active || !element || !onWheelAt) return;
    const wheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.closest(
          '.weq-lightbox-frame, video, .weq-preview-header, .weq-preview-footer, .weq-ocr-panel',
        )
      )
        return;
      event.preventDefault();
      onWheelAt(event.clientX, event.clientY, event.deltaY);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [active, root, onWheelAt]);
  useSurfaceEscape(root, onEscape, active, true);
  useLayoutEffect(() => {
    if (!active) return;
    // portal 首次绘制即避让系统窗口控件，不等待下一帧的 DOM 观察回调。
    if (ownerDocument.defaultView?.weqRemoteWindowLayout)
      ownerDocument.defaultView.dispatchEvent(new Event('weq-remote-window-layout'));
    const element = root.current;
    const claim = new CustomEvent(ownershipEvent, {
      detail: element,
    });
    ownerDocument.dispatchEvent(claim);
    const opened = (event: Event) => {
      if ((event as CustomEvent).detail !== element) closeRef.current();
    };
    ownerDocument.addEventListener(ownershipEvent, opened);
    return () => ownerDocument.removeEventListener(ownershipEvent, opened);
  }, [active, ownerDocument, root]);
  // 捕获阶段处理原生媒体控件上的 Esc，同时遵循最上层业务弹窗。
  useLayoutEffect(() => {
    if (!active) return;
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        topSurface(ownerDocument) !== root.current
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onEscape();
    };
    ownerDocument.addEventListener('keydown', handleEscape, true);
    return () => ownerDocument.removeEventListener('keydown', handleEscape, true);
  }, [active, ownerDocument, onEscape, root]);
  useLayoutEffect(() => {
    const viewport = ownerDocument.defaultView;
    const close = () => closeRef.current();
    viewport?.addEventListener('pagehide', close);
    return () => viewport?.removeEventListener('pagehide', close);
  }, [ownerDocument]);
  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={-1}
      hidden={!active}
      className={`weq-lightbox-layer weq-unified-preview ${className}`}
      style={{ zIndex: layer, display: active ? undefined : 'none' }}
      onKeyDown={onKeyDown}
    >
      <header className="weq-preview-header">
        <span className="weq-preview-title" title={title}>
          {title}
        </span>
        <span className="weq-preview-count" aria-live="polite">
          {count}
        </span>
        <button
          type="button"
          className="weq-lightbox-close"
          aria-label="关闭预览"
          title="关闭预览"
          onClick={onClose}
        >
          <X size={22} />
        </button>
      </header>
      <div
        className="weq-preview-viewport"
        onMouseDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          onBackdrop?.(event.clientX < bounds.left + bounds.width / 2 ? 'left' : 'right');
        }}
      >
        {children}
      </div>
      {footer && <footer className="weq-preview-footer">{footer}</footer>}
    </div>,
    ownerDocument.body,
  );
}
