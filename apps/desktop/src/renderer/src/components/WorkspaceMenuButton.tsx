import { Menu } from 'lucide-react';
import { APP_NAVIGATION } from '../lib/appNavigation';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import { WorkspaceStatusDot } from './WorkspaceStatusDot';
import { ReminderDot } from './ReminderBadge';
import { useAnnouncementPresentation } from '../lib/announcementPresentation';
import { useEnhancementUpdateBadge, useUnreadMarkers } from '../lib/unreadMarkers';
import { preloadWorkspace } from './lazyWorkspaces.shared';
import '../styles/rail-navigation.css';
import '../styles/workspace-menu.css';

export function WorkspaceMenuButton() {
  const markers = useUnreadMarkers();
  const { unread } = useAnnouncementPresentation();
  const anchor = useWorkspaceMenu((state) => state.anchor);
  const toggle = useWorkspaceMenu((state) => state.toggle);
  const running = useWorkspaceMenu((state) => state.running);
  const failed = useWorkspaceMenu((state) => state.failed);
  const finished = useWorkspaceMenu((state) => state.finished);
  const packUpdate = useEnhancementUpdateBadge();
  const label = `菜单${markers.running && running ? `，${running} 项任务进行中` : ''}${markers.tasks && finished ? `，${finished} 项任务已结束` : ''}${markers.tasks && failed ? `，${failed} 项任务失败` : ''}${packUpdate ? '，有增强包更新' : ''}${unread ? '，有未读官方公告' : ''}`;
  const runningCount = markers.running ? running : 0;
  const finishedCount = (markers.tasks ? finished : 0) + Number(packUpdate);
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
      <WorkspaceStatusDot running={runningCount} finished={finishedCount} />
      {unread > 0 && !runningCount && !finishedCount && (
        <ReminderDot overlay className="weq-workspace-dot" aria-hidden />
      )}
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
