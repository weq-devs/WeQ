import type { NotificationEvent } from '@weq/service/notification-settings';
import type { NotificationSource } from './notificationNavigation';
import { useWorkspaceMenu } from '../state/workspaceMenu';

export function taskNotificationKey(scope: string, id: string) {
  return `task-notice:${scope}:${id}`;
}

export function taskNotificationForeground() {
  return document.visibilityState !== 'hidden' && document.hasFocus();
}

export function taskNotificationPresented(
  event: NotificationEvent,
  source: NotificationSource | null | undefined,
  panelScope = useWorkspaceMenu.getState().taskPanelScope,
  taskId?: string,
) {
  if (
    !panelScope ||
    (!taskId && source?.target.kind !== 'task') ||
    !['progress', 'taskComplete', 'success'].includes(event)
  )
    return false;
  const scope = source?.binding
    ? JSON.stringify([source.binding.expectedAccountUin, source.binding.expectedAccountConfigId])
    : useWorkspaceMenu.getState().taskScope;
  return scope === panelScope && taskNotificationForeground();
}
