/**
 * 克隆私聊的数据源适配：页面、输入区、消息与多选全部由普通 ChatPane 渲染。
 * 每个克隆角色始终读写同一段长期对话，旧子会话由服务层合并。
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
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
import { useAppDialog } from '../../lib/dialogUtils';
import { AgentMessageContent, inputFaceContext, type FaceContext } from './ChatBubble';
import {
  cloneChatUser,
  cloneChatConversation,
  cloneChatMessages,
  cloneChatInput,
} from './cloneChatAdapter';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  onOpenSettings: () => void;
}): ReactElement {
  const dialog = useAppDialog();
  const userFaces = useMemo(() => (faces ? inputFaceContext(faces.descToId) : undefined), [faces]);
  const utils = trpc.useUtils();
  const chat = trpc.account.chatWithAgentLabPersona.useMutation();
  const legacy = readOnlyLegacy;
  const conversation = trpc.account.getAgentLabConversation.useQuery(
    { personaId },
    { staleTime: 0, refetchOnMount: 'always' },
  );

  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [imageUploading, setImageUploading] = useState(false);
  const [animating, setAnimating] = useState(false);
  const seeded = useRef(false);
  const lastPersisted = useRef(conversation.data);
  const [searchOpen, setSearchOpen] = useState(false);
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

  // 首次加载持久化对话（真实会话）。
  useEffect(() => {
    if (
      !animating &&
      conversation.data &&
      !conversation.isFetching &&
      (!seeded.current || lastPersisted.current !== conversation.data)
    ) {
      setHistory(conversation.data.map((t) => ({ ...t })));
      seeded.current = true;
      lastPersisted.current = conversation.data;
    }
  }, [conversation.data, conversation.isFetching, searchTarget, animating]);

  async function onSend(body: string): Promise<void> {
    if (legacy || !personaId || chat.isLoading || animating || imageUploading) return;
    const text = cloneChatInput(body, faces?.descToId ?? new Map()).trim();
    const images = parseAiImageDraft(input).images;
    if (!text && !images.length) return;
    const submitted = input;
    const clearSubmittedDraft = sharedDraft.prepareSubmitted(submitted);
    setJumpRequest(undefined);
    setAnimating(true);
    setInput('');
    const nextHistory = [...history, { role: 'user' as const, text, images, ts: Date.now() }];
    setHistory(nextHistory);
    try {
      const result = await chat.mutateAsync({
        personaId,
        text,
        images,
        history: history.map(({ role, text }) => ({ role, text: text || '[图片]' })),
      });
      void clearSubmittedDraft().catch(() => {});
      // 首句标题 / 时间刷新由后端落库，这里让列表跟上。
      void utils.account.listAgentLabPersonas.invalidate();
      // 发言意愿对私聊生效且这次「懒得回」：只保留用户这条，不加回复气泡。
      if (result.silent) {
        seeded.current = true;
        void utils.account.getAgentLabConversation.invalidate({ personaId });
        return;
      }
      const segments =
        result.renderedTurns && result.renderedTurns.length > 0
          ? [...result.renderedTurns]
          : [
              ...(result.segments ?? []),
              ...(result.sticker ? [`[[sticker:${result.sticker.md5}]]`] : []),
            ];
      if (segments.length === 0) segments.push(result.text);
      await sleep(Math.min(1800, result.replyDelayMs ?? 500));
      let acc = nextHistory;
      for (let i = 0; i < segments.length; i += 1) {
        const seg = segments[i]!;
        acc = [...acc, { role: 'assistant' as const, text: seg, ts: Date.now() }];
        setHistory(acc);
        if (i < segments.length - 1) {
          await sleep(Math.min(1600, 320 + seg.length * 55));
        }
      }
      // 让持久化对话缓存跟上（后端已逐条落库）；否则切走再切回会从陈旧缓存 reseed 丢消息。
      seeded.current = true;
      void utils.account.getAgentLabConversation.invalidate({ personaId });
    } catch (error) {
      // 生成失败前可能已经保存用户消息，主列表仍需读取实际活动时间。
      void utils.account.listAgentLabPersonas.invalidate();
      dialog.error('发送失败', error instanceof Error ? error.message : String(error));
      setHistory(history);
      setInput((current) => current || submitted);
      throw error;
    } finally {
      setAnimating(false);
      void utils.account.getAgentLabConversation.invalidate({ personaId });
    }
  }

  return (
    <>
      <AiImageComposer
        fill
        value={input}
        setValue={setInput}
        disabled={legacy || chat.isLoading || animating}
        onBusyChange={setImageUploading}
        onSendImages={() => {
          void onSend(parseAiImageDraft(input).text).catch(() => {});
        }}
      >
        {(attachments) => (
          <ChatPane
            composerAttachments={attachments}
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
            sendAvailable={!legacy && !chat.isLoading && !animating && !imageUploading}
            readOnly={legacy}
            sendBlockedReason={
              legacy ? '旧版对话（只读）' : imageUploading ? '正在准备图片' : '克隆体正在回复'
            }
            settingsLabel="克隆体设置"
            onOpenConversationSettings={onOpenSettings}
            onSearchChatRecords={() => setSearchOpen(true)}
            jumpRequest={jumpRequest}
          />
        )}
      </AiImageComposer>
      {searchOpen ? (
        <ChatRecordsModal
          fixed
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
          onClose={() => setSearchOpen(false)}
          onJumpMessage={() => {}}
        />
      ) : null}
    </>
  );
}
