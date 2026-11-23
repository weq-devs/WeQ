import { useUnreadMarkers } from '../lib/unreadMarkers';
import { useWorkspaceMenu } from '../state/workspaceMenu';

export function useWorkspaceTaskBadges() {
  const markers = useUnreadMarkers();
  const running = useWorkspaceMenu((state) => (markers.running ? state.running : 0));
  const finished = useWorkspaceMenu((state) => (markers.tasks ? state.finished : 0));
  const unreadFailed = useWorkspaceMenu((state) => (markers.tasks ? state.unreadFailed : 0));
  const label = `${running ? `，${running} 项任务进行中` : ''}${finished ? `，${finished} 项任务结果未查看` : ''}${unreadFailed ? `，其中 ${unreadFailed} 项任务失败` : ''}`;
  return { running, finished, label };
}
