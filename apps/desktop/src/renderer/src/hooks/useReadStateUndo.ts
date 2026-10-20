import { useEffect, useRef } from 'react';
import { hasActiveModal } from '../lib/overlayStack';
import { EMPTY_EDIT_MENU, type EditMenuState } from '../../../shared/edit_menu';

function editingText(): boolean {
  return Boolean(
    document.activeElement?.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
    ),
  );
}

/** 不接管编辑框或其它弹窗的撤销；无业务操作时由预加载桥回退到文字撤销。 */
export function useReadStateUndo(
  enabled: boolean,
  undo: () => void,
  action: 'mark-read' | 'mark-unread' = 'mark-read',
): void {
  const current = useRef({ enabled, undo, action });
  const refresh = useRef<(() => void) | null>(null);
  current.current = { enabled, undo, action };
  useEffect(() => refresh.current?.(), [enabled, action]);
  useEffect(() => {
    const bridge = window.weq?.editUndo;
    if (!bridge) return;
    let previous = '';
    const publish = () => {
      const state: EditMenuState = { ...EMPTY_EDIT_MENU };
      if (document.visibilityState !== 'hidden') {
        if (editingText()) {
          state.undo = document.queryCommandEnabled?.('undo') ? 'text' : null;
          state.redo = document.queryCommandEnabled?.('redo') ? 'text' : null;
        } else if (current.current.enabled && !hasActiveModal()) {
          state.undo = current.current.action;
        }
      }
      const key = JSON.stringify(state);
      if (key !== previous) {
        previous = key;
        bridge.update?.(state);
      }
    };
    refresh.current = publish;
    const unsubscribe = bridge.onUndo(() => {
      if (!current.current.enabled || document.visibilityState === 'hidden' || hasActiveModal())
        return false;
      if (editingText()) return false;
      current.current.undo();
      return true;
    });
    const events = ['focusin', 'focusout', 'input', 'selectionchange', 'visibilitychange'];
    for (const event of events) document.addEventListener(event, publish);
    const unsubscribeRefresh = bridge.onRefresh?.(publish);
    const observer = new MutationObserver(publish);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-modal', 'hidden', 'inert', 'contenteditable'],
    });
    publish();
    return () => {
      unsubscribe();
      refresh.current = null;
      for (const event of events) document.removeEventListener(event, publish);
      unsubscribeRefresh?.();
      observer.disconnect();
      bridge.update?.(EMPTY_EDIT_MENU);
    };
  }, []);
}
