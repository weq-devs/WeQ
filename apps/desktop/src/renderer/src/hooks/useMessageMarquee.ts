import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type MouseEvent,
} from 'react';
import '../styles/message-marquee.css';
import { selectMessageIds, type SelectionModifiers } from '../lib/messageSelection';

export function marqueeMessageIds(
  rows: readonly { id: string; top: number; bottom: number }[],
  start: number,
  end: number,
  base: ReadonlySet<string> = new Set(),
  modifiers: SelectionModifiers & { anchor?: string | null; ordered?: readonly string[] } = {},
) {
  const top = Math.min(start, end),
    bottom = Math.max(start, end);
  const hits = rows
    .filter((row) => row.bottom >= top && row.top <= bottom)
    .sort((a, b) => a.top - b.top);
  if (modifiers.shiftKey && modifiers.anchor && hits.length) {
    const target = end >= start ? hits[hits.length - 1]! : hits[0]!;
    return selectMessageIds(
      base,
      modifiers.ordered ?? rows.map((row) => row.id),
      target.id,
      modifiers.anchor,
      { shiftKey: true, ctrlKey: true },
    );
  }
  const next = new Set(base);
  for (const row of hits) {
    if ((modifiers.ctrlKey || modifiers.metaKey) && !modifiers.shiftKey && next.has(row.id))
      next.delete(row.id);
    else next.add(row.id);
  }
  return next;
}

