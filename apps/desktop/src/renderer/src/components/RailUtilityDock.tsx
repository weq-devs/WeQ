import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import '../styles/rail-utility-dock.css';

export function RailUtilityDock({ children }: { children: ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [suppressHover, setSuppressHover] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const expanded = pinned || focusWithin || (hovered && !suppressHover);
  const containsPointer = useCallback((x: number, y: number) => {
    const rect = root.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return false;
    const tool = document
      .querySelector<HTMLElement>('.weq-floating-tools.is-docked')
      ?.getBoundingClientRect();
    const left = Math.min(rect.left, tool?.left ?? rect.left) - 8;
    const right = Math.max(rect.right, tool?.right ?? rect.right) + 8;
    const top = Math.min(rect.top, tool?.top ?? rect.top) - 8;
    return x >= left && x <= right && y >= top && y <= rect.bottom + 8;
  }, []);
  useEffect(() => {
    if (!hovered) return;
    const move = (event: PointerEvent) => {
      if (containsPointer(event.clientX, event.clientY)) return;
      setHovered(false);
      setSuppressHover(false);
    };
    document.addEventListener('pointermove', move);
    return () => document.removeEventListener('pointermove', move);
  }, [hovered, containsPointer]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || root.current?.contains(event.target)) return;
      setPinned(false);
      setFocusWithin(false);
      setHovered(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  return (
    <div
      ref={root}
      className={`weq-rail-utilities${expanded ? ' is-expanded' : ''}`}
      onPointerEnter={() => {
        setHovered(true);
        setSuppressHover(false);
      }}
      onPointerLeave={(event) => {
        if (containsPointer(event.clientX, event.clientY)) return;
        setHovered(false);
        setSuppressHover(false);
      }}
      onFocusCapture={(event) => {
        if (!trigger.current?.contains(event.target)) setFocusWithin(true);
      }}
      onBlurCapture={(event) => {
        if (event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget))
          return;
        setFocusWithin(false);
        setPinned(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        setPinned(false);
        setFocusWithin(false);
        setSuppressHover(true);
        trigger.current?.focus();
      }}
    >
      <div className="weq-rail-tools-slot" data-weq-tools-dock aria-label="工具停靠位置" />
      <div id={id} className="weq-rail-utility-actions" aria-hidden={!expanded} inert={!expanded}>
        <div>{children}</div>
      </div>
      <button
        ref={trigger}
        type="button"
        className="weq-rail-utility-toggle"
        title="快捷控制"
        aria-label="快捷控制"
        aria-expanded={expanded}
        aria-controls={id}
        aria-pressed={pinned}
        onClick={() => {
          setPinned((current) => !current);
          setFocusWithin(false);
          setSuppressHover(pinned);
        }}
      >
        <SlidersHorizontal size={18} />
      </button>
    </div>
  );
}
