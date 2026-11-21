import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent } from 'react';

const PROFILE_DOUBLE_CLICK_MS = 300;

type PendingClick = {
  anchor: Element;
  identity?: string;
  finish: (open: boolean) => void;
};

const pendingClicks = new WeakMap<Document, PendingClick>();

/** 等待第二次点击，避免首击打开的浮层或页面切换移走目标。 */
export function activateProfile(
  event: MouseEvent<Element> | ReactKeyboardEvent<Element>,
  openProfile: () => void,
  openChat?: () => void,
  identity?: string,
) {
  const anchor = event.currentTarget;
  const document = anchor.ownerDocument;
  const pending = pendingClicks.get(document);
  const nativeEvent = event.nativeEvent;
  const pointerType = 'pointerType' in nativeEvent ? nativeEvent.pointerType : '';
  const mouse =
    pointerType === 'mouse' ||
    (!pointerType && document.defaultView?.matchMedia('(any-hover: hover)').matches);
  if (
    !openChat ||
    'key' in event ||
    !mouse ||
    event.detail === 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    pending?.finish(false);
    openProfile();
    return;
  }
  const sameTarget = pending?.anchor === anchor && pending.identity === identity;
  pending?.finish(false);
  if (sameTarget && event.detail > 1) {
    event.preventDefault();
    openChat();
    return;
  }
  if (!pending && event.detail > 1) return;

  const cancelOutside = (event: PointerEvent) => {
    if (!event.composedPath().includes(anchor)) finish(false);
  };
  const cancelOnKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' || event.key === 'Tab') finish(false);
  };
  const finish = (open: boolean) => {
    clearTimeout(timer);
    document.removeEventListener('pointerdown', cancelOutside, true);
    document.removeEventListener('keydown', cancelOnKey, true);
    pendingClicks.delete(document);
    if (open && anchor.isConnected) openProfile();
  };
  const timer = setTimeout(() => finish(true), PROFILE_DOUBLE_CLICK_MS);
  pendingClicks.set(document, { anchor, identity, finish });
  document.addEventListener('pointerdown', cancelOutside, true);
  document.addEventListener('keydown', cancelOnKey, true);
}
