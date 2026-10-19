import { useEffect, useRef } from 'react';
import { hasActiveModal } from '../lib/overlayStack';

/** 不接管编辑框或其它弹窗的撤销；无业务操作时由预加载桥回退到文字撤销。 */
export function useReadStateUndo(enabled: boolean, undo: () => void): void {
  const current = useRef({ enabled, undo });
  current.current = { enabled, undo };
  useEffect(
    () =>
      window.weq?.editUndo?.onUndo(() => {
        if (!current.current.enabled || document.visibilityState === 'hidden' || hasActiveModal())
          return false;
        const active = document.activeElement;
        if (
          active?.closest(
            'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
          )
        )
          return false;
        current.current.undo();
        return true;
      }),
    [],
  );
}
