import { ToolbarLabel } from '../CompactToolbar';
import { observeCompactToolbar } from '../CompactToolbar.shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useDialog } from '../Dialog.shared';
import type { DangerLevel } from '../Dialog';
import { ConversationActionsMenu } from '../ConversationActionsMenu';
import '../../styles/long-tasks.css';

export interface TaskQuickAction {
  id: string;
  label: string;
  tooltip?: string;
  icon: ReactNode;
  disabled?: boolean;
  secondary?: boolean;
  showLabel?: boolean;
  danger?: DangerLevel;
  run: () => unknown;
}

export function TaskQuickActions({
  actions,
  variant = 'compact',
  children,
}: {
  actions: TaskQuickAction[];
  variant?: 'compact' | 'detail';
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [menu, setMenu] = useState<{ x: number; y: number; actionIds: string } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const actionIds = actions.map((action) => action.id).join(':');
  useEffect(() => {
    setMenu((current) => (current?.actionIds === actionIds ? current : null));
  }, [actionIds]);
  const showError = useDialog((state) => state.showError);
  const act = async (action: TaskQuickAction) => {
    if (pending.current || action.disabled) return;
    pending.current = true;
    try {
      const operation = action.run();
      if (operation && typeof (operation as PromiseLike<unknown>).then === 'function') {
        setBusy(true);
        await operation;
      }
    } catch (error) {
      showError('任务操作失败', error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  if (!actions.length && !children) return null;
  const detail = variant === 'detail';
  const primary = actions
    .filter((action) => !action.secondary && !['remove', 'delete'].includes(action.id))
    .slice(0, 2);
  const more = actions.filter((action) => !primary.includes(action));
  const closeMenu = () => {
    setMenu(null);
    trigger.current?.focus();
  };
  return (
    <div
      ref={detail ? observeCompactToolbar : undefined}
      className={detail ? 'weq-task-detail-actions' : 'weq-task-quick-actions'}
      role="group"
      aria-label={detail ? '任务操作' : '任务快捷操作'}
    >
      {children}
      {primary.map((action, index) => (
        <button
          key={action.id}
          type="button"
          className={`weq-set-btn ${detail && !children && index === 0 && !action.danger ? 'weq-set-btn-primary' : 'weq-set-btn-soft'}${!detail && action.showLabel ? ' weq-task-quick-labeled' : ''}`}
          data-danger={action.danger}
          title={action.tooltip ?? action.label}
          aria-label={action.label}
          disabled={busy || action.disabled}
          onClick={() => void act(action)}
        >
          {action.icon}
          {detail ? (
            <ToolbarLabel>{action.label}</ToolbarLabel>
          ) : action.showLabel ? (
            <span>{action.label}</span>
          ) : null}
        </button>
      ))}
      {more.length ? (
        <button
          ref={trigger}
          type="button"
          className="weq-set-btn weq-set-btn-soft"
          title="更多操作"
          aria-label="更多操作"
          aria-haspopup="menu"
          aria-expanded={Boolean(menu)}
          disabled={busy}
          onClick={() => {
            const rect = trigger.current!.getBoundingClientRect();
            const viewportHeight = trigger.current!.ownerDocument.defaultView!.innerHeight;
            const height = Math.min(more.length * 44 + 10, viewportHeight - 16);
            const y =
              rect.bottom + height + 4 > viewportHeight - 8
                ? Math.max(8, rect.top - height - 4)
                : rect.bottom + 4;
            setMenu(menu ? null : { x: rect.right, y, actionIds });
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      ) : null}
      {menu && more.length ? (
        <ConversationActionsMenu
          x={menu.x}
          y={menu.y}
          dropdown
          label="任务更多操作"
          onClose={closeMenu}
          actions={more.map((action) => ({
            label: action.label,
            icon: action.icon,
            disabled: busy || action.disabled,
            danger:
              action.danger ?? (['remove', 'delete'].includes(action.id) ? 'outline' : undefined),
            action: () => void act(action),
          }))}
        />
      ) : null}
    </div>
  );
}
