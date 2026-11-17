import { useContext } from 'react';
import { ChevronRight } from 'lucide-react';
import { SettingsNavigateContext } from './controls';
import {
  requestNotificationSettings,
  type NotificationConversation,
} from '../../lib/notificationSettingsNavigation';

export function NotificationSettingsLink({
  settingId,
  children,
  conversation,
  onNavigate,
}: {
  settingId: string;
  children: string;
  conversation?: NotificationConversation;
  onNavigate?: () => void;
}) {
  const navigate = useContext(SettingsNavigateContext);
  return (
    <button
      type="button"
      className="weq-set-btn weq-set-btn-soft"
      onClick={() => {
        onNavigate?.();
        if (navigate && !conversation) navigate('global', settingId);
        else requestNotificationSettings({ settingId, conversation });
      }}
    >
      {children}
      <ChevronRight size={14} aria-hidden />
    </button>
  );
}
