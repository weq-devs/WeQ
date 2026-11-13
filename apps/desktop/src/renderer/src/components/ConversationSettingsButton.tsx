import { Settings2 } from 'lucide-react';
import { useContext, useState } from 'react';
import {
  ConversationSettingsNavigationContext,
  type ConversationSettingsRequest,
} from '../lib/conversationSettingsNavigation';
import { ConversationSettingsDialog } from './ConversationSettingsDialog';
import '../styles/conversation-settings-button.css';

export function ConversationSettingsButton({
  className = 'icon-button group-header-info-action',
  label = '会话设置',
  onClick,
}: {
  className?: string;
  label?: string;
  onClick: (anchor: HTMLButtonElement) => void;
}) {
  return (
    <button
      type="button"
      className={className}
      title={label}
      aria-label={label}
      onClick={(event) => onClick(event.currentTarget)}
    >
      <Settings2 size={18} />
    </button>
  );
}

export function ProfileConversationSettingsButton({
  request,
}: {
  request: ConversationSettingsRequest;
}) {
  const navigate = useContext(ConversationSettingsNavigationContext);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <ConversationSettingsButton
        className="icon-button group-header-info-action weq-profile-page-settings"
        onClick={(button) => {
          if (navigate) navigate({ ...request, anchor: button, onOpenProfile: () => {} });
          else setAnchor(button);
        }}
      />
      {anchor ? (
        <ConversationSettingsDialog
          {...request}
          anchor={anchor}
          onOpenProfile={() => setAnchor(null)}
          onClose={() => setAnchor(null)}
        />
      ) : null}
    </>
  );
}
