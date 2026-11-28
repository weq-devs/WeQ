/**
 * 克隆私聊的数据源适配：页面、输入区、消息与多选全部由普通 ChatPane 渲染。
 * 每个克隆角色始终读写同一段长期对话，旧子会话由服务层合并。
 */
import { useMemo, useState, type ReactElement } from 'react';
import type { AgentLabModelSelection } from '@weq/agentlab';
import type { GeneratedSearchHit } from '../../components/search/types';
import { ChatPane } from '../../im-template/template/chatPane';
import { ChatRecordsModal } from '../../components/search/ChatRecordsModal';
import type { MessageRenderer } from '../../im-template/template/messageRenderers';
import { trpc } from '../../trpc/client';
import { AiImageComposer, AiImageGallery } from '../../components/AiImageComposer';
import { parseAiImageDraft, changeAiImageDraftText } from '../../lib/aiImageDraft';
import { useSharedAssistantDraft } from '../../hooks/useSharedAssistantDraft';
import type { AiImageRef, AiImageOutcome } from '@weq/agentlab';
import { useLiveCloneConversation } from './useLiveCloneConversation';
import { AgentMessageContent, type FaceContext } from './ChatBubble';
import { inputFaceContext } from './ChatBubble.shared';
import {
  cloneChatUser,
  cloneChatConversation,
  cloneChatMessages,
  cloneChatInput,
} from './cloneChatAdapter';

/** 左栏克隆体列表项的子集（面板只读这几个字段）。 */
export interface ClonePersonaLite {
  id: string;
  name: string;
  sourceId: string;
  sourceTitle: string;
  systemFaces?: string[] | null;
  models?: { chat?: AgentLabModelSelection | null } | null;
  corpusMessageCount?: number;
}

interface ChatTurn {
  images?: AiImageRef[];
  imageOutcomes?: AiImageOutcome[];
  id?: string;
  role: 'user' | 'assistant';
  text: string;
  /** 该条消息的时间戳（持久化回合来自库里的 ts，本地回合取发送/生成时刻）。 */
  ts: number;
  sourceSessionId?: string | null;
  sourceSessionTitle?: string;
  sourceMessageId?: string;
}

import { useDirectoryReadPosition } from '../../hooks/useDirectoryReadPosition';

