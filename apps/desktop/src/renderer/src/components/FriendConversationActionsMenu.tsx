import type { ComponentProps } from 'react';
import { FEATURE_ICONS } from '../lib/featureIcons.shared';
import { ConversationActionsMenu, type ConversationMenuAction } from './ConversationActionsMenu';
import { useFriendSpecialCare } from '../hooks/useFriendSpecialCare';

type FriendMenuProps = ComponentProps<typeof ConversationActionsMenu> & {
  friendUid?: string;
  removeFriend?: ConversationMenuAction;
};

export function FriendConversationActionsMenu({
  friendUid,
  removeFriend,
  ...props
}: FriendMenuProps) {
  if (!friendUid?.startsWith('u_')) {
    return (
      <ConversationActionsMenu
        {...props}
        actions={removeFriend ? [...props.actions, removeFriend] : props.actions}
      />
    );
  }
  return <FriendActions {...props} friendUid={friendUid} removeFriend={removeFriend} />;
}

function FriendActions({ friendUid, removeFriend, actions, ...props }: FriendMenuProps) {
  const uid = friendUid;
  const care = useFriendSpecialCare(uid);
  return (
    <ConversationActionsMenu
      {...props}
      actions={[
        ...actions,
        ...(uid
          ? [
              {
                label: care.enabled ? '取消特别关心' : '特别关心',
                icon: <FEATURE_ICONS.specialCare size={16} aria-hidden />,
                disabled: care.disabled,
                reason: care.reason,
                keepOpen: true,
                action: () => {
                  void care.change(!care.enabled).finally(props.onClose);
                },
              },
            ]
          : []),
        ...(removeFriend ? [removeFriend] : []),
      ]}
    />
  );
}
