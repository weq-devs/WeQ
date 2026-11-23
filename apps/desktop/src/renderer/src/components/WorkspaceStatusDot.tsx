import type { NavigationBadge } from '../lib/navigationBadges';
import { NavigationBadgeMark } from './ReminderBadge';

export function WorkspaceStatusDot({
  badge,
  overlay = true,
}: {
  badge?: NavigationBadge;
  overlay?: boolean;
}) {
  return (
    <NavigationBadgeMark
      badge={badge}
      overlay={overlay}
      className={`weq-workspace-dot${badge?.kind === 'running' ? ' weq-workspace-status-count is-running' : ''}`}
    />
  );
}
