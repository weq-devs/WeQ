import { Menu } from 'lucide-react';
import { APP_NAVIGATION } from '../lib/appNavigation';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import { WorkspaceStatusDot } from './WorkspaceStatusDot';
import { useAnnouncementPresentation } from '../lib/announcementPresentation';
import { useEnhancementUpdateBadge } from '../lib/unreadMarkers';
import { useWorkspaceTaskBadges } from '../hooks/useWorkspaceTaskBadges';
import { preloadWorkspace } from './lazyWorkspaces.shared';
import '../styles/rail-navigation.css';
import '../styles/workspace-menu.css';

export function WorkspaceMenuButton() {
  const { running, finished, label: taskLabel } = useWorkspaceTaskBadges();
  const { unread } = useAnnouncementPresentation();
  const anchor = useWorkspaceMenu((state) => state.anchor);
  const toggle = useWorkspaceMenu((state) => state.toggle);
  const packUpdate = useEnhancementUpdateBadge();
  const label = `菜单${taskLabel}${packUpdate ? '，有增强包更新' : ''}${unread ? '，有未读官方公告' : ''}`;
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
      <WorkspaceStatusDot
        running={running}
        finished={finished + Number(packUpdate || unread > 0)}
      />
    </button>
  );
}

export function WorkspaceSettingsButton({ onClick }: { onClick: () => void }) {
  const { label, icon: Settings, workspace } = APP_NAVIGATION.settings;
  const packUpdate = useEnhancementUpdateBadge();
  return (
    <button
      type="button"
      className="weq-workspace-control"
      title={packUpdate ? `${label} · 有增强包更新` : label}
      aria-label={packUpdate ? `${label}，有增强包更新` : label}
      onPointerEnter={() => preloadWorkspace(workspace)}
      onFocus={() => preloadWorkspace(workspace)}
      onClick={() => {
        useWorkspaceMenu.getState().close();
        onClick();
      }}
    >
      <Settings size={18} aria-hidden />
      <WorkspaceStatusDot running={0} finished={Number(packUpdate)} />
    </button>
  );
}
