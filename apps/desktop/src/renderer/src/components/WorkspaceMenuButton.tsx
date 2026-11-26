import { Menu } from 'lucide-react';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import { WorkspaceStatusDot } from './WorkspaceStatusDot';
import { summarizeNavigationBadges } from '../lib/navigationBadges';
import {
  useWorkspaceAnnouncementBadge,
  useWorkspaceTaskBadge,
} from '../hooks/useWorkspaceEntryBadges';
import { preloadWorkspace } from './lazyWorkspaces.shared';
import '../styles/rail-navigation.css';
import '../styles/workspace-menu.css';

export function WorkspaceMenuButton() {
  const taskBadge = useWorkspaceTaskBadge();
  const announcementBadge = useWorkspaceAnnouncementBadge();
  const { badge, description } = summarizeNavigationBadges([taskBadge, announcementBadge]);
  const anchor = useWorkspaceMenu((state) => state.anchor);
  const toggle = useWorkspaceMenu((state) => state.toggle);
  const label = `菜单${description}`;
  return (
    <button
      type="button"
      className="weq-rail-button weq-workspace-menu-trigger"
      title={label}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={Boolean(anchor)}
      onPointerEnter={() => preloadWorkspace('export')}
      onFocus={() => preloadWorkspace('export')}
      onClick={(event) => toggle(event.currentTarget)}
    >
      <Menu size={22} strokeWidth={1.75} aria-hidden />
      <WorkspaceStatusDot badge={badge} />
    </button>
  );
}
