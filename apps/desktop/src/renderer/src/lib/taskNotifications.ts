import { useToast } from '../components/Toast.shared';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import { taskNotificationSource } from './notificationNavigation.shared';
import { taskNotificationKey, taskNotificationPresented } from './taskNotificationPresentation';

/** 轻量保存先反馈受理，后续轮询沿用同一横幅；不会覆盖更早到达的结果。 */
export function notifyTaskCreated(id: string, title: string) {
  const source = taskNotificationSource(id);
  const menu = useWorkspaceMenu.getState();
  const scope = source.binding
    ? JSON.stringify([source.binding.expectedAccountUin, source.binding.expectedAccountConfigId])
    : menu.taskScope;
  if (!scope || taskNotificationPresented('progress', source)) return;
  const taskId = `export:${id}`;
  const task = menu.taskScope === scope ? menu.taskItems.find((item) => item.id === taskId) : null;
  if (task && (task.activity !== 'running' || task.waiting)) return;
  const toast = useToast.getState();
  const key = taskNotificationKey(scope, taskId);
  if (toast.toasts.some((item) => item.key === key)) return;
  toast.push({
    key,
    event: 'progress',
    title,
    loading: true,
    durationKind: 'long',
    // 首次任务快照尚未就绪时有界等待，实际进度到达后由共用通知接管。
    ttl: 15_000,
    source,
  });
}
