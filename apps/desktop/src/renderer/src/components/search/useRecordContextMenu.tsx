import { useCallback, useEffect, useRef, useState, type HTMLAttributes } from 'react';
import { LocateFixed } from 'lucide-react';
import { ConversationActionsMenu } from '../ConversationActionsMenu';

export function useRecordContextMenu(label: string) {
  const [menu, setMenu] = useState<{ x: number; y: number; action: () => void }>();
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> }>(null);
  const suppressClick = useRef(0);

  const cancelPress = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }, []);

  useEffect(() => cancelPress, [cancelPress]);

  function trigger<T extends HTMLElement>(action: () => void): HTMLAttributes<T> {
    return {
      onContextMenuCapture: (event) => {
        event.preventDefault();
        event.stopPropagation();
        cancelPress();
        if (Date.now() < suppressClick.current) return;
        const rect = event.currentTarget.getBoundingClientRect();
        setMenu({ x: event.clientX || rect.left, y: event.clientY || rect.bottom, action });
      },
      onKeyDownCapture: (event) => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        const rect = event.currentTarget.getBoundingClientRect();
        event.preventDefault();
        event.stopPropagation();
        setMenu({ x: rect.left, y: rect.bottom, action });
      },
      onPointerDownCapture: (event) => {
        if (event.pointerType === 'mouse' || event.button !== 0) return;
        cancelPress();
        suppressClick.current = 0;
        const { clientX: x, clientY: y } = event;
        press.current = {
          x,
          y,
          timer: setTimeout(() => {
            press.current = null;
            suppressClick.current = Date.now() + 1000;
            setMenu({ x, y, action });
          }, 460),
        };
      },
      onPointerMoveCapture: (event) => {
        const start = press.current;
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8)
          cancelPress();
      },
      onPointerUpCapture: cancelPress,
      onPointerCancelCapture: cancelPress,
      onPointerLeave: cancelPress,
      onClickCapture: (event) => {
        if (Date.now() >= suppressClick.current) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClick.current = 0;
      },
    };
  }

  return {
    trigger,
    menu: menu ? (
      <ConversationActionsMenu
        x={menu.x}
        y={menu.y}
        label={label}
        onClose={() => setMenu(undefined)}
        actions={[{ label, icon: <LocateFixed size={16} />, action: menu.action }]}
      />
    ) : null,
  };
}
