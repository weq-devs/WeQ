import { workspaceIndicator } from '../lib/workspaceIndicators';
import { ReminderCount, ReminderDot } from './ReminderBadge';

export function WorkspaceStatusDot({
  running,
  finished,
  overlay = true,
}: {
  running: number;
  finished: number;
  overlay?: boolean;
}) {
  const status = workspaceIndicator(running, finished);
  if (status === 'running') {
    return (
      <ReminderCount
        count={running}
        tone="running"
        overlay={overlay}
        className="weq-workspace-dot weq-workspace-status-count is-running"
        aria-hidden
      />
    );
  }
  return status === 'finished' ? (
    <ReminderDot overlay={overlay} className="weq-workspace-dot" aria-hidden />
  ) : null;
}
