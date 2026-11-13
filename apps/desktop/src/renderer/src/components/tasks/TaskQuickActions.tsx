import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useDialog } from '../Dialog';
import { ConversationActionsMenu } from '../ConversationActionsMenu';

export interface TaskQuickAction {
  id: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  secondary?: boolean;
  run: () => unknown;
}

export function TaskQuickActions({ actions }: { actions: TaskQuickAction[] }) {
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
    setBusy(true);
    try {
      await action.run();
    } catch (error) {
      showError('任务操作失败', error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  if (!actions.length) return null;
  const primary = actions
    .filter((action) => !action.secondary && !['remove', 'delete'].includes(action.id))
    .slice(0, 2);
  const more = actions.filter((action) => !primary.includes(action));
  const closeMenu = () => {
    setMenu(null);
    trigger.current?.focus();
  };
  return (
    <div className="weq-task-quick-actions" role="group" aria-label="任务快捷操作">
      {primary.map((action) => (
        <button
          key={action.id}
          type="button"
          className="weq-set-btn weq-set-btn-soft"
          title={action.label}
          aria-label={action.label}
          disabled={busy || action.disabled}
          onClick={() => void act(action)}
        >
          {action.icon}
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
            action: () => void act(action),
          }))}
        />
      ) : null}
    </div>
  );
}
