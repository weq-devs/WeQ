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
    let previous: EditMenuState['undo'] | undefined;
    const publish = () => {
      // 文字撤销与重做由常规 Electron 菜单项处理，桥只需报告会话标记撤销。
      const undo =
        current.current.enabled &&
        document.visibilityState !== 'hidden' &&
        !editingText() &&
        !hasActiveModal()
          ? current.current.action
          : null;
      if (undo === previous) return;
      previous = undo;
      bridge.update?.({ undo, redo: null });
    };
    const observer = new MutationObserver(publish);
    const refreshMenu = () => {
      if (current.current.enabled) {
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['aria-modal', 'hidden', 'inert', 'contenteditable', 'role'],
        });
      } else {
        observer.disconnect();
      }
      publish();
    };
    refresh.current = refreshMenu;
    const unsubscribe = bridge.onUndo(() => {
      if (!current.current.enabled || document.visibilityState === 'hidden' || hasActiveModal())
        return false;
      if (editingText()) return false;
      current.current.undo();
      return true;
    });
    const events = ['focusin', 'focusout', 'visibilitychange'];
    for (const event of events) document.addEventListener(event, publish);
    refreshMenu();
    return () => {
      unsubscribe();
      refresh.current = null;
      for (const event of events) document.removeEventListener(event, publish);
      observer.disconnect();
      bridge.update?.(EMPTY_EDIT_MENU);
    };
  }, []);
}