export function CloneChatPanel({
  personaId,
  persona,
  searchTarget,
  readOnlyLegacy = false,
  selfUin,
  clonedUin,
  faces,
  onBack,
  onOpenSettings,
}: {
  personaId: string;
  persona: ClonePersonaLite;
  /** 真实会话 id；null = 草稿会话（首条消息才落库）。 */
  sessionId?: string | null;
  searchTarget?: GeneratedSearchHit;
  readOnlyLegacy?: boolean;
  selfUin?: string;
  clonedUin?: string;
  faces?: FaceContext;
  /** 头部副标题（provider · 模型 · 样本 N 条）。 */
  modelLabel: string;
  onBack: () => void;
  /** 草稿会话首条消息落库后回调（父组件据此把选中态指向新会话，不换 key）。 */
  onSessionCreated?: (sessionId: string) => void;
  /** 切到同一克隆体的另一段会话（克隆体进了会话列表后，只剩这里能切）。 */
  onSwitchSession?: (sessionId: string) => void;
  onNewSession?: () => void;
  onOpenSettings: (anchor?: HTMLElement) => void;
}): ReactElement {
  const userFaces = useMemo(() => (faces ? inputFaceContext(faces.descToId) : undefined), [faces]);
  const legacy = readOnlyLegacy;
  const conversation = trpc.account.getAgentLabConversation.useQuery(
    { personaId },
    { staleTime: 0, refetchOnMount: 'always' },
  );

  const { history, send, typing, ready } = useLiveCloneConversation<ChatTurn>(
    'persona',
    personaId,
    searchTarget && conversation.isFetching && !conversation.isFetchedAfterMount
      ? undefined
      : conversation.data,
    !legacy,
    (event) => (event.kind === 'persona-message' ? event.message : undefined),
  );
  useDirectoryReadPosition(
    `persona:${personaId}`,
    String(
      history.reduce((max, turn) => (turn.role === 'assistant' ? Math.max(max, turn.ts) : max), 0),
    ),
  );
  const [input, setInput] = useState('');
  const [imageUploading, setImageUploading] = useState(false);
  const [searchState, setSearchState] = useState<'closed' | 'open' | 'suspended'>('closed');
  const [jumpRequest, setJumpRequest] = useState(
    searchTarget ? { messageId: searchTarget.messageId, revision: 0 } : undefined,
  );
  const viewId = `virtual:clone:persona:${personaId}`;
  const sharedDraft = useSharedAssistantDraft(viewId, input, setInput, !legacy);
  const user = useMemo(() => cloneChatUser('self', '我', selfUin), [selfUin]);
  const peer = useMemo(
    () => cloneChatUser(personaId, persona.name, clonedUin, true),
    [personaId, persona.name, clonedUin],
  );
  const chatConversation = useMemo(
    () =>
      cloneChatConversation({
        target: {
          kind: 'persona',
          ownerId: personaId,
          sessionId: null,
        },
        viewId,
        name: persona.name,
        peer,
      }),
    [personaId, viewId, persona.name, peer],
  );
  const messages = useMemo(
    () =>
      cloneChatMessages(history, viewId, (index) =>
        history[index]?.role === 'user' ? user : peer,
      ),
    [history, viewId, user, peer],
  );
  const sourceMessages = useMemo(
    () => new Map(history.map((message, index) => [messages[index]?.id ?? message.id, message])),
    [history, messages],
  );
  const renderers = useMemo<MessageRenderer[]>(
    () => [
      {
        id: 'generated-content',
        match: () => true,
        render: ({ message, mine }) => (
          <>
            <AiImageGallery
              images={sourceMessages.get(message.id)?.images}
              outcomes={sourceMessages.get(message.id)?.imageOutcomes}
            />
            {(sourceMessages.get(message.id)?.text ?? message.body) ? (
              <AgentMessageContent
                text={sourceMessages.get(message.id)?.text ?? message.body}
                faces={mine ? userFaces : faces}
                personaId={mine ? undefined : personaId}
                sourceSession={{
                  id: sourceMessages.get(message.id)?.sourceSessionId,
                  title: sourceMessages.get(message.id)?.sourceSessionTitle,
                  messageId: sourceMessages.get(message.id)?.sourceMessageId,
                }}
              />
            ) : null}
          </>
        ),
      },
    ],
    [userFaces, faces, personaId, sourceMessages],
  );

  async function onSend(body: string): Promise<void> {
    if (legacy || !ready || imageUploading) return;
    const text = cloneChatInput(body, faces?.descToId ?? new Map()).trim();
    const images = parseAiImageDraft(input).images;
    if (!text && !images.length) return;
    const clearSubmittedDraft = sharedDraft.prepareSubmitted(input);
    setJumpRequest(undefined);
    setInput('');
    await send(text, images, (id, ts) => ({ id, ts, role: 'user', text, images }));
    void clearSubmittedDraft().catch(() => {});
  }

  return (
    <>
      <AiImageComposer
        fill
        value={input}
        setValue={setInput}
        disabled={legacy || !ready}
        onBusyChange={setImageUploading}
        onSendImages={() => {
          void onSend(parseAiImageDraft(input).text).catch(() => {});
        }}
      >
        {(attachments, imageButton) => (
          <ChatPane
            composerAttachments={attachments}
            composerToolbar={imageButton}
            hasExternalAttachments={parseAiImageDraft(input).images.length > 0}
            loadError={conversation.isError ? '记录加载失败' : undefined}
            user={user}
            conversation={chatConversation}
            messages={messages}
            messageRenderers={renderers}
            loading={Boolean(conversation.isFetching && !history.length)}
            preference={undefined}
            draft={parseAiImageDraft(input).text}
            onDraftChange={(_id, value) =>
              setInput((current) => changeAiImageDraftText(current, value))
            }
            onDraftClear={() => setInput('')}
            onSend={onSend}
            onBack={onBack}
            sendAvailable={!legacy && ready && !imageUploading}
            readOnly={legacy}
            sendBlockedReason={
              legacy ? '旧版对话（只读）' : imageUploading ? '正在准备图片' : '账号尚未就绪'
            }
            peerTyping={typing ? '对方正在输入…' : undefined}
            settingsLabel="克隆体设置"
            onOpenConversationSettings={(_conversation, anchor) => onOpenSettings(anchor)}
            onSearchChatRecords={() => setSearchState('open')}
            jumpRequest={jumpRequest}
          />
        )}
      </AiImageComposer>
      {searchState !== 'closed' ? (
        <ChatRecordsModal
          key={viewId}
          fixed
          suspended={searchState === 'suspended'}
          initialKeyword=""
          initialHit={{
            category: 'chatRecord',
            source: 'buddy',
            partition: viewId,
            targetUid: viewId,
            targetUin: '',
            name: persona.name,
            count: messages.length,
          }}
          renderers={renderers}
          localSource={{
            conversation: chatConversation,
            messages,
            user,
            onJump: (id) =>
              setJumpRequest((request) => ({
                messageId: id,
                revision: (request?.revision ?? 0) + 1,
              })),
          }}
          onClose={() => setSearchState('closed')}
          onSuspend={() => setSearchState('suspended')}
          onJumpMessage={() => {}}
        />
      ) : null}
    </>
  );
}
