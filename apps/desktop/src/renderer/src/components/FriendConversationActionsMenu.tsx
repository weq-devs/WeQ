import type { ComponentProps } from 'react';
import { Sparkles } from 'lucide-react';
import { ConversationActionsMenu } from './ConversationActionsMenu';
import { useFriendSpecialCare } from '../hooks/useFriendSpecialCare';

export function FriendConversationActionsMenu({
  friendUid,
  ...props
}: ComponentProps<typeof ConversationActionsMenu> & { friendUid?: string }) {
  if (!friendUid?.startsWith('u_')) return <ConversationActionsMenu {...props} />;
  return <FriendActions {...props} friendUid={friendUid} />;
}

function FriendActions({
  friendUid,
  actions,
  ...props
}: ComponentProps<typeof ConversationActionsMenu> & { friendUid?: string }) {
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
                icon: <Sparkles size={16} />,
                disabled: care.disabled,
                reason: care.reason,
                keepOpen: true,
                action: () => {
                  void care.change(!care.enabled).finally(props.onClose);
                },
              },
            ]
          : []),
      ]}
    />
  );
}
