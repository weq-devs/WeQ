import { Menu } from 'lucide-react';
import { APP_NAVIGATION } from '../lib/appNavigation';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import { WorkspaceStatusDot } from './WorkspaceStatusDot';
import { summarizeNavigationBadges } from '../lib/navigationBadges';
import {
  useWorkspaceEntryBadges,
  useWorkspaceSettingsBadge,
} from '../hooks/useWorkspaceEntryBadges';
import { preloadWorkspace } from './lazyWorkspaces.shared';
import '../styles/rail-navigation.css';
import '../styles/workspace-menu.css';

export function WorkspaceMenuButton() {
  const entryBadges = useWorkspaceEntryBadges();
  const { badge, description } = summarizeNavigationBadges(Object.values(entryBadges));
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

export function WorkspaceSettingsButton({ onClick }: { onClick: () => void }) {
  const { label, icon: Settings, workspace } = APP_NAVIGATION.settings;
  const badge = useWorkspaceSettingsBadge();
  return (
    <button
      type="button"
      className="weq-workspace-control"
      title={badge ? `${label} · ${badge.description}` : label}
      aria-label={badge ? `${label}，${badge.description}` : label}
      onPointerEnter={() => preloadWorkspace(workspace)}
      onFocus={() => preloadWorkspace(workspace)}
      onClick={() => {
        useWorkspaceMenu.getState().close();
        onClick();
      }}
    >
      <Settings size={18} aria-hidden />
      <WorkspaceStatusDot badge={badge} />
    </button>
  );
}
