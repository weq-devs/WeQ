import { useMemo, useContext } from 'react';
import { ReadonlyConversationPane } from './ReadonlyConversationPane';
import type { Conversation, User } from '../im-template/template/types';
import { ConversationDirectoryContext } from '../lib/conversationDirectory';

export function OfficialConversationPane({
  conversationId,
  title,
  user,
  anchorId,
  onBack,
  onEditMessage,
}: {
  conversationId: string;
  title: string;
  user: User;
  anchorId?: string;
  onBack: () => void;
  onEditMessage?: (id: string) => void;
}) {
  const directory = useContext(ConversationDirectoryContext);
  const service = conversationId.startsWith('service:');
  const id = service ? conversationId.slice(8) : conversationId;
  const target = useMemo(
    () =>
      service
        ? { kind: 'service' as const, appId: id }
        : { kind: 'official' as const, peerUid: id },
    [service, id],
  );
  const known = directory?.rows?.find((row) => row.id === conversationId);
  const conversation = useMemo<Conversation>(
    () =>
      known ?? {
        id: conversationId,
        type: 'direct',
        directoryKind: service ? 'service' : 'official',
        chatType: service ? 118 : 103,
        otherUser: {
          id,
          displayName: title,
          username: id,
          identityLabel: service ? 'AppID' : 'UID',
          identityValue: id,
          avatarUrl: null,
        },
        group: null,
        members: [],
        updatedAt: '',
        lastMessage: null,
      },
    [known, conversationId, service, id, title],
  );
  return (
    <ReadonlyConversationPane
      key={conversationId}
      target={target}
      conversation={conversation}
      user={user}
      anchorId={anchorId}
      onBack={onBack}
      onEditMessage={onEditMessage}
      sourceDetails={[
        { label: '类型', value: service ? '服务号' : '公众号' },
        { label: service ? 'AppID' : 'UID', value: id },
      ]}
    />
  );
}
