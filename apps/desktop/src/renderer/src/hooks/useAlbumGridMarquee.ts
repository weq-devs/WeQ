import {
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type DragEvent,
  type MouseEvent,
  type PointerEvent,
  type SetStateAction,
} from 'react';
import '../styles/message-marquee.css';

type Point = { x: number; y: number };
type Box = { left: number; top: number; width: number; height: number };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function gridBox(bounds: DOMRect, start: Point, end: Point): Box {
  const left = clamp(Math.min(start.x, end.x), 0, bounds.width);
  const top = clamp(Math.min(start.y, end.y), 0, bounds.height);
  return {
    left,
    top,
    width: Math.max(1, Math.min(bounds.width, Math.max(start.x, end.x)) - left),
    height: Math.max(1, Math.min(bounds.height, Math.max(start.y, end.y)) - top),
  };
}

/** 对网格卡片按二维交集框选，松手前只预览选择。 */
export function useAlbumGridMarquee({
  enabled,
  selected,
  onChange,
  anchorRef,
}: {
  enabled: boolean;
  selected: ReadonlySet<string>;
  onChange: Dispatch<SetStateAction<Set<string>>>;
  anchorRef: { current: string | null };
}) {
  const [box, setBox] = useState<Box | null>(null);
  const [previewIds, setPreviewIds] = useState<ReadonlySet<string> | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const change = useRef(onChange);
  change.current = onChange;
  useLayoutEffect(() => () => cancel.current?.(), [enabled]);

  const onPointerDownCapture = (event: PointerEvent<HTMLDivElement>) => {
    if (cancel.current || event.button !== 0 || !event.isPrimary) return;
    suppressClick.current = false;
    if (!enabled || event.pointerType === 'touch') return;

    const grid = event.currentTarget;
    const document = grid.ownerDocument;
    const view = document.defaultView;
    if (
      !view ||
      !(event.target instanceof view.Element) ||
      event.target.closest('.weq-qzal-media-check')
    )
      return;
    const scroller = grid.closest<HTMLElement>('.weq-qzn-scroll, .weq-qzone-album-body');
    const bounds = grid.getBoundingClientRect();
    const start = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    const origin = { x: event.clientX, y: event.clientY };
    let pointer = origin;
    const pointerId = event.pointerId;
    const toggle = event.ctrlKey || event.metaKey;
    const base = selected;
    let dragging = false;
    let dirty = false;
    let frame = 0;

    // 修饰键点选由多选组的 click 处理，避免按下时先切换卡片再开始拖动。
    if (toggle || event.shiftKey) event.stopPropagation();

    const viewport = () => {
      if (!scroller) return { top: 0, bottom: view.innerHeight };
      const top = scroller.getBoundingClientRect().top + scroller.clientTop;
      return {
        top: Math.max(0, top),
        bottom: Math.min(view.innerHeight, top + scroller.clientHeight),
      };
    };
    const measure = ({ top, bottom }: { top: number; bottom: number }) => {
      const gridBounds = grid.getBoundingClientRect();
      const end = {
        x: pointer.x - gridBounds.left,
        y: clamp(pointer.y, top, bottom) - gridBounds.top,
      };
      const next = gridBox(gridBounds, start, end);
      const left = gridBounds.left + next.left;
      const upper = gridBounds.top + next.top;
      const hits = new Set<string>();
      for (const card of grid.querySelectorAll<HTMLElement>(':scope > [data-weq-select-id]')) {
        const rect = card.getBoundingClientRect();
        if (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > left &&
          rect.left < left + next.width &&
          rect.bottom > upper &&
          rect.top < upper + next.height
        )
          hits.add(card.dataset.weqSelectId!);
      }
      const reverse = end.y < start.y || (end.y === start.y && end.x < start.x);
      return { next, hits, anchor: reverse ? [...hits].at(-1) : hits.values().next().value };
    };
    const apply = (ids: ReadonlySet<string>, hits: ReadonlySet<string>) => {
      const next = new Set(ids);
      for (const id of hits) {
        if (toggle && ids.has(id)) next.delete(id);
        else next.add(id);
      }
      return next;
    };
    const tick = () => {
      const { top, bottom } = viewport();
      const edge = Math.min(28, (bottom - top) / 2);
      const speed = pointer.y < top + edge ? -12 : pointer.y > bottom - edge ? 12 : 0;
      const scroll = scroller ?? document.scrollingElement;
      if (scroll && speed) {
        const previous = scroll.scrollTop;
        scroll.scrollTop += speed;
        dirty ||= previous !== scroll.scrollTop;
      }
      if (dirty) {
        dirty = false;
        const { next, hits } = measure({ top, bottom });
        const preview = apply(base, hits);
        setBox(next);
        setPreviewIds((previous) =>
          previous?.size === preview.size && [...preview].every((id) => previous.has(id))
            ? previous
            : preview,
        );
      }
      frame = view.requestAnimationFrame(tick);
    };
    const move = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      pointer = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (!dragging) {
        if (Math.hypot(pointer.x - origin.x, pointer.y - origin.y) < 5) return;
        dragging = true;
        suppressClick.current = true;
        document.getSelection()?.removeAllRanges();
        grid.setPointerCapture?.(pointerId);
        frame = view.requestAnimationFrame(tick);
      }
      moveEvent.preventDefault();
      dirty = true;
    };
    const up = (upEvent: globalThis.PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      pointer = { x: upEvent.clientX, y: upEvent.clientY };
      if (dragging || Math.hypot(pointer.x - origin.x, pointer.y - origin.y) >= 5) {
        suppressClick.current = true;
        const { hits, anchor } = measure(viewport());
        if (anchor) {
          anchorRef.current = anchor;
          change.current((previous) => apply(previous, hits));
        }
      }
      finish();
    };
    const pointerCancel = (cancelEvent: globalThis.PointerEvent) => {
      if (cancelEvent.pointerId === pointerId) finish();
    };
    const keyDown = (keyEvent: KeyboardEvent) => {
      if (!dragging || keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      finish();
    };
    const onScroll = () => {
      dirty = true;
    };
    const finish = () => {
      cancel.current = null;
      view.cancelAnimationFrame(frame);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', pointerCancel, true);
      document.removeEventListener('keydown', keyDown, true);
      document.removeEventListener('scroll', onScroll, true);
      view.removeEventListener('blur', finish);
      if (grid.hasPointerCapture?.(pointerId)) grid.releasePointerCapture(pointerId);
      setBox(null);
      setPreviewIds(null);
    };
    cancel.current = finish;
    document.addEventListener('pointermove', move, { capture: true, passive: false });
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', pointerCancel, true);
    document.addEventListener('keydown', keyDown, true);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    view.addEventListener('blur', finish);
  };

  return {
    box,
    previewIds,
    handlers: {
      onPointerDownCapture,
      onDragStart: (event: DragEvent<HTMLDivElement>) => {
        if (cancel.current) event.preventDefault();
      },
      onContextMenuCapture: (event: MouseEvent<HTMLDivElement>) => {
        if (event.ctrlKey && (cancel.current || suppressClick.current)) event.preventDefault();
      },
      onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
        if (!event.detail || !suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}
