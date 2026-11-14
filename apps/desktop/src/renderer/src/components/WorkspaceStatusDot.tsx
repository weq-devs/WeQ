import { workspaceIndicator } from '../lib/workspaceIndicators';
import { ReminderCount } from './ReminderBadge';

export function WorkspaceStatusDot({ running, finished }: { running: number; finished: number }) {
  const status = workspaceIndicator(running, finished);
  const count = status === 'running' ? running : finished;
  return status ? (
    <ReminderCount
      count={count}
      tone={status === 'running' ? 'running' : 'notice'}
      overlay
      className={`weq-workspace-dot weq-workspace-status-count is-${status}`}
      aria-hidden
    />
  ) : null;
}
