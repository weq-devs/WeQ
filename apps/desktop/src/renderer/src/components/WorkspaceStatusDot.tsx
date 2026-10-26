import { workspaceIndicator } from '../lib/workspaceIndicators';

export function WorkspaceStatusDot({ running, finished }: { running: number; finished: number }) {
  const status = workspaceIndicator(running, finished);
  const count = status === 'running' ? running : finished;
  return status ? (
    <span className={`weq-workspace-dot weq-workspace-status-count is-${status}`} aria-hidden>
      {count > 99 ? '99+' : count}
    </span>
  ) : null;
}
