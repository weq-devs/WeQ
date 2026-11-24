import { useAnnouncementPresentation } from '../lib/announcementPresentation';
import { navigationBadge } from '../lib/navigationBadges';
import {
  useEnhancementUpdateBadge,
  useSoftwareUpdateBadge,
  useUnreadMarkers,
} from '../lib/unreadMarkers';
import { workspaceTaskBadge } from '../lib/workspaceIndicators';
import { useWorkspaceMenu } from '../state/workspaceMenu';

export function useWorkspaceTaskBadge() {
  const markers = useUnreadMarkers();
  const running = useWorkspaceMenu((state) => (markers.running ? state.running : 0));
  const finished = useWorkspaceMenu((state) => (markers.tasks ? state.finished : 0));
  const unreadFailed = useWorkspaceMenu((state) => (markers.tasks ? state.unreadFailed : 0));
  return workspaceTaskBadge(running, finished, unreadFailed);
}

export function useWorkspaceSettingsBadge() {
  const software = useSoftwareUpdateBadge();
  const packs = useEnhancementUpdateBadge();
  const description = software ? (packs ? '有软件更新和增强包更新' : '有软件更新') : '有增强包更新';
  return navigationBadge('notice', Number(software || packs), description);
}

export function useWorkspaceAnnouncementBadge() {
  const { unread } = useAnnouncementPresentation();
  return navigationBadge('notice', unread, '有未读官方公告');
}

export function useWorkspaceEntryBadges() {
  return {
    tasks: useWorkspaceTaskBadge(),
    settings: useWorkspaceSettingsBadge(),
    announcements: useWorkspaceAnnouncementBadge(),
  };
}
