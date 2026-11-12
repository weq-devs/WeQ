import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { OverlayLayer } from './OverlayLayer';
import '../styles/conversation-actions.css';
import { useRenderDocument } from '../lib/renderDocument';
import { RemoteShellMenuItem } from './RemoteShellMenus';

export function ConversationActionsMenu({
  x,
  y,
  actions,
  onClose,
  label = '会话操作',
  portalTarget,
  dropdown = false,
  target,
}: {
  x: number;
  y: number;
  actions: Array<{
    label: string;
    icon: ReactNode;
    action: () => void;
    disabled?: boolean;
    reason?: string;
    separatorBefore?: boolean;
    keepOpen?: boolean;
  }>;
  onClose: () => void;
  label?: string;
  portalTarget?: Element | null;
  /** 右对齐在触发器下方，短屏时滚动菜单而不覆盖标题栏。 */
  dropdown?: boolean;
  /** 仅在需要明确操作对象的菜单中展示，不占用键盘操作项。 */
  target?: ReactNode;
}) {
  const document = useRenderDocument();
  const window = document.defaultView ?? globalThis.window;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      if (event.target instanceof window.Node && ref.current?.contains(event.target)) return;
      onClose();
    };
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [onClose, document, window]);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    if (dropdown) menu.style.maxHeight = `${Math.max(44, window.innerHeight - y - 8)}px`;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(dropdown ? x - rect.width : x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [x, y, window, dropdown]);
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
        className={`weq-conversation-actions-menu${dropdown ? ' is-header-dropdown' : ''}`}
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
        {actions.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={item.separatorBefore ? 'has-separator' : undefined}
            title={item.reason ?? item.label}
            onClick={() => {
              if (!item.keepOpen) onClose();
              item.action();
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
        {dropdown && label === '会话操作' && <RemoteShellMenuItem onClose={onClose} />}
      </div>
    </OverlayLayer>
  );
}
