import { useEffect, type RefObject } from 'react';
import { topSurface } from '../lib/surfaceEscape';

/** 编辑优先响应 Esc；点过字段外空白后仍退出最近的编辑，不穿透上层详情。 */
export function useProfileFieldEscape(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onCancel: () => void,
  pending: boolean,
) {
  useEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    const document = element.ownerDocument;
    const handle = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229
      )
        return;
      const top = topSurface(document);
      if (top && !top.contains(element)) return;
      const scope = top ?? element.closest('[role="region"]') ?? document.body;
      const editors = [...scope.querySelectorAll<HTMLElement>('[data-profile-editing]')].filter(
        (node) =>
          !node.closest('[hidden], [inert]') &&
          document.defaultView?.getComputedStyle(node).display !== 'none',
      );
      const focused = document.activeElement;
      const current = editors.find((node) => node.contains(focused)) ?? editors.at(-1);
      if (current !== element) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!pending) onCancel();
    };
    document.addEventListener('keydown', handle, true);
    return () => document.removeEventListener('keydown', handle, true);
  }, [ref, active, onCancel, pending]);
}
