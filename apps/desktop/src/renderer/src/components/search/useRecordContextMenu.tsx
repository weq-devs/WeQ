import { useCallback, useEffect, useRef, useState, type HTMLAttributes } from 'react';
import { LocateFixed } from 'lucide-react';
import { ConversationActionsMenu } from '../ConversationActionsMenu';

export type RecordMenuTrigger = {
  x: number;
  y: number;
  originElement: HTMLElement;
  target: EventTarget | null;
  variant: 'desktop' | 'mobile';
};

export function useRecordMenuTrigger() {
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> }>(null);
  const suppressClick = useRef(0);

  const cancelPress = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }, []);

  useEffect(() => cancelPress, [cancelPress]);

  function trigger<T extends HTMLElement>(
    open: (point: RecordMenuTrigger) => void,
    ignore?: (target: EventTarget | null) => boolean,
  ): HTMLAttributes<T> {
    return {
      onContextMenuCapture: (event) => {
        const { target, currentTarget: originElement } = event;
        if (!(target instanceof Node) || !originElement.contains(target) || ignore?.(target))
          return;
        event.preventDefault();
        event.stopPropagation();
        cancelPress();
        if (Date.now() < suppressClick.current) return;
        const rect = event.currentTarget.getBoundingClientRect();
        open({
          x: event.clientX || rect.left,
          y: event.clientY || rect.bottom,
          originElement,
          target,
          variant: 'desktop',
        });
      },
      onKeyDownCapture: (event) => {
        const { target, currentTarget: originElement } = event;
        if (
          event.defaultPrevented ||
          !(target instanceof Node) ||
          !originElement.contains(target) ||
          ignore?.(target)
        )
          return;
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        const rect = event.currentTarget.getBoundingClientRect();
        event.preventDefault();
        event.stopPropagation();
        open({ x: rect.left, y: rect.bottom, originElement, target, variant: 'desktop' });
      },
      onPointerDownCapture: (event) => {
        const { target, currentTarget: originElement } = event;
        if (!(target instanceof Node) || !originElement.contains(target) || ignore?.(target))
          return;
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
            if (originElement.isConnected) open({ x, y, originElement, target, variant: 'mobile' });
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

  return { trigger, cancelPress };
}

export function useRecordContextMenu(label: string) {
  const { trigger } = useRecordMenuTrigger();
  const [menu, setMenu] = useState<{ x: number; y: number; action: () => void }>();

  return {
    trigger: <T extends HTMLElement>(action: () => void) =>
      trigger<T>(({ x, y }) => setMenu({ x, y, action })),
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