/** 空白处开始框选；命中只看竖直交集，边缘滚动持续刷新同一选择范围。 */
export function useMessageMarquee({
  conversationKey,
  enabled,
  selectionMode,
  selected,
  onChange,
  onStart,
  onSelect,
  orderedIds,
  anchorRef,
}: {
  conversationKey?: string;
  enabled: boolean;
  selectionMode: boolean;
  selected: ReadonlySet<string>;
  onChange: (ids: Set<string>) => void;
  onStart: () => void;
  onSelect?: (id: string, modifiers: SelectionModifiers) => void;
  orderedIds?: readonly string[];
  anchorRef?: { current: string | null };
}) {
  const [previewIds, setPreviewIds] = useState<ReadonlySet<string> | null>(null);
  const [box, setBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const current = useRef({ onChange, onStart, onSelect });
  current.current = { onChange, onStart, onSelect };
  const gesture = useRef<{
    element: HTMLDivElement;
    pointer: number;
    x: number;
    y: number;
    endY: number;
    clientX: number;
    clientY: number;
    moved: boolean;
    dirty: boolean;
    base: Set<string>;
    pending: Set<string>;
    selectionMode: boolean;
    modifiers: SelectionModifiers & { anchor?: string | null; ordered?: readonly string[] };
    rows: Map<string, { id: string; top: number; bottom: number }>;
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
    setPreviewIds(null);
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
    drag.endY = y;
    for (const row of drag.element.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const rect = row.getBoundingClientRect();
      if (rect.height <= 0) continue;
      drag.rows.set(row.dataset.messageId!, {
        id: row.dataset.messageId!,
        top: rect.top - bounds.top + drag.element.scrollTop,
        bottom: rect.bottom - bounds.top + drag.element.scrollTop,
      });
    }
    const pending = marqueeMessageIds(
      [...drag.rows.values()],
      drag.y,
      y,
      drag.base,
      drag.modifiers,
    );
    drag.pending = pending;
    setPreviewIds((previous) =>
      previous !== null &&
      previous.size === pending.size &&
      [...pending].every((id) => previous.has(id))
        ? previous
        : pending,
    );
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
      const previous = drag.element.scrollTop;
      drag.element.scrollTop += speed;
      if (drag.element.scrollTop !== previous) drag.dirty = true;
    }
    if (drag.dirty) {
      drag.dirty = false;
      update();
    }
    if (gesture.current === drag) frame.current = requestAnimationFrame(tick);
  };
  return {
    box,
    previewIds,
    dragging: Boolean(box),
    handlers: {
      onScrollCapture: () => {
        if (gesture.current) gesture.current.dirty = true;
      },
      onPointerDownCapture: (event: PointerEvent<HTMLDivElement>) => {
        if (
          !enabled ||
          event.button !== 0 ||
          event.pointerType === 'touch' ||
          !(event.target instanceof Element)
        )
          return;
        suppressClick.current = false;
        const modified = event.ctrlKey || event.metaKey || event.shiftKey;
        if (
          event.target.closest(
            'input, textarea, select, [contenteditable="true"], [data-windowed-scrollbar]',
          )
        )
          return;
        if (
          !selectionMode &&
          !modified &&
          event.target.closest(
            'button, a, .message-bubble, .message-avatar-wrap, .weq-system-message-content',
          )
        )
          return;
        const element = event.currentTarget,
          rect = element.getBoundingClientRect();
        if (event.clientX >= rect.left + element.clientWidth) return;
        event.preventDefault();
        if (selectionMode || modified) event.stopPropagation();
        gesture.current = {
          element,
          pointer: event.pointerId,
          x: event.clientX - rect.left + element.scrollLeft,
          y: event.clientY - rect.top + element.scrollTop,
          endY: event.clientY - rect.top + element.scrollTop,
          clientX: event.clientX,
          clientY: event.clientY,
          moved: false,
          dirty: false,
          base: new Set(selected),
          pending: new Set(),
          selectionMode,
          modifiers: {
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
            anchor: anchorRef?.current,
            ordered: orderedIds,
          },
          rows: new Map(),
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
        drag.dirty = true;
      },
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
        const drag = gesture.current;
        if (!drag || drag.pointer !== event.pointerId) return;
        // 快速拖拽可能没有中间 move；释放坐标仍足以确认首次框选。
        if (
          !drag.moved &&
          Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) >= 5
        ) {
          drag.moved = true;
          suppressClick.current = true;
          drag.element.ownerDocument.getSelection()?.removeAllRanges();
        }
        drag.clientX = event.clientX;
        drag.clientY = event.clientY;
        update();
        if (drag.moved) {
          current.current.onStart();
          current.current.onChange(drag.pending);
          if (anchorRef && !drag.modifiers.shiftKey) {
            const hits = [...drag.rows.values()]
              .filter(
                (row) =>
                  row.bottom >= Math.min(drag.y, drag.endY) &&
                  row.top <= Math.max(drag.y, drag.endY),
              )
              .sort((a, b) => a.top - b.top);
            const first = drag.endY >= drag.y ? hits[0] : hits[hits.length - 1];
            if (first) anchorRef.current = first.id;
          }
        } else if (
          drag.selectionMode ||
          drag.modifiers.ctrlKey ||
          drag.modifiers.metaKey ||
          drag.modifiers.shiftKey
        ) {
          const row = [...drag.element.querySelectorAll<HTMLElement>('[data-message-id]')].find(
            (row) => {
              const rect = row.getBoundingClientRect();
              return rect.height > 0 && event.clientY >= rect.top && event.clientY <= rect.bottom;
            },
          );
          const id = row?.dataset.messageId;
          if (id) {
            suppressClick.current = true;
            drag.element.ownerDocument.getSelection()?.removeAllRanges();
            current.current.onStart();
            if (current.current.onSelect) current.current.onSelect(id, drag.modifiers);
            else
              current.current.onChange(
                selectMessageIds(
                  drag.base,
                  [...drag.element.querySelectorAll<HTMLElement>('[data-message-id]')].map(
                    (row) => row.dataset.messageId!,
                  ),
                  id,
                  drag.modifiers.anchor ?? null,
                  drag.modifiers,
                ),
              );
          }
        }
        finish();
      },
      onPointerCancel: finish,
      onLostPointerCapture: finish,
      onContextMenuCapture: (event: MouseEvent<HTMLDivElement>) => {
        if (enabled && event.ctrlKey) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}
