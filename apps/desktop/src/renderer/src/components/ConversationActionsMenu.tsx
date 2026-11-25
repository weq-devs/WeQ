import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ChevronDown } from 'lucide-react';
import { OverlayLayer } from './OverlayLayer';
import '../styles/conversation-actions.css';
import { useRenderDocument } from '../lib/renderDocument';
import type { DangerLevel } from './Dialog';
import { visibleViewport } from '../lib/visibleViewport';

export type ConversationMenuAction = {
  label: string;
  detail?: ReactNode;
  icon: ReactNode;
  action?: (anchor: HTMLButtonElement) => void;
  children?: ConversationMenuAction[];
  disabled?: boolean;
  danger?: DangerLevel;
  reason?: string;
  separatorBefore?: boolean;
  keepOpen?: boolean;
  checked?: boolean;
};

export function ConversationActionsMenu({
  x,
  y,
  actions,
  onClose,
  label = '会话操作',
  portalTarget,
  compact = false,
  dropdown = false,
  target,
}: {
  x: number;
  y: number;
  actions: ConversationMenuAction[];
  onClose: () => void;
  label?: string;
  portalTarget?: Element | null;
  compact?: boolean;
  /** 右对齐到触发器，在指定的一侧留出可滚动空间。 */
  dropdown?: boolean | 'above';
  /** 需要明确操作对象时展示，内含按钮沿用菜单键盘导航。 */
  target?: ReactNode;
}) {
  const document = useRenderDocument();
  const window = document.defaultView ?? globalThis.window;
  const ref = useRef<HTMLDivElement>(null);
  const submenuId = useId();
  const [expanded, setExpanded] = useState<string | null>(null);
  const focusSubmenu = useRef(false);
  useEffect(() => {
    const close = (event: Event) => {
      if (event.target instanceof window.Node && ref.current?.contains(event.target)) return;
      onClose();
    };
    window.addEventListener('resize', close);
    window.visualViewport?.addEventListener('resize', close);
    window.visualViewport?.addEventListener('scroll', close);
    document.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      window.visualViewport?.removeEventListener('resize', close);
      window.visualViewport?.removeEventListener('scroll', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [onClose, document, window]);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const viewport = visibleViewport(window);
    const bottom = viewport.top + viewport.height - 8;
    const top = Math.max(viewport.top + 8, Math.min(y, bottom - 44));
    const above = dropdown === 'above';
    const edge = above ? Math.min(bottom, y) : bottom;
    menu.style.maxWidth = `${Math.max(1, viewport.width - 16)}px`;
    menu.style.maxHeight = `${Math.max(1, above ? edge - viewport.top - 8 : dropdown ? bottom - top : viewport.height - 16)}px`;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(viewport.left + 8, Math.min(dropdown ? x - rect.width : x, viewport.left + viewport.width - rect.width - 8))}px`;
    menu.style.top = `${Math.max(viewport.top + 8, Math.min(top, edge - rect.height))}px`;
  }, [x, y, window, dropdown, expanded, actions]);
  useLayoutEffect(() => {
    const menu = ref.current;
    (
      menu?.querySelector<HTMLButtonElement>('button[aria-checked="true"]:not(:disabled)') ??
      menu?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    )?.focus();
  }, [x, y, window, dropdown]);
  useLayoutEffect(() => {
    if (expanded && focusSubmenu.current) {
      ref.current
        ?.querySelector<HTMLButtonElement>('.weq-conversation-submenu button:not(:disabled)')
        ?.focus();
    }
    focusSubmenu.current = false;
  }, [expanded]);
  const renderAction = (item: ConversationMenuAction, index: number, nested = false): ReactNode => (
    <Fragment key={item.label}>
      <button
        type="button"
        role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
        aria-checked={item.checked}
        data-danger={item.danger}
        disabled={item.disabled}
        className={item.separatorBefore ? 'has-separator' : undefined}
        title={item.reason ?? item.label}
        aria-expanded={item.children ? expanded === item.label : undefined}
        aria-controls={item.children ? `${submenuId}-${index}` : undefined}
        onKeyDown={(event) => {
          if (item.children && event.key === 'ArrowRight') {
            event.preventDefault();
            focusSubmenu.current = true;
            setExpanded(item.label);
          } else if (nested && event.key === 'ArrowLeft') {
            event.preventDefault();
            ref.current?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')?.focus();
            setExpanded(null);
          }
        }}
        onClick={(event) => {
          if (item.children) {
            setExpanded((old) => (old === item.label ? null : item.label));
            return;
          }
          if (!item.keepOpen) onClose();
          item.action?.(event.currentTarget);
        }}
      >
        {item.icon}
        <span>
          {item.label}
          {item.detail != null ? <> · {item.detail}</> : null}
        </span>
        {item.children ? <ChevronDown size={14} className="weq-menu-expand" aria-hidden /> : null}
      </button>
      {item.children && expanded === item.label ? (
        <div
          id={`${submenuId}-${index}`}
          role="group"
          aria-label={item.label}
          className="weq-conversation-submenu"
        >
          {item.children.map((child, childIndex) => renderAction(child, childIndex, true))}
        </div>
      ) : null}
    </Fragment>
  );
  return (
    <OverlayLayer
      presentation="popover"
      onClose={onClose}
      className="weq-conversation-actions-layer"
      portalTarget={portalTarget}
    >
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        className={`weq-conversation-actions-menu${compact ? ' is-compact' : ''}${dropdown === true ? ' is-header-dropdown' : ''}`}
        style={{ left: x, top: y }}
        onContextMenu={(event) => event.preventDefault()}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          const buttons = [
            ...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
          ];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          } else if (event.key === 'Tab') onClose();
        }}
      >
        {target ? <div className="weq-conversation-actions-target">{target}</div> : null}
        {actions.map((item, index) => renderAction(item, index))}
      </div>
    </OverlayLayer>
  );
}
