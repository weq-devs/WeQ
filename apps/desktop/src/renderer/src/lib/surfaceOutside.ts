import { useEffect, type RefObject } from 'react';
import { surfaceRoot, topSurface } from './surfaceEscape';

// 同一次按下使用同一份层级快照，避免上层卸载后又关闭下一层。
const eventSurfaces = new WeakMap<Event, HTMLElement | undefined>();

function consumeOutsidePress(document: Document, event: PointerEvent) {
  event.preventDefault();
  event.stopImmediatePropagation();
  // 关闭时卡片可能立刻卸载，后续 click 不能落到背后的导航或危险按钮上。
  const consumeClick = (click: MouseEvent) => {
    click.preventDefault();
    click.stopImmediatePropagation();
    cleanup();
  };
  const cleanup = () => {
    document.removeEventListener('click', consumeClick, true);
    document.defaultView?.clearTimeout(timer);
  };
  const timer = document.defaultView?.setTimeout(cleanup, 1000);
  document.addEventListener('click', consumeClick, true);
}

export function useSurfaceOutside(
  ref: RefObject<HTMLElement | null>,
  onClose: (() => void) | undefined,
  active: boolean,
  { scrim = false, anchor }: { scrim?: boolean; anchor?: HTMLElement | null } = {},
) {
  useEffect(() => {
    const element = ref.current;
    if (!active || !element || !onClose) return;
    const document = element.ownerDocument;
    const outside = (event: PointerEvent) => {
      if (event.button > 0 || event.defaultPrevented) return;
      if (!eventSurfaces.has(event)) eventSurfaces.set(event, topSurface(document));
      if (eventSurfaces.get(event) !== surfaceRoot(element)) return;
      const target = event.target as Node | null;
      if (!target || anchor?.contains(target)) return;
      if (element.contains(target) && (!scrim || target !== element)) return;
      consumeOutsidePress(document, event);
      onClose();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [ref, onClose, active, scrim, anchor]);
}
