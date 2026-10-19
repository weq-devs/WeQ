import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type MouseEvent,
} from 'react';
import '../styles/message-marquee.css';

export function marqueeMessageIds(
  rows: readonly { id: string; top: number; bottom: number }[],
  start: number,
  end: number,
  base: ReadonlySet<string> = new Set(),
) {
  const top = Math.min(start, end),
    bottom = Math.max(start, end);
  return new Set([
    ...base,
    ...rows.filter((row) => row.bottom >= top && row.top <= bottom).map((row) => row.id),
  ]);
}

/** 空白处开始框选；命中只看竖直交集，边缘滚动持续刷新同一选择范围。 */
export function useMessageMarquee({
  conversationKey,
  enabled,
  selectionMode,
  selected,
  onChange,
  onStart,
}: {
  conversationKey?: string;
  enabled: boolean;
  selectionMode: boolean;
  selected: ReadonlySet<string>;
  onChange: (ids: Set<string>) => void;
  onStart: () => void;
}) {
  const [box, setBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const current = useRef({ onChange, onStart });
  current.current = { onChange, onStart };
  const gesture = useRef<{
    element: HTMLDivElement;
    pointer: number;
    x: number;
    y: number;
    clientX: number;
    clientY: number;
    moved: boolean;
    base: Set<string>;
    pending: Set<string>;
    selectionMode: boolean;
  } | null>(null);
  const frame = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const finish = useCallback(() => {
    const drag = gesture.current;
    gesture.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (drag?.element.hasPointerCapture?.(drag.pointer))
      drag.element.releasePointerCapture(drag.pointer);
    setBox(null);
  }, []);
  useEffect(() => {
    if (!enabled) finish();
    return finish;
  }, [conversationKey, enabled, finish]);
  useEffect(() => {
    if (!selectionMode && gesture.current?.selectionMode) finish();
  }, [selectionMode, finish]);
  const update = () => {
    const drag = gesture.current;
    if (!drag?.moved) return;
    const bounds = drag.element.getBoundingClientRect();
    const x =
      Math.max(0, Math.min(drag.element.clientWidth, drag.clientX - bounds.left)) +
      drag.element.scrollLeft;
    const y =
      Math.max(0, Math.min(drag.element.clientHeight, drag.clientY - bounds.top)) +
      drag.element.scrollTop;
    const rows = [...drag.element.querySelectorAll<HTMLElement>('[data-message-id]')].map((row) => {
      const rect = row.getBoundingClientRect();
      return {
        id: row.dataset.messageId!,
        top: rect.top - bounds.top + drag.element.scrollTop,
        bottom: rect.bottom - bounds.top + drag.element.scrollTop,
      };
    });
    drag.pending = marqueeMessageIds(rows, drag.y, y, drag.base);
    const nextBox = {
      left: Math.min(drag.x, x),
      top: Math.min(drag.y, y),
      width: Math.max(1, Math.abs(x - drag.x)),
      height: Math.max(1, Math.abs(y - drag.y)),
    };
    setBox((previous) =>
      previous &&
      previous.left === nextBox.left &&
      previous.top === nextBox.top &&
      previous.width === nextBox.width &&
      previous.height === nextBox.height
        ? previous
        : nextBox,
    );
  };
  const tick = () => {
    const drag = gesture.current;
    if (!drag?.moved) return;
    const rect = drag.element.getBoundingClientRect();
    const speed = drag.clientY < rect.top + 28 ? -12 : drag.clientY > rect.bottom - 28 ? 12 : 0;
    if (speed) {
      drag.element.scrollTop += speed;
      update();
    }
    frame.current = requestAnimationFrame(tick);
  };
  return {
    box,
    dragging: Boolean(box),
    handlers: {
      onScrollCapture: update,
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (
          !enabled ||
          event.button !== 0 ||
          event.pointerType === 'touch' ||
          !(event.target instanceof Element)
        )
          return;
        if (
          event.target.closest(
            'button, a, input, textarea, select, [contenteditable="true"], .message-bubble, .message-avatar-wrap, .weq-system-message-content, [data-windowed-scrollbar]',
          )
        )
          return;
        const element = event.currentTarget,
          rect = element.getBoundingClientRect();
        if (event.clientX >= rect.left + element.clientWidth) return;
        event.preventDefault();
        suppressClick.current = false;
        gesture.current = {
          element,
          pointer: event.pointerId,
          x: event.clientX - rect.left + element.scrollLeft,
          y: event.clientY - rect.top + element.scrollTop,
          clientX: event.clientX,
          clientY: event.clientY,
          moved: false,
          base: new Set(event.ctrlKey || event.metaKey || event.shiftKey ? selected : []),
          pending: new Set(),
          selectionMode,
        };
        element.setPointerCapture?.(event.pointerId);
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        const drag = gesture.current;
        if (!drag || drag.pointer !== event.pointerId) return;
        if (
          !drag.moved &&
          Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) < 5
        )
          return;
        drag.clientX = event.clientX;
        drag.clientY = event.clientY;
        if (!drag.moved) {
          drag.moved = true;
          drag.element.ownerDocument.getSelection()?.removeAllRanges();
          suppressClick.current = true;
          frame.current = requestAnimationFrame(tick);
        }
        event.preventDefault();
        update();
      },
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
        const drag = gesture.current;
        if (!drag || drag.pointer !== event.pointerId) return;
        drag.clientX = event.clientX;
        drag.clientY = event.clientY;
        update();
        if (drag.moved) {
          current.current.onStart();
          current.current.onChange(drag.pending);
        }
        finish();
      },
      onPointerCancel: finish,
      onLostPointerCapture: finish,
      onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}
