import type { ForceClickBridge, ForceClickRequest } from '../../../shared/force_click';

const CONTROL = [
  '[data-weq-force-click]',
  'button',
  'a',
  'input',
  'textarea',
  'select',
  'summary',
  'label',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="link"]',
  '[tabindex]:not([tabindex="-1"])',
  '[data-windowed-scrollbar]',
  '[data-load-action]',
  'audio',
  'video',
].join(',');
const MESSAGE = '.weq-message-selectable[data-message-id]';

type Gesture = {
  kind: 'profile' | 'conversation' | 'message';
  target: Element;
  handled: boolean;
};

// Reuse existing React click handlers with a gesture only this module can create.
const gestures = new WeakMap<Event, Gesture>();

export function isForceClick(event: Event) {
  return gestures.has(event);
}

export function runForceClick(
  event: Event,
  kind: Gesture['kind'],
  action: (target: Element) => boolean,
) {
  const gesture = gestures.get(event);
  if (gesture?.kind !== kind) return false;
  if (!gesture.handled) gesture.handled = action(gesture.target);
  return true;
}

function hitsSelectableText(document: Document, request: ForceClickRequest) {
  const range = document.caretRangeFromPoint?.(request.x, request.y);
  const text = range?.startContainer;
  if (!range || !(text instanceof Text) || !text.parentElement) return false;
  if (getComputedStyle(text.parentElement).userSelect === 'none') return false;
  // The caret sits between characters. Test the glyphs on both sides so whitespace
  // in the same row can still open details while text keeps macOS Look Up.
  const offset = range.startOffset;
  return [offset, offset - 1].some((index) => {
    if (index < 0 || !text.data[index]?.trim()) return false;
    range.setStart(text, index);
    range.setEnd(text, index + 1);
    return Array.from(range.getClientRects()).some(
      ({ left, top, right, bottom }) =>
        request.x >= left && request.x <= right && request.y >= top && request.y <= bottom,
    );
  });
}

export function installForceClick(view: Window, subscribe: ForceClickBridge) {
  const document = view.document;
  const listeners = new AbortController();
  const capture = { capture: true, signal: listeners.signal };
  let pressed: PointerEvent | undefined;
  let handled = false;
  view.addEventListener(
    'pointerdown',
    (event) => {
      handled = false;
      pressed =
        event.isPrimary && event.pointerType === 'mouse' && event.button === 0 ? event : undefined;
    },
    capture,
  );
  const endPress = () => {
    pressed = undefined;
  };
  for (const type of ['pointerup', 'pointercancel'] as const) {
    view.addEventListener(type, endPress, capture);
  }
  view.addEventListener('blur', endPress, { signal: listeners.signal });
  const suppressClick = (event: MouseEvent) => {
    if (event.isTrusted && event.detail > 0 && handled) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  view.addEventListener('click', suppressClick, capture);
  view.addEventListener('dblclick', suppressClick, capture);

  const unsubscribe = subscribe((request) => {
    if (
      !pressed ||
      handled ||
      Date.now() >= request.deadline ||
      Math.hypot(pressed.clientX - request.x, pressed.clientY - request.y) > 8
    )
      return false;
    const target = document.elementFromPoint(request.x, request.y);
    if (!target) return false;
    const control = target.closest(CONTROL);
    const kind = control?.getAttribute('data-weq-force-click');
    const row = target.closest(MESSAGE);
    if (row?.matches('.selection-mode')) return false;
    let receiver: Element;
    let action: Gesture['kind'];
    if (control && (kind === 'profile' || kind === 'conversation')) {
      if (control.matches(':disabled, [aria-disabled="true"]')) return false;
      receiver = control;
      action = kind;
    } else {
      if (!row || (control && control !== row && row.contains(control))) return false;
      const selection = document.getSelection();
      if ((selection && !selection.isCollapsed) || hitsSelectableText(document, request))
        return false;
      receiver = row;
      action = 'message';
    }
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view,
      detail: 1,
      clientX: request.x,
      clientY: request.y,
    });
    const gesture = { kind: action, target, handled: false };
    gestures.set(event, gesture);
    event.preventDefault();
    receiver.dispatchEvent(event);
    handled = gesture.handled;
    return gesture.handled;
  });
  return () => {
    unsubscribe();
    listeners.abort();
  };
}
