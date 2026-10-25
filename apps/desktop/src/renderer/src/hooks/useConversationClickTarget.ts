import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';
import { useRenderDocument } from '../lib/renderDocument';

const CLICK_SLOP = 8;

/** 排序可以随时更新，但同一次轻点始终使用按下时的会话身份。 */
export function useConversationClickTarget({
  rows,
  enabled,
  resetKey,
  onSelect,
}: {
  rows: readonly { id: string }[];
  enabled: boolean;
  resetKey: string;
  onSelect: (id: string, event: MouseEvent<HTMLElement>) => void;
}) {
  const document = useRenderDocument();
  const pressed = useRef<{
    id: string;
    index: number;
    pointerId: number;
    x: number;
    y: number;
    handled: boolean;
  } | null>(null);

  useEffect(() => {
    const clear = (event?: Event) => {
      if (event?.type === 'scroll' && pressed.current?.handled) return;
      pressed.current = null;
    };
    const move = (event: globalThis.PointerEvent) => {
      const target = pressed.current;
      if (
        target?.pointerId === event.pointerId &&
        Math.hypot(event.clientX - target.x, event.clientY - target.y) > CLICK_SLOP
      )
        clear();
    };
    document.addEventListener('pointerdown', clear, true);
    document.addEventListener('pointercancel', clear, true);
    document.addEventListener('pointermove', move, true);
    document.addEventListener('scroll', clear, true);
    document.defaultView?.addEventListener('blur', clear);
    return () => {
      clear();
      document.removeEventListener('pointerdown', clear, true);
      document.removeEventListener('pointercancel', clear, true);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('scroll', clear, true);
      document.defaultView?.removeEventListener('blur', clear);
    };
  }, [document, enabled, resetKey]);

  const rowId = (event: MouseEvent<HTMLElement>) => {
    const ElementClass = document.defaultView?.Element ?? Element;
    return event.target instanceof ElementClass
      ? event.target.closest<HTMLElement>('[data-conversation-id]')?.dataset.conversationId
      : undefined;
  };
  const targetFor = (event: MouseEvent<HTMLElement>) => {
    const target = pressed.current;
    return enabled &&
      target &&
      (target.handled || rows.findIndex((row) => row.id === target.id) !== target.index) &&
      event.button === 0 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      Math.hypot(event.clientX - target.x, event.clientY - target.y) <= CLICK_SLOP
      ? target
      : null;
  };

  return {
    onPointerDownCapture: (event: PointerEvent<HTMLElement>) => {
      if (
        !enabled ||
        !event.isPrimary ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const ElementClass = document.defaultView?.Element ?? Element;
      const row =
        event.target instanceof ElementClass
          ? event.target.closest<HTMLElement>('[data-conversation-id]')
          : null;
      if (!row?.dataset.conversationId || !event.currentTarget.contains(row)) return;
      pressed.current = {
        id: row.dataset.conversationId,
        index: rows.findIndex((item) => item.id === row.dataset.conversationId),
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        handled: false,
      };
    },
    onPointerUpCapture: (event: PointerEvent<HTMLElement>) => {
      const target = targetFor(event);
      if (!target || target.pointerId !== event.pointerId || rowId(event) === target.id) return;
      // React 移动按下节点时浏览器可能不再派发 click；松开时先完成改换目标的轻点。
      target.handled = true;
      onSelect(target.id, event);
    },
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      const target = targetFor(event);
      pressed.current = null;
      if (!target || event.detail === 0) return;
      if (!target.handled && rowId(event) === target.id) return;
      // 重排后 click 可能落到另一行或公共祖先，不能再让行级处理器选择新目标。
      event.stopPropagation();
      if (!target.handled) onSelect(target.id, event);
    },
  };
}
