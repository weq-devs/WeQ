import { EventEmitter } from 'node:events';
import { NOTIFICATION_CLICK_LIMIT } from '../shared/notification_click';

export const notificationClickEvents = new EventEmitter();
const pending: string[] = [];

/** 先入队再唤醒订阅，窗口挂载或重连期间的点击也能接续。 */
export function pushNotificationClick(id: string) {
  if (!pending.includes(id)) pending.push(id);
  if (pending.length > NOTIFICATION_CLICK_LIMIT)
    pending.splice(0, pending.length - NOTIFICATION_CLICK_LIMIT);
  notificationClickEvents.emit('click');
}

export function consumeNotificationClick(): string | null {
  return pending.shift() ?? null;
}
