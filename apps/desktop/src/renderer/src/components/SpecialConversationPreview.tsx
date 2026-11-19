import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import type {
  Conversation,
  DirectConversation,
  Message,
  User,
} from '../im-template/template/types';
import type { MessageRenderer } from '../im-template/template/messageRenderers';
import type { ConcreteConversation, VirtualConversation } from '../lib/conversationDirectory';
import {
  readReadonlyOlderPage,
  readonlyConversationMessages,
  readonlyConversationTarget,
  type ReadonlyCursor,
  type ReadonlyTarget,
} from '../lib/readonlyConversation';
import { client } from '../trpc/client';
import { AssistantReplyContent } from '../views/agentlab/AssistantReplyContent';
import { persistedAssistantTurn } from '../views/agentlab/assistantTranscript';
import { AgentMessageContent } from '../views/agentlab/ChatBubble';
import {
  cloneChatConversation,
  cloneChatMessages,
  cloneChatUser,
} from '../views/agentlab/cloneChatAdapter';
import { AiImageGallery } from './AiImageComposer';
import { GapMessagesModal } from './compose/GapMessagesModal';

export interface PreviewProps {
  conversation: ConcreteConversation;
  binding: QQWriteBinding;
  user: User;
  virtual: readonly VirtualConversation[];
  renderers: MessageRenderer[];
  onClose: () => void;
  onLocateMessage: (message: Message) => void;
}

const PAGE_SIZE = 50;
const queryOptions = { retry: false, cacheTime: 0, refetchOnWindowFocus: false } as const;

/** 预览只读取记录，不挂载会提交阅读水位的聊天页。 */
export function SpecialConversationPreview(props: PreviewProps) {
  const { conversation } = props;
  if (conversation.generated)
    return <GeneratedPreview {...props} target={conversation.generated} />;
  if (conversation.type !== 'direct') return null;
  const source = readonlyConversationTarget(conversation);
  return source ? <ReadonlyPreview {...props} conversation={conversation} source={source} /> : null;
}

function ReadonlyPreview({
  conversation,
  binding,
  source,
  user,
  ...props
}: PreviewProps & { conversation: DirectConversation; source: ReadonlyTarget }) {
  const history = useInfiniteQuery({
    ...queryOptions,
    queryKey: ['conversation-preview', binding, source],
    queryFn: ({ pageParam }: { pageParam?: ReadonlyCursor }) =>
      readReadonlyOlderPage(source, binding, pageParam),
    getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
  });
  const messages = useMemo(() => {
    const rows = history.data?.pages.toReversed().flatMap((page) => page.items.toReversed()) ?? [];
    return readonlyConversationMessages(rows, source.kind, conversation, user);
  }, [history.data, source.kind, conversation, user]);
  return (
    <PreviewWindow
      {...props}
      conversation={conversation}
      user={user}
      messages={messages}
      loading={history.isLoading}
      loadingMore={history.isFetchingNextPage}
      error={
        history.error instanceof Error
          ? history.error.message
          : history.isError
            ? '读取消息失败'
            : null
      }
      hasMore={Boolean(history.hasNextPage)}
      onLoadMore={() => void history.fetchNextPage()}
      onRetry={() => void history.refetch()}
    />
  );
}

async function readGeneratedHistory(
  target: NonNullable<Conversation['generated']>,
  binding: QQWriteBinding,
) {
  if (target.kind === 'assistant') {
    if (!target.sessionId) throw new Error('缺少助手会话标识');
    const rows = await client.account.getAssistantConversation.query({
      ...binding,
      sessionId: target.sessionId,
    });
    return { kind: target.kind, rows: rows.filter((row) => row.status !== 'running') };
  }
  if (target.kind === 'group') {
    const rows = await client.account.getAgentLabGroupConversation.query({
      ...binding,
      groupId: target.ownerId,
    });
    return { kind: target.kind, rows };
  }
  const rows = await client.account.getAgentLabConversation.query({
    ...binding,
    personaId: target.ownerId,
  });
  return { kind: target.kind, rows };
}

