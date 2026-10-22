import { useEffect, useLayoutEffect, type RefObject } from 'react';

function layerPath(element: HTMLElement): number[] {
  const path: number[] = [];
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    const value = Number.parseInt(
      element.ownerDocument.defaultView?.getComputedStyle(parent).zIndex ?? '',
      10,
    );
    if (Number.isFinite(value)) path.push(value);
  }
  return path.reverse();
}

function compareLayerPaths(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const SURFACES =
  '[aria-modal="true"], [role="dialog"], [role="menu"], [role="listbox"], .weq-dialog-layer, .weq-overlay-layer, .weq-window-layer, .weq-forward-window, [data-weq-surface], .weq-lightbox-layer, .weq-redbag-detail-layer, .weq-redbag-qr-layer';
const SHELLS = '.weq-dialog-layer, .weq-overlay-layer, .weq-window-layer';

export function surfaceRoot(element: HTMLElement): HTMLElement {
  return element.closest<HTMLElement>(SHELLS) ?? element;
}

export function topSurface(document: Document): HTMLElement | undefined {
  let top: HTMLElement | undefined;
  for (const item of document.querySelectorAll<HTMLElement>(SURFACES)) {
    const root = surfaceRoot(item);
    let visible = true;
    for (let parent: HTMLElement | null = root; parent; parent = parent.parentElement) {
      if (
        parent.matches('[hidden], [inert]') ||
        document.defaultView?.getComputedStyle(parent).display === 'none'
      ) {
        visible = false;
        break;
      }
    }
    if (visible && (!top || compareLayerPaths(layerPath(root), layerPath(top)) >= 0)) top = root;
  }
  return top;
}

/** 非模态页面只处理自身焦点内的 Escape；模态层只允许最上层处理。 */
export function useSurfaceEscape(
  ref: RefObject<HTMLElement | null>,
  onClose: (() => void) | undefined,
  active: boolean,
  modal: boolean,
) {
  // 在节点移除前归还焦点；被动清理时 activeElement 已可能变成 body。
  useLayoutEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    const document = element.ownerDocument;
    const previous = document.activeElement;
    if (
      previous instanceof HTMLElement &&
      previous.closest(
        '[aria-modal="true"], .weq-dialog-layer, .weq-overlay-layer, .weq-window-layer, .weq-forward-window',
      ) &&
      compareLayerPaths(layerPath(previous), layerPath(element)) > 0
    )
      return;
    if (!element.contains(previous) && !previous?.closest('[role="tablist"]')) {
      const focusable = element.querySelector<HTMLElement>(
        'input:not([disabled]), button:not([disabled]), [tabindex="0"]',
      );
      (focusable ?? element).focus({ preventScroll: true });
    }
    return () => {
      if (element.contains(document.activeElement) && previous?.isConnected && 'focus' in previous)
        (previous as HTMLElement).focus({ preventScroll: true });
    };
  }, [active, ref]);

  useEffect(() => {
    const element = ref.current;
    if (!active || !element || (!modal && !onClose)) return;
    const document = element.ownerDocument;
    function handleEscape(event: KeyboardEvent) {
      if (!['Escape', 'Tab'].includes(event.key) || event.defaultPrevented || !element) return;
      const top = topSurface(document);
      if (top && surfaceRoot(element) !== top) return;
      if (event.key === 'Tab') {
        if (!modal) return;
        const controls = [
          ...element.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
          ),
        ].filter(
          (item) =>
            !item.closest('[hidden], [inert]') &&
            document.defaultView?.getComputedStyle(item).display !== 'none',
        );
        const first = controls[0],
          last = controls.at(-1);
        const focused = document.activeElement;
        if (
          !first ||
          !last ||
          !element.contains(focused) ||
          (event.shiftKey ? focused === first : focused === last)
        ) {
          event.preventDefault();
          (event.shiftKey ? (last ?? element) : (first ?? element)).focus();
        }
        return;
      }
      if (!onClose) return;
      if (!modal && !element.contains(document.activeElement)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose?.();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [ref, onClose, active, modal]);
}
