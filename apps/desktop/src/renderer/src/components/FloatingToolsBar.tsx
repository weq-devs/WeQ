import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Wrench } from 'lucide-react';
import { useHoverTimers } from '../hooks/useHoverTimers';
import {
  clampFloatingPosition,
  floatingFanLayout,
  floatingDockHit,
  type FloatingPosition,
} from '../../../shared/floating_tools';

/** 扇形里的一个子项：主按钮保持「按当前位置一键进入」，子项负责显式挑选种类。 */
export interface FloatingToolChild {
  id: string;
  label: string;
  icon?: ReactNode;
  action: (anchor?: HTMLElement) => void;
}

export interface FloatingToolItem {
  id: string;
  label: string;
  icon: ReactNode;
  action: (anchor?: HTMLElement) => void;
  /** 悬停主项时展开的可选子项（不点击主项也能直接选具体种类）。 */
  children?: FloatingToolChild[];
  /** 当前界面没有可用的默认目标时禁用主按钮（子项仍可选）。 */
  disabled?: boolean;
  /** 禁用原因，作为 title / 无障碍说明。 */
  disabledReason?: string;
  /** 当前界面的具体目标（如「导出「产品群」」），只用于悬停提示。 */
  hint?: string;
}
const POSITION_KEY = 'weq:tools-position';
const DOCK_KEY = 'weq:tools-docked';
function initialDocked() {
  try {
    return window.localStorage.getItem(DOCK_KEY) !== 'false';
  } catch {
    return true;
  }
}
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
  hidden = false,
}: {
  items: FloatingToolItem[];
  running?: number;
  hidden?: boolean;
}) {
  const [position, setPosition] = useState(initialPosition);
  const [size, setSize] = useState(viewport);
  const [expanded, setExpanded] = useState(false);
  const [docked, setDocked] = useState(initialDocked);
  const [dragging, setDragging] = useState(false);
  const [dropTarget, setDropTarget] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [dockPosition, setDockPosition] = useState(position);
  const [slotVisible, setSlotVisible] = useState(false);
  const [clickSerial, setClickSerial] = useState(0);
  /** 悬停 / 聚焦中的扇形项 id：带子项的那一项据此展开二级菜单。 */
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const closeChildTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const { startOpen, cancelOpen, startClose, cancelClose, cancel } = useHoverTimers(
    () => {
      if (!drag.current) setExpanded(true);
    },
    () => setExpanded(false),
  );
  useEffect(() => {
    if (!hidden) return;
    cancel();
    setExpanded(false);
    setHoveredId(null);
    drag.current = null;
    setDragging(false);
    setDropTarget(false);
  }, [hidden, cancel]);
  // 二级菜单收起也走一个小延迟：鼠标从扇形斜穿到子菜单时不会闪断。
  const openChild = (id: string) => {
    if (closeChildTimer.current !== null) clearTimeout(closeChildTimer.current);
    closeChildTimer.current = null;
    setHoveredId(id);
  };
  const scheduleCloseChild = () => {
    if (closeChildTimer.current !== null) clearTimeout(closeChildTimer.current);
    closeChildTimer.current = setTimeout(() => {
      closeChildTimer.current = null;
      setHoveredId(null);
    }, 220);
  };
  useEffect(
    () => () => {
      if (closeChildTimer.current !== null) clearTimeout(closeChildTimer.current);
    },
    [],
  );
  const hoveredItem = items.find((item) => item.id === hoveredId && item.children?.length) ?? null;
  const layout = expanded
    ? floatingFanLayout(
        docked && slotVisible && !dragging ? dockPosition : position,
        size,
        items.length,
      )
    : null;
  useLayoutEffect(() => {
    const discover = () => setSlot(document.querySelector<HTMLElement>('[data-weq-tools-dock]'));
    discover();
    const observer = new MutationObserver(discover);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!slot) return;
    const measure = () => {
      const rect = slot.getBoundingClientRect();
      setSlotVisible(rect.width > 0 && rect.height > 0);
      setDockPosition({ x: rect.left, y: rect.top });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(slot.closest('.rail-footer') ?? slot);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [slot]);
  useEffect(() => {
    slot?.classList.toggle('is-drop-target', dropTarget);
    slot?.classList.toggle('is-drag-hint', dragging);
    return () => {
      slot?.classList.remove('is-drop-target');
      slot?.classList.remove('is-drag-hint');
    };
  }, [slot, dropTarget, dragging]);
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
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        cancel();
        setExpanded(false);
      }
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [expanded, cancel]);
  const style = {
    left: docked && slotVisible && !dragging ? dockPosition.x : position.x,
    top: docked && slotVisible && !dragging ? dockPosition.y : position.y,
  } as CSSProperties;
  const content = (
    <div
      ref={root}
      hidden={hidden}
      className={`weq-floating-tools${docked && slotVisible && !dragging ? ' is-docked' : ''}${dragging ? ' is-dragging' : ''}${expanded ? ' is-expanded' : ''}`}
      style={style}
      onPointerEnter={cancelClose}
      onPointerLeave={() => {
        cancelOpen();
        if (expanded && !drag.current) startClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          cancel();
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
        onPointerEnter={(event) => {
          if (hidden || drag.current || event.pointerType === 'touch') return;
          if (!expanded) startOpen();
        }}
        onPointerLeave={cancelOpen}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          cancel();
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          skipPointerClick.current = false;
          drag.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            origin:
              docked && slotVisible
                ? {
                    x: event.currentTarget.getBoundingClientRect().left,
                    y: event.currentTarget.getBoundingClientRect().top,
                  }
                : position,
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
          setDragging(true);
          setExpanded(false);
          const next = clampFloatingPosition(
            { x: current.origin.x + dx, y: current.origin.y + dy },
            viewport(),
          );
          latest.current = next;
          setPosition(next);
          setDropTarget(
            floatingDockHit(
              { x: event.clientX, y: event.clientY },
              slot?.getBoundingClientRect() ?? null,
            ),
          );
        }}
        onPointerUp={(event) => {
          const current = drag.current;
          if (!current || current.id !== event.pointerId) return;
          if (current.moved) {
            skipPointerClick.current = true;
            const nextDocked = floatingDockHit(
              { x: event.clientX, y: event.clientY },
              slot?.getBoundingClientRect() ?? null,
            );
            setDocked(nextDocked);
            try {
              window.localStorage.setItem(POSITION_KEY, JSON.stringify(latest.current));
              window.localStorage.setItem(DOCK_KEY, String(nextDocked));
            } catch {
              /* 布局不阻断工具。 */
            }
          }
          drag.current = null;
          setDragging(false);
          setDropTarget(false);
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onPointerCancel={() => {
          cancel();
          drag.current = null;
          setDragging(false);
          setDropTarget(false);
        }}
        onClick={(event) => {
          cancel();
          if (event.detail > 0 && skipPointerClick.current) {
            skipPointerClick.current = false;
            return;
          }
          setExpanded((current) => !current);
          setClickSerial((serial) => serial + 1);
        }}
      >
        <span key={clickSerial} className={`weq-tools-glyph${clickSerial ? ' has-click' : ''}`}>
          <Wrench size={docked && slotVisible && !dragging ? 18 : 22} />
        </span>
        {running ? <span className="weq-tools-running">{running}</span> : null}
      </button>
      {expanded && layout ? (
        <div
          id="weq-floating-tools-bar"
          role="toolbar"
          aria-label="全局工具"
          className={`weq-floating-tools-bar weq-floating-tools-fan${hoveredItem ? ' has-child' : ''}`}
        >
          {items.map((item, index) => {
            const sector = layout.sectors[index];
            if (!sector) return null;
            const hasChildren = Boolean(item.children?.length);
            const trigger = root.current?.querySelector<HTMLButtonElement>('.weq-tools-trigger');
            return (
              <button
                key={item.id}
                type="button"
                title={[
                  item.label,
                  item.hint && item.hint !== item.label ? item.hint : null,
                  item.disabled && item.disabledReason ? item.disabledReason : null,
                  hasChildren ? '悬停展开子项' : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                aria-label={item.label}
                aria-disabled={item.disabled || undefined}
                aria-haspopup={hasChildren ? 'menu' : undefined}
                aria-expanded={hasChildren ? hoveredId === item.id : undefined}
                className={`weq-tools-sector${item.disabled ? ' is-disabled' : ''}${hoveredId === item.id ? ' is-hovered' : ''}`}
                style={{
                  left: sector.left,
                  top: sector.top,
                  width: sector.width,
                  height: sector.height,
                  clipPath: sector.clipPath,
                }}
                onPointerEnter={() => (hasChildren ? openChild(item.id) : scheduleCloseChild())}
                onFocus={() => (hasChildren ? openChild(item.id) : scheduleCloseChild())}
                onClick={() => {
                  if (item.disabled) {
                    // 禁用态不进入工具，但保留子项入口：单击已有子项时改为展开。
                    if (hasChildren) openChild(item.id);
                    return;
                  }
                  cancel();
                  setExpanded(false);
                  setHoveredId(null);
                  item.action(trigger ?? undefined);
                }}
              >
                <svg viewBox={`0 0 ${sector.width} ${sector.height}`} aria-hidden="true">
                  <path d={sector.path} />
                </svg>
                <span
                  className="weq-tools-sector-glyph"
                  style={{
                    left: sector.iconX,
                    top: sector.iconY,
                    width: sector.iconSize,
                    height: sector.iconSize,
                  }}
                >
                  {item.icon}
                </span>
              </button>
            );
          })}
          {hoveredItem ? (
            <FloatingChildMenu
              item={hoveredItem}
              anchor={layout.sectors[items.indexOf(hoveredItem)]}
              origin={docked && slotVisible && !dragging ? dockPosition : position}
              viewport={size}
              onKeep={() => openChild(hoveredItem.id)}
              onLeave={scheduleCloseChild}
              onPick={(child) => {
                cancel();
                setExpanded(false);
                setHoveredId(null);
                child.action(
                  root.current?.querySelector<HTMLButtonElement>('.weq-tools-trigger') ?? undefined,
                );
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
  // 停靠只改变坐标与外观，始终留在顶层，拖动中也不受左栏的层叠/裁剪影响。
  return createPortal(content, document.body);
}

const CHILD_MENU_WIDTH = 208;
const CHILD_MENU_ROW = 36;
const CHILD_MENU_PADDING = 6;

/**
 * 扇形项的子菜单：紧贴在对应扇区外侧，按扇区位置自动向左或向右展开，
 * 并夹在视口内。只承担「显式挑选种类」，点击后与主按钮走同一条 action。
 */
function FloatingChildMenu({
  item,
  anchor,
  origin,
  viewport: size,
  onKeep,
  onLeave,
  onPick,
}: {
  item: FloatingToolItem;
  anchor?: { left: number; top: number; width: number; height: number };
  origin: FloatingPosition;
  viewport: { width: number; height: number };
  onKeep: () => void;
  onLeave: () => void;
  onPick: (child: FloatingToolChild) => void;
}) {
  const children = item.children ?? [];
  if (!anchor || children.length === 0) return null;
  const height = children.length * CHILD_MENU_ROW + CHILD_MENU_PADDING * 2 + 30;
  const centerX = origin.x + anchor.left + anchor.width / 2;
  const centerY = origin.y + anchor.top + anchor.height / 2;
  const openLeft = centerX > size.width / 2;
  const rawLeft = openLeft ? centerX + 12 : centerX - CHILD_MENU_WIDTH - 12;
  const left = Math.min(Math.max(8, rawLeft), Math.max(8, size.width - CHILD_MENU_WIDTH - 8));
  const top = Math.min(Math.max(52, centerY - height / 2), Math.max(52, size.height - height - 8));
  return (
    <div
      className={`weq-tools-child-menu${openLeft ? ' is-left' : ''}`}
      role="menu"
      aria-label={`${item.label}子项`}
      style={{ left, top, width: CHILD_MENU_WIDTH }}
      onPointerEnter={onKeep}
      onPointerLeave={onLeave}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation();
      }}
    >
      <span className="weq-tools-child-head">{item.label}</span>
      {children.map((child) => (
        <button
          key={child.id}
          type="button"
          role="menuitem"
          title={child.label}
          onClick={(event) => {
            event.stopPropagation();
            onPick(child);
          }}
        >
          {child.icon ? <span className="weq-tools-child-icon">{child.icon}</span> : null}
          <span>{child.label}</span>
        </button>
      ))}
    </div>
  );
}
