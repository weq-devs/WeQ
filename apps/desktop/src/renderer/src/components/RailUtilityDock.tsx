import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Pin, SlidersHorizontal } from 'lucide-react';
import { useHoverTimers } from '../hooks/useHoverTimers';
import '../styles/rail-utility-dock.css';

export function RailUtilityDock({ children }: { children: ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [suppressHover, setSuppressHover] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const { startOpen, cancelOpen, startClose, cancelClose, cancel } = useHoverTimers(
    () => setHovered(true),
    () => {
      setHovered(false);
      setFocusWithin(false);
      setSuppressHover(false);
    },
  );
  const id = useId();
  const expanded = pinned || focusWithin || (hovered && !suppressHover);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || root.current?.contains(event.target)) return;
      setFocusWithin(false);
      cancel();
      setHovered(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [cancel]);
  return (
    <div
      ref={root}
      className={`weq-rail-utilities${expanded ? ' is-expanded' : ''}`}
      onPointerEnter={cancelClose}
      onPointerLeave={() => {
        cancelOpen();
        if (expanded && !pinned) startClose();
      }}
      onFocusCapture={(event) => {
        if (!trigger.current?.contains(event.target)) setFocusWithin(true);
      }}
      onBlurCapture={(event) => {
        if (event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget))
          return;
        setFocusWithin(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        cancel();
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
        title={pinned ? '快捷控制：固定展开，点击改为自动折叠' : '快捷控制：自动折叠，点击固定展开'}
        aria-label="快捷控制"
        aria-expanded={expanded}
        aria-controls={id}
        aria-pressed={pinned}
        onPointerEnter={(event) => {
          if (event.pointerType === 'touch') return;
          setSuppressHover(false);
          if (!expanded) startOpen();
        }}
        onPointerLeave={cancelOpen}
        onClick={() => {
          cancel();
          setPinned((current) => !current);
          setFocusWithin(false);
          setSuppressHover(pinned);
        }}
      >
        {pinned ? <Pin size={18} aria-hidden /> : <SlidersHorizontal size={18} aria-hidden />}
      </button>
    </div>
  );
}
