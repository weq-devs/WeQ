import {
  changePreference,
  preferenceValue,
  useClientPreferences,
} from '../../lib/clientPreferences';
import { Toggle } from './controls';

export function SharedDisplayToggle({
  name,
  label,
  fallback,
  disabled,
}: {
  name:
    | 'showMessageBubble'
    | 'showMessageFont'
    | 'showAvatarPendant'
    | 'showChatQqShow'
    | 'showMessageTime'
    | 'showMessageDate'
    | 'showMessageSeq'
    | 'keepConversationPositionOnHover'
    | 'allConversationsIncludeHidden'
    | 'allConversationsIncludeDeleted';
  label: string;
  fallback: boolean;
  disabled?: boolean;
}) {
  useClientPreferences((state) => state.tick);
  return (
    <Toggle
      label={label}
      disabled={disabled}
      checked={preferenceValue(name, fallback)}
      onChange={(value) => void changePreference(name, value)}
    />
  );
}
