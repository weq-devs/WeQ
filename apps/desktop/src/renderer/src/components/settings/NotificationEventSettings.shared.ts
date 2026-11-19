import type { NotificationEvent } from '@weq/service/notification-settings';
import '../../styles/notification-event-settings.css';

export const NOTIFICATION_SETTING_IDS: Partial<Record<NotificationEvent, string>> = {
  directMessage: 'message-system-notifications',
  mail: 'mail-banner',
  recall: 'recall-notifications',
  runtime: 'restricted-mode-banner',
  databaseDamage: 'damage-reminder',
};
