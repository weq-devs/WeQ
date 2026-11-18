import { create } from 'zustand';
import { preferenceValue } from './clientPreferences';
import { IS_WEB } from './target.shared';
import { messageNotificationDedupe } from '../../../shared/notification_dedupe';
export const claimMessageBanner = messageNotificationDedupe();
import { registerNotificationClick, forgetNotificationClick } from './notificationSystemClick';
import {
  normalizeNotificationEvents,
  type NotificationEvents,
  type NotificationEvent,
  type NotificationChannel,
} from '@weq/service/notification-settings';

export const useNotificationPolicy = create<{
  ready: boolean;
  events: NotificationEvents;
  setEvents: (events: NotificationEvents) => void;
}>((set) => ({
  ready: false,
  events: normalizeNotificationEvents(undefined),
  setEvents: (events) => set({ events, ready: true }),
}));
export function notificationEnabled(
  event: NotificationEvent,
  channel: NotificationChannel,
): boolean {
  return useNotificationPolicy.getState().events[event][channel];
}
export function publishNotificationSystem(
  event: NotificationEvent,
  title: string,
  body: string,
  onClick?: () => unknown,
): void {
  if (!notificationEnabled(event, 'system')) return;
  if (preferenceValue('privacyMode')) {
    title = 'WeQ';
    body = '有新的通知';
  }
  void (async () => {
    if (IS_WEB) {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const notice = new Notification(title, { body });
      if (onClick)
        notice.onclick = async () => {
          window.focus();
          try {
            await onClick();
          } catch (error) {
            console.warn('[notifications] 无法打开来源', error);
          }
          notice.close();
        };
    } else {
      const { client } = await import('../trpc/client');
      const clickId = onClick ? registerNotificationClick(onClick) : undefined;
      try {
        const shown = await client.bootstrap.notifyConfiguredEvent.mutate({
          event,
          title: title.slice(0, 512),
          body: body.slice(0, 2048),
          clickId,
        });
        if (!shown && clickId) forgetNotificationClick(clickId);
      } catch (error) {
        if (clickId) forgetNotificationClick(clickId);
        throw error;
      }
    }
  })().catch((error: unknown) => console.warn('[notifications] 系统通知未提交', error));
}
