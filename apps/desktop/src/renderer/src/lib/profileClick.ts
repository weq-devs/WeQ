import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';

const PROFILE_DOUBLE_CLICK_MS = 300;
const PROFILE_DOUBLE_CLICK_RADIUS = 4;

export type ProfileShortcut = {
  landscape?: () => void;
  portrait?: () => void;
};

const pendingClicks = new WeakMap<Document, () => void>();

function plainMouseClick(event: MouseEvent, view: Window) {
  return (
    event.isTrusted &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    ('pointerType' in event && event.pointerType
      ? event.pointerType === 'mouse'
      : view.matchMedia('(any-hover: hover)').matches)
  );
}

export function activateProfile(
  event: ReactMouseEvent<Element> | ReactKeyboardEvent<Element>,
  openProfile: () => void,
  shortcut?: ProfileShortcut,
) {
  const document = event.currentTarget.ownerDocument;
  pendingClicks.get(document)?.();
  const view = document.defaultView;
  if (view && !('key' in event) && event.detail === 1 && plainMouseClick(event.nativeEvent, view)) {
    const action = view.matchMedia('(orientation: landscape)').matches
      ? shortcut?.landscape
      : shortcut?.portrait;
    if (action) captureSecondClick(view, document, event, action);
  }
  openProfile();
}

/** 首击可能换页、卸载菜单或用名片盖住入口。第二击仍以首击的坐标和动作识别。 */
function captureSecondClick(
  view: Window,
  document: Document,
  first: ReactMouseEvent,
  action: () => void,
) {
  const x = first.clientX;
  const y = first.clientY;
  const nearFirst = (event: MouseEvent) =>
    Math.hypot(event.clientX - x, event.clientY - y) <= PROFILE_DOUBLE_CLICK_RADIUS;
  const listeners = new AbortController();
  const capture = { capture: true, signal: listeners.signal };
  let timer = view.setTimeout(cancel, PROFILE_DOUBLE_CLICK_MS);
  let pressedAt: number | undefined;

  function cancel() {
    view.clearTimeout(timer);
    listeners.abort();
    pendingClicks.delete(document);
  }

  pendingClicks.set(document, cancel);
  view.addEventListener(
    'pointerdown',
    (event) => {
      if (
        pressedAt !== undefined ||
        event.timeStamp - first.timeStamp > PROFILE_DOUBLE_CLICK_MS ||
        !plainMouseClick(event, view) ||
        !nearFirst(event)
      ) {
        cancel();
        return;
      }
      pressedAt = event.timeStamp;
      view.clearTimeout(timer);
      timer = view.setTimeout(cancel, PROFILE_DOUBLE_CLICK_MS);
      // 早于浮层的外部按下处理，保留这次手势的原生 click。
      event.stopImmediatePropagation();
    },
    capture,
  );
  view.addEventListener(
    'click',
    (event) => {
      cancel();
      if (
        pressedAt === undefined ||
        event.timeStamp - pressedAt > PROFILE_DOUBLE_CLICK_MS ||
        event.detail === 0 ||
        !plainMouseClick(event, view) ||
        !nearFirst(event)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      action();
    },
    capture,
  );
  view.addEventListener(
    'pointermove',
    (event) => {
      if (pressedAt !== undefined && !nearFirst(event)) cancel();
    },
    capture,
  );
  view.addEventListener('pointercancel', cancel, capture);
  view.addEventListener('keydown', cancel, capture);
  view.addEventListener('wheel', cancel, capture);
  view.addEventListener('blur', cancel, { signal: listeners.signal });
  view.addEventListener('resize', cancel, { signal: listeners.signal });
}
