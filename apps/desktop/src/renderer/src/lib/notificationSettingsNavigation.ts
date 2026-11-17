export const OPEN_NOTIFICATION_SETTINGS = 'weq:open-notification-settings';

export interface NotificationConversation {
  kind: 'c2c' | 'group' | 'dataline';
  conv: string;
  title: string;
}

export interface NotificationSettingsRequest {
  settingId: string;
  conversation?: NotificationConversation;
  source?: string;
}

export function requestNotificationSettings(request: NotificationSettingsRequest): void {
  window.dispatchEvent(
    new CustomEvent(OPEN_NOTIFICATION_SETTINGS, {
      detail: { ...request, source: JSON.stringify(accountBinding()) },
    }),
  );
}
import { accountBinding } from './clientPreferences';
