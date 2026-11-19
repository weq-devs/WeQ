import { useEffect, useState } from 'react';
import { UserRoundPlus, UsersRound } from 'lucide-react';
import { useGroupFriendSources } from '../../hooks/useGroupFriendSources';
import type { GroupConversation, GroupMember } from '../../im-template/template/types';
import { ConversationActionsMenu, type ConversationMenuAction } from '../ConversationActionsMenu';
import { NumericText } from '../NumericText';
import { GroupCardMemberList } from './GroupCardMemberList';

export function GroupMemberActionsMenu({
  conversation,
  menu,
  actions,
  onClose,
  onOpenMember,
}: {
  conversation: GroupConversation;
  menu: { x: number; y: number; anchor: HTMLElement };
  actions: ConversationMenuAction[];
  onClose: () => void;
  onOpenMember?: (member: GroupMember, anchor: { x: number; y: number }) => void;
}) {
  const sources = useGroupFriendSources(conversation.id);
  const { data, scope } = sources;
  const [list, setList] = useState<'friends' | 'addedFriends' | null>(null);
  useEffect(() => setList(null), [scope]);

  if (list) {
    return (
      <GroupCardMemberList
        conversation={conversation}
        anchor={menu.anchor}
        ownerUid={conversation.members.find((member) => member.role === 'owner')?.id}
        kind={list}
        includedUids={
          data ? new Set(list === 'addedFriends' ? data.addedUids : data.friendUids) : undefined
        }
        onClose={onClose}
        onOpenMember={onOpenMember}
      />
    );
  }

  return (
    <ConversationActionsMenu
      x={menu.x}
      y={menu.y}
      dropdown
      label="成员操作"
      onClose={onClose}
      actions={[
        {
          label: '群内好友',
          icon: <UsersRound size={15} />,
          detail: data ? (
            <NumericText>{`${data.friendUids.length}${data.rosterComplete ? '' : '+'}`}</NumericText>
          ) : undefined,
          keepOpen: true,
          action: () => setList('friends'),
        },
        {
          label: '在本群添加的好友',
          icon: <UserRoundPlus size={15} />,
          detail: <NumericText>{sources.text}</NumericText>,
          disabled: sources.disabled,
          reason: sources.reason,
          keepOpen: true,
          action: () => sources.activate(() => setList('addedFriends')),
        },
        ...actions,
      ]}
    />
  );
}