function GeneratedPreview({
  target,
  conversation,
  user,
  virtual,
  binding,
  onClose,
  onLocateMessage,
}: PreviewProps & { target: NonNullable<Conversation['generated']> }) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const history = useQuery({
    ...queryOptions,
    queryKey: ['conversation-preview', binding, target],
    queryFn: () => readGeneratedHistory(target, binding),
  });
  const data = history.data;
  const presentation = useMemo(() => {
    const name =
      conversation.type === 'direct' ? conversation.otherUser.displayName : conversation.group.name;
    const persona = virtual.find((row) => row.kind === 'persona' && row.ownerId === target.ownerId);
    const peer =
      target.kind === 'assistant'
        ? { ...cloneChatUser('assistant', 'WeQ 助手'), kind: 'bot' as const }
        : cloneChatUser(target.ownerId, name, persona?.uin, true);
    const chat = cloneChatConversation({
      target,
      viewId: conversation.id,
      name,
      peer: { ...peer, displayName: name },
    });
    const start = Math.max(0, (data?.rows.length ?? 0) - limit);
    const personas = new Map(
      virtual.filter((row) => row.kind === 'persona').map((row) => [row.ownerId, row]),
    );
    const messages = cloneChatMessages(data?.rows.slice(start) ?? [], chat.id, (index) => {
      if (data?.kind !== 'group') return data?.rows[start + index]?.role === 'user' ? user : peer;
      const row = data.rows[start + index]!;
      if (row.senderKind === 'user') return user;
      const persona = personas.get(row.senderId);
      return cloneChatUser(row.senderId, persona?.name ?? '克隆体', persona?.uin, true);
    });
    const indices = new Map(messages.map((message, index) => [message.id, start + index]));
    const renderers: MessageRenderer[] = [
      {
        id: 'generated-preview',
        match: () => true,
        render: ({ message, mine }) => {
          const index = indices.get(message.id);
          if (index === undefined || !data) return null;
          if (data.kind === 'assistant') {
            const turn = data.rows[index];
            return turn ? <AssistantReplyContent turn={persistedAssistantTurn(turn)} /> : null;
          }
          const turn = data.rows[index];
          const personaId = data.kind === 'group' ? data.rows[index]?.senderId : target.ownerId;
          return turn ? (
            <>
              <AiImageGallery images={turn.images} outcomes={turn.imageOutcomes} />
              {turn.text ? (
                <AgentMessageContent
                  text={turn.text}
                  personaId={mine ? undefined : personaId}
                  sourceSession={{
                    id: turn.sourceSessionId,
                    title: turn.sourceSessionTitle,
                    messageId: turn.sourceMessageId,
                  }}
                />
              ) : null}
            </>
          ) : null;
        },
      },
    ];
    return { conversation: chat, messages, renderers, hasMore: start > 0 };
  }, [conversation, data, limit, target, user, virtual]);
  return (
    <PreviewWindow
      {...presentation}
      user={user}
      loading={history.isLoading}
      loadingMore={false}
      error={
        history.error instanceof Error
          ? history.error.message
          : history.isError
            ? '读取消息失败'
            : null
      }
      onLoadMore={() => setLimit((value) => value + PAGE_SIZE)}
      onRetry={() => void history.refetch()}
      onClose={onClose}
      onLocateMessage={onLocateMessage}
    />
  );
}

function PreviewWindow({
  messages,
  error,
  onLocateMessage,
  ...props
}: Pick<PreviewProps, 'user' | 'renderers' | 'onClose' | 'onLocateMessage'> & {
  conversation: Conversation;
  messages: Message[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  return (
    <GapMessagesModal
      {...props}
      preview
      title="预览会话"
      messages={messages}
      showSenderProfiles={false}
      error={messages.length ? null : error}
      moreFailed={Boolean(error)}
      totalCount={messages.length}
      onLocateMessage={({ msgId }) => {
        const message = messages.find((row) => row.id === msgId);
        if (message) onLocateMessage(message);
      }}
    />
  );
}
