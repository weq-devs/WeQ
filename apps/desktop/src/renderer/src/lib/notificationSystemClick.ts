const callbacks = new Map<string, () => unknown>();

/** 页面卸载不丢失点击目标；这里只保留有界的本次窗口会话回调。 */
export function registerNotificationClick(callback: () => unknown): string {
  const id = crypto.randomUUID();
  callbacks.set(id, callback);
  while (callbacks.size > NOTIFICATION_CLICK_LIMIT)
    callbacks.delete(callbacks.keys().next().value!);
  return id;
}

export function forgetNotificationClick(id: string) {
  callbacks.delete(id);
}

export async function activateNotificationClick(id: string): Promise<boolean> {
  const callback = callbacks.get(id);
  if (!callback) return false;
  await callback();
  return true;
}
import { NOTIFICATION_CLICK_LIMIT } from '../../../shared/notification_click';
