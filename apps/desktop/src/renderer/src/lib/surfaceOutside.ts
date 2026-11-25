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
    document.removeEventListener('pointerdown', cleanup, true);
    document.defaultView?.clearTimeout(timer);
  };
  const timer = document.defaultView?.setTimeout(cleanup, 1000);
  document.addEventListener('click', consumeClick, true);
  // WebKit 可能因 preventDefault 取消尾随 click；新的按下不属于上次手势。
  document.addEventListener('pointerdown', cleanup, true);
}

export function useSurfaceOutside(
  ref: RefObject<HTMLElement | null>,
  onClose: (() => void) | undefined,
  active: boolean,
  {
    scrim = false,
    anchor,
    ignorePress,
    consume = true,
    secondaryPress = false,
  }: {
    scrim?: boolean;
    anchor?: HTMLElement | null;
    ignorePress?: (event: PointerEvent, target: Node) => boolean;
    consume?: boolean;
    secondaryPress?: boolean;
  } = {},
) {
  useEffect(() => {
    const element = ref.current;
    if (!active || !element || !onClose) return;
    const document = element.ownerDocument;
    const outside = (event: PointerEvent) => {
      const switchingMenu = secondaryPress && event.button === 2;
      if ((event.button > 0 && !switchingMenu) || event.defaultPrevented) return;
      // 仅声明 Esc 优先级的子菜单不改变原有指针关闭归属。
      if (!eventSurfaces.has(event)) eventSurfaces.set(event, topSurface(document, false));
      if (eventSurfaces.get(event) !== surfaceRoot(element, false)) return;
      const target = event.target as Node | null;
      if (!target || anchor?.contains(target) || ignorePress?.(event, target)) return;
      // 横幅在应用浮层之上，关闭、复制或返回来源都由横幅自己处理。
      if (target.nodeType === 1 && (target as Element).closest('.weq-toast-host')) return;
      if (element.contains(target) && (!scrim || target !== element)) return;
      if (consume && !switchingMenu) consumeOutsidePress(document, event);
      onClose();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [ref, onClose, active, scrim, anchor, ignorePress, consume, secondaryPress]);
}
