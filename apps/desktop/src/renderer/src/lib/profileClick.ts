import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import {
  dismissProfileCard,
  ownsProfileCard,
  previewProfileCardDismissal,
} from './profileCardMotion';
import { POKE_PRESS_MS, pressProfileAvatar, profileAvatarAtClick } from './profilePokeMotion';
import { topSurface } from './surfaceEscape';

const PROFILE_DOUBLE_CLICK_MS = 300;
const MOUSE_RADIUS = 4;
const TOUCH_RADIUS = 16;

export type ProfileShortcut = {
  landscape?: () => void;
  portrait?: () => void;
};

const pendingClicks = new WeakMap<Document, () => void>();
const touchReleases = new WeakMap<
  Document,
  Pick<PointerEvent, 'clientX' | 'clientY' | 'timeStamp'>
>();

export function trackProfileTouch(document: Document) {
  const remember = (event: PointerEvent) => {
    if (event.isTrusted && event.isPrimary && event.pointerType === 'touch')
      touchReleases.set(document, {
        clientX: event.clientX,
        clientY: event.clientY,
        timeStamp: event.timeStamp,
      });
    else touchReleases.delete(document);
  };
  document.addEventListener('pointerup', remember, { capture: true, passive: true });
  return () => {
    document.removeEventListener('pointerup', remember, true);
    touchReleases.delete(document);
    pendingClicks.get(document)?.();
  };
}

function plainPrimaryClick(event: MouseEvent) {
  return (
    event.isTrusted &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

function clickPointer(event: MouseEvent, document: Document, view: Window) {
  // WebKit can synthesize a click with pointerType="mouse" for a finger tap.
  const touch = touchReleases.get(document);
  if (
    touch &&
    event.timeStamp >= touch.timeStamp &&
    event.timeStamp - touch.timeStamp <= PROFILE_DOUBLE_CLICK_MS &&
    Math.hypot(event.clientX - touch.clientX, event.clientY - touch.clientY) <= MOUSE_RADIUS
  )
    return 'touch';
  if ('pointerType' in event && event.pointerType) return event.pointerType;
  return view.matchMedia('(any-hover: hover)').matches ? 'mouse' : undefined;
}

export function activateProfile(
  event: ReactMouseEvent<Element> | ReactKeyboardEvent<Element>,
  openProfile: () => void,
  shortcut?: ProfileShortcut,
) {
  const document = event.currentTarget.ownerDocument;
  pendingClicks.get(document)?.();
  const view = document.defaultView;
  const previous = topSurface(document, false);
  const click = 'key' in event ? undefined : event;
  const closesCard = previous && ownsProfileCard(previous, event.currentTarget, click?.nativeEvent);
  if (view && click && click.detail > 0 && plainPrimaryClick(click.nativeEvent)) {
    const pointer = clickPointer(click.nativeEvent, document, view);
    const landscape = view.matchMedia('(orientation: landscape)').matches;
    const action = landscape ? shortcut?.landscape : shortcut?.portrait;
    // 次数由 WeQ 自己的时间窗决定，鼠标 click.detail 仍可能包含更早的点击。
    if ((action || closesCard) && (pointer === 'touch' || pointer === 'mouse')) {
      const newCard = () => {
        const current = topSurface(document, false);
        return current !== previous ? current : undefined;
      };
      const avatar =
        !landscape && action ? profileAvatarAtClick(event.currentTarget, event.target) : undefined;
      captureSecondClick(
        view,
        document,
        click,
        pointer,
        () => {
          const current = action && !closesCard ? newCard() : undefined;
          if (current) dismissProfileCard(current);
          action?.();
        },
        avatar
          ? () => {
              if (!avatar.isConnected) return;
              const reducedMotion = view.matchMedia('(prefers-reduced-motion: reduce)').matches;
              const finishAvatar = pressProfileAvatar(avatar, reducedMotion);
              const current = !reducedMotion && !closesCard ? newCard() : undefined;
              const fade = current
                ? previewProfileCardDismissal(current, POKE_PRESS_MS, PROFILE_DOUBLE_CLICK_MS)
                : undefined;
              return (confirmed) => {
                if (!confirmed) fade?.cancel();
                finishAvatar(confirmed);
              };
            }
          : undefined,
      );
    }
  }
  if (closesCard) dismissProfileCard(previous);
  else openProfile();
}

/** 首击可能换页、卸载菜单或用名片盖住入口。第二击仍以首击的坐标和动作识别。 */
function captureSecondClick(
  view: Window,
  document: Document,
  first: ReactMouseEvent,
  pointer: 'mouse' | 'touch',
  action: () => void,
  onPress?: () => ((confirmed: boolean) => void) | undefined,
) {
  const x = first.clientX;
  const y = first.clientY;
  const bounds = pointer === 'touch' ? first.currentTarget.getBoundingClientRect() : undefined;
  const nearFirst = ({ clientX, clientY }: MouseEvent) =>
    Math.hypot(clientX - x, clientY - y) <= (bounds ? TOUCH_RADIUS : MOUSE_RADIUS) &&
    (!bounds ||
      (clientX >= bounds.left &&
        clientX <= bounds.right &&
        clientY >= bounds.top &&
        clientY <= bounds.bottom));
  const listeners = new AbortController();
  const capture = { capture: true, signal: listeners.signal };
  let timer = view.setTimeout(cancel, PROFILE_DOUBLE_CLICK_MS);
  let pressed: PointerEvent | undefined;
  let finishPress: ((confirmed: boolean) => void) | undefined;

  function stopListening() {
    view.clearTimeout(timer);
    listeners.abort();
    pendingClicks.delete(document);
  }

  function cancel() {
    stopListening();
    finishPress?.(false);
  }

  pendingClicks.set(document, cancel);
  view.addEventListener(
    'pointerdown',
    (event) => {
      if (
        pressed ||
        event.timeStamp - first.timeStamp > PROFILE_DOUBLE_CLICK_MS ||
        !event.isPrimary ||
        event.pointerType !== pointer ||
        !plainPrimaryClick(event) ||
        !nearFirst(event)
      ) {
        cancel();
        return;
      }
      pressed = event;
      view.clearTimeout(timer);
      timer = view.setTimeout(cancel, PROFILE_DOUBLE_CLICK_MS);
      finishPress = onPress?.();
      // 早于浮层的外部按下处理，保留这次手势的原生 click。
      event.stopImmediatePropagation();
    },
    capture,
  );
  view.addEventListener(
    'click',
    (event) => {
      if (
        !pressed ||
        event.timeStamp - pressed.timeStamp > PROFILE_DOUBLE_CLICK_MS ||
        event.detail === 0 ||
        !plainPrimaryClick(event) ||
        clickPointer(event, document, view) !== pointer ||
        !nearFirst(event)
      ) {
        cancel();
        return;
      }
      stopListening();
      event.preventDefault();
      event.stopImmediatePropagation();
      finishPress?.(true);
      action();
    },
    capture,
  );
  view.addEventListener(
    'pointermove',
    (event) => {
      if (pressed && !nearFirst(event)) cancel();
    },
    capture,
  );
  view.addEventListener('pointercancel', cancel, capture);
  view.addEventListener('contextmenu', cancel, capture);
  view.addEventListener('keydown', cancel, capture);
  view.addEventListener('wheel', cancel, capture);
  view.addEventListener('blur', cancel, { signal: listeners.signal });
  view.addEventListener('resize', cancel, { signal: listeners.signal });
}
