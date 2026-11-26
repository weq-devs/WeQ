// @ts-nocheck
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { reactionItems } from '../../lib/reactionItems';
import { trpc } from '../../trpc/client';
import { cn } from './classNames';

export function ReactionPicker({
  anchor,
  onSelect,
  onClose,
  selectedCodes = [],
  originElement,
}: {
  anchor: { x: number; y: number };
  /** 选中一枚表情，参数是可直接交给 0x9082 的 code。 */
  onSelect: (code: string) => void;
  onClose: () => void;
  selectedCodes?: readonly string[];
  originElement?: HTMLElement | null;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const catalog = trpc.account.emojiPanel.catalog.useQuery(undefined, { staleTime: 30_000 });
  const faces = catalog.data?.faces;
  const cells = useMemo(() => reactionItems(faces ?? []), [faces]);

  useLayoutEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
    return () =>
      queueMicrotask(() => {
        if (document.activeElement === document.body && originElement?.isConnected)
          originElement.focus({ preventScroll: true });
      });
  }, [originElement]);
  useEffect(() => {
    if (document.activeElement === panelRef.current)
      panelRef.current
        ?.querySelector<HTMLButtonElement>('[aria-pressed="true"], button')
        ?.focus({ preventScroll: true });
  }, [cells.length]);

  // 同款 fixed 定位钳制。
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    el.style.left = `${Math.min(
      Math.max(anchor.x, margin),
      Math.max(margin, window.innerWidth - rect.width - margin),
    )}px`;
    el.style.top = `${Math.min(
      Math.max(anchor.y, margin),
      Math.max(margin, window.innerHeight - rect.height - margin),
    )}px`;
  }, [anchor.x, anchor.y, cells.length]);

  useEffect(() => {
    function closeFromOutside(event: globalThis.PointerEvent) {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      onClose();
    }
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('pointerdown', closeFromOutside, true);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeFromOutside, true);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      className={cn('reaction-picker')}
      style={{ left: anchor.x, top: anchor.y }}
      role="dialog"
      tabIndex={-1}
      aria-label="贴表情"
      data-hover-delay="0"
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className={cn('reaction-picker-head')}>贴表情</div>
      <div className={cn('reaction-picker-body')}>
        {catalog.isLoading && cells.length === 0 ? (
          <div className={cn('emoji-state')}>加载中…</div>
        ) : cells.length === 0 ? (
          <div className={cn('emoji-state')}>没有可用的表情</div>
        ) : (
          <div className={cn('reaction-picker-grid')}>
            {cells.map((cell) => (
              <button
                key={cell.code}
                type="button"
                title={cell.title}
                aria-label={cell.title}
                aria-pressed={selectedCodes.includes(cell.code)}
                className={cn('reaction-picker-cell')}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(cell.code)}
              >
                {cell.item.glyph ? (
                  <span className={cn('reaction-picker-glyph')}>{cell.item.glyph}</span>
                ) : (
                  <img src={cell.item.src ?? undefined} alt="" draggable={false} />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
