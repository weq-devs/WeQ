import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ProfilePoint } from '../lib/profileCardMotion';
import { visibleViewport } from '../lib/visibleViewport';
import { OverlayLayer } from './OverlayLayer';
import '../styles/contact-card.css';

/** 加载中和正式名片按同一套尺寸与点击坐标定位。 */
export function MemberProfileCardFrame({
  anchor,
  onClose,
  loading = false,
  previewing = false,
  children,
}: {
  anchor: ProfilePoint;
  onClose: () => void;
  loading?: boolean;
  previewing?: boolean;
  children: ReactNode;
}) {
  const card = useRef<HTMLElement>(null);
  const [position, setPosition] = useState({
    left: 10,
    top: 10,
    maxWidth: 'calc(100vw - 24px)',
    maxHeight: 'min(calc(100dvh - 24px), 720px)',
  });
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const view = element.ownerDocument.defaultView;
    const place = () => {
      const viewport = visibleViewport(view);
      const maxWidth = Math.max(1, viewport.width - 24);
      const bottom = viewport.top + viewport.height - 12;
      // 先给正文留出可滚动的空间，避免资料补齐后因卡片长高而把上沿推走。
      const room = Math.min(320, Math.max(1, viewport.height - 24));
      const width = element.offsetWidth;
      const left = Math.max(
        viewport.left + 10,
        Math.min(
          anchor.x + 14 + width > viewport.left + viewport.width - 10
            ? anchor.x - width - 14
            : anchor.x + 14,
          viewport.left + viewport.width - width - 10,
        ),
      );
      const top = Math.max(viewport.top + 10, Math.min(anchor.y + 8, bottom - room));
      const maxHeight = Math.max(1, Math.min(720, bottom - top));
      const next = { left, top, maxWidth: `${maxWidth}px`, maxHeight: `${maxHeight}px` };
      setPosition((previous) =>
        previous.left === left &&
        previous.top === top &&
        previous.maxWidth === next.maxWidth &&
        previous.maxHeight === next.maxHeight
          ? previous
          : next,
      );
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(element);
    view?.addEventListener('resize', place);
    view?.visualViewport?.addEventListener('resize', place);
    view?.visualViewport?.addEventListener('scroll', place);
    return () => {
      observer?.disconnect();
      view?.removeEventListener('resize', place);
      view?.visualViewport?.removeEventListener('resize', place);
      view?.visualViewport?.removeEventListener('scroll', place);
    };
  }, [anchor.x, anchor.y]);
  return (
    <OverlayLayer
      profileCard={!loading}
      profileTrigger={anchor.trigger}
      presentation="popover"
      className="weq-member-pop-scrim"
      onClose={onClose}
    >
      <section
        ref={card}
        className={`weq-member-pop weq-contact-card${previewing ? ' is-previewing-chat' : ''}`}
        role="dialog"
        aria-label="用户资料"
        aria-busy={loading || undefined}
        style={{ position: 'fixed', ...position }}
      >
        {children}
      </section>
    </OverlayLayer>
  );
}
