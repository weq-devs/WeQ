import { workspaceIndicator } from '../lib/workspaceIndicators';

export function WorkspaceStatusDot({ running, finished }: { running: number; finished: number }) {
  const status = workspaceIndicator(running, finished);
  return status ? <span className={`weq-workspace-dot is-${status}`} aria-hidden /> : null;
}
