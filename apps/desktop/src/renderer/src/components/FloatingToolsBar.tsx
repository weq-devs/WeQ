import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Wrench } from 'lucide-react';
import {
  clampFloatingPosition,
  floatingToolbarLayout,
  type FloatingPosition,
} from '../../../shared/floating_tools';

export interface FloatingToolItem {
  id: string;
  label: string;
  icon: ReactNode;
  action: () => void;
}
const POSITION_KEY = 'weq:tools-position';
function viewport() {
  return typeof window === 'undefined'
    ? { width: 1024, height: 768 }
    : { width: window.innerWidth, height: window.innerHeight };
}
function initialPosition(): FloatingPosition {
  const size = viewport();
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(POSITION_KEY) ?? 'null');
    if (
      raw &&
      typeof raw === 'object' &&
      'x' in raw &&
      'y' in raw &&
      typeof raw.x === 'number' &&
      typeof raw.y === 'number'
    )
      return clampFloatingPosition({ x: raw.x, y: raw.y }, size);
  } catch {
    /* 布局偏好损坏不影响工具。 */
  }
  return clampFloatingPosition({ x: size.width - 64, y: size.height - 128 }, size);
}

export function FloatingToolsBar({
  items,
  running = 0,
}: {
  items: FloatingToolItem[];
  running?: number;
}) {
  const [position, setPosition] = useState(initialPosition);
  const [size, setSize] = useState(viewport);
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    origin: FloatingPosition;
    moved: boolean;
  } | null>(null);
  const skipPointerClick = useRef(false);
  const latest = useRef(position);
  const layout = floatingToolbarLayout(position, size, items.length);
  useEffect(() => {
    const resize = () => {
      const next = viewport();
      setSize(next);
      setPosition((current) => clampFloatingPosition(current, next));
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setExpanded(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [expanded]);
  const style = {
    left: position.x,
    top: position.y,
    '--weq-tools-columns': layout.columns,
    '--weq-tools-max-height': `${layout.maxHeight}px`,
  } as CSSProperties;
  return (
    <div
      ref={root}
      className="weq-floating-tools"
      style={style}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          setExpanded(false);
          return;
        }
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
          return;
        const buttons = [
          ...(root.current?.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button') ?? []),
        ];
        const index =
          document.activeElement instanceof HTMLButtonElement
            ? buttons.indexOf(document.activeElement)
            : -1;
        if (index < 0) return;
        event.preventDefault();
        event.stopPropagation();
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (index +
                  (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) +
                  buttons.length) %
                buttons.length;
        buttons[next]?.focus();
      }}
    >
      <button
        type="button"
        className="weq-tools-trigger"
        title="工具（可拖动）"
        aria-label={running ? `工具，${running} 个任务运行中` : '工具'}
        aria-expanded={expanded}
        aria-controls="weq-floating-tools-bar"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          skipPointerClick.current = false;
          drag.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            origin: position,
            moved: false,
          };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current || current.id !== event.pointerId) return;
          const dx = event.clientX - current.x;
          const dy = event.clientY - current.y;
          if (!current.moved && Math.hypot(dx, dy) < 5) return;
          current.moved = true;
          setExpanded(false);
          const next = clampFloatingPosition(
            { x: current.origin.x + dx, y: current.origin.y + dy },
            viewport(),
          );
          latest.current = next;
          setPosition(next);
        }}
        onPointerUp={(event) => {
          const current = drag.current;
          if (!current || current.id !== event.pointerId) return;
          if (current.moved) {
            skipPointerClick.current = true;
            try {
              window.localStorage.setItem(POSITION_KEY, JSON.stringify(latest.current));
            } catch {
              /* 布局不阻断工具。 */
            }
          }
          drag.current = null;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onClick={(event) => {
          if (event.detail > 0 && skipPointerClick.current) {
            skipPointerClick.current = false;
            return;
          }
          setExpanded((current) => !current);
        }}
      >
        <Wrench size={22} />
        {running ? <span className="weq-tools-running">{running}</span> : null}
      </button>
      {expanded ? (
        <div
          id="weq-floating-tools-bar"
          role="toolbar"
          aria-label="全局工具"
          className={`weq-floating-tools-bar opens-${layout.side} opens-${layout.vertical}`}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.label}
              aria-label={item.label}
              onClick={() => {
                setExpanded(false);
                item.action();
              }}
            >
              {item.icon}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
