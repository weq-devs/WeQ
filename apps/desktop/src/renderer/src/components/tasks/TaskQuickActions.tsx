import { useRef, useState, type ReactNode } from 'react';
import { useDialog } from '../Dialog';

export interface TaskQuickAction {
  id: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  run: () => unknown;
}

export function TaskQuickActions({ actions }: { actions: TaskQuickAction[] }) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
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
  return (
    <div className="weq-task-quick-actions" role="group" aria-label="任务快捷操作">
      {actions.map((action) => (
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
    </div>
  );
}
