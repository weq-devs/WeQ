import { useMemo, useState } from 'react';
import { MemberProfileCard } from '../../components/MemberProfileCard';
import { GapMessagesModal } from '../../components/compose/GapMessagesModal';
import type { Conversation, Message, User } from '../../im-template/template/types';
import type { MessageRenderer } from '../../im-template/template/messageRenderers';
import { trpc } from '../../trpc/client';
import { AgentMessageContent } from './ChatBubble';
import { cloneChatConversation, cloneChatMessages } from './cloneChatAdapter';

/** 名片操作只使用本地克隆身份；预览复用普通名片的只读消息列表。 */
export function CloneMemberProfileCard({
  member,
  anchor,
  user,
  conversation,
  messages,
  onClose,
  onOpenChat,
}: {
  member: User;
  anchor: { x: number; y: number };
  user: User;
  conversation: Conversation;
  messages: Message[];
  onClose: () => void;
  onOpenChat?: () => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const personaId = member.id.startsWith('virtual:') ? member.id.slice('virtual:'.length) : '';
  const current = conversation.type === 'direct' && conversation.otherUser.id === member.id;
  const remotePreview = previewOpen && !current && Boolean(member.clone && personaId);
  const sessions = trpc.account.listAgentLabPersonaSessions.useQuery(
    { personaId },
    { enabled: remotePreview },
  );
  const sessionId = sessions.data?.[0]?.id;
  const saved = trpc.account.getAgentLabPersonaSessionConversation.useQuery(
    { personaId, sessionId: sessionId ?? '' },
    { enabled: remotePreview && Boolean(sessionId) },
  );
  const legacy = trpc.account.getAgentLabConversation.useQuery(
    { personaId },
    { enabled: remotePreview && sessions.isSuccess && !sessionId },
  );
  const query = sessionId ? saved : legacy;
  const previewConversation = useMemo(
    () =>
      current
        ? conversation
        : cloneChatConversation({
            target: { kind: 'persona', ownerId: personaId, sessionId: sessionId ?? null },
            viewId: `virtual:preview:${personaId}`,
            name: member.displayName,
            peer: member,
          }),
    [current, conversation, personaId, sessionId, member],
  );
  const previewMessages = useMemo(
    () =>
      current
        ? messages
        : cloneChatMessages(query.data ?? [], previewConversation.id, (index) =>
            query.data?.[index]?.role === 'user' ? user : member,
          ),
    [current, messages, query.data, previewConversation.id, user, member],
  );
  const renderers = useMemo<MessageRenderer[]>(
    () => [
      {
        id: 'clone-profile-preview',
        match: () => true,
        render: ({ message, mine }) => (
          <AgentMessageContent text={message.body} personaId={mine ? undefined : personaId} />
        ),
      },
    ],
    [personaId],
  );
  const error = sessions.error ?? query.error;
  return (
    <MemberProfileCard
      member={member}
      anchor={anchor}
      onClose={onClose}
      localClone
      onOpenChat={member.clone ? onOpenChat : undefined}
      onPreviewChat={member.clone ? () => setPreviewOpen(true) : undefined}
      previewContent={
        previewOpen ? (
          <GapMessagesModal
            preview
            embedded
            conversation={previewConversation}
            user={user}
            messages={previewMessages}
            renderers={renderers}
            loading={!current && (sessions.isLoading || (!sessions.isError && query.isLoading))}
            loadingMore={false}
            error={current ? null : (error?.message ?? null)}
            hasMore={false}
            moreFailed={false}
            totalCount={previewMessages.length}
            onLoadMore={() => {}}
            onRetry={() => {
              void sessions.refetch();
              void query.refetch();
            }}
            onClose={() => setPreviewOpen(false)}
          />
        ) : undefined
      }
    />
  );
}
