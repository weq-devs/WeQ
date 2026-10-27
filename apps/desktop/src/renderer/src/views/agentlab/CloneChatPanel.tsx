/**
 * 克隆私聊的数据源适配：页面、输入区、消息与多选全部由普通 ChatPane 渲染。
 *  - 草稿会话：点克隆体进来就是新草稿，发第一条消息才落库建会话（sessionId null → 真 id），
 *    期间组件不重挂载、流式不中断（navKey 由父组件维持）。
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { AgentLabModelSelection } from '@weq/agentlab';
import type { GeneratedSearchHit } from '../../components/search/types';
import { ChatPane } from '../../im-template/template/chatPane';
import { ChatRecordsModal } from '../../components/search/ChatRecordsModal';
import type { MessageRenderer } from '../../im-template/template/messageRenderers';
import { trpc } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';
import { AgentMessageContent, inputFaceContext, type FaceContext } from './ChatBubble';
import {
  cloneChatUser,
  cloneChatConversation,
  cloneChatMessages,
  cloneChatInput,
} from './cloneChatAdapter';
import { SessionSwitcher } from './SessionSwitcher';

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
  id?: string;
  role: 'user' | 'assistant';
  text: string;
  /** 该条消息的时间戳（持久化回合来自库里的 ts，本地回合取发送/生成时刻）。 */
  ts: number;
}

export function CloneChatPanel({
  personaId,
  persona,
  sessionId,
  searchTarget,
  readOnlyLegacy = false,
  selfUin,
  clonedUin,
  faces,
  onBack,
  onSessionCreated,
  onSwitchSession,
  onNewSession,
  onOpenSettings,
}: {
  personaId: string;
  persona: ClonePersonaLite;
  /** 真实会话 id；null = 草稿会话（首条消息才落库）。 */
  sessionId: string | null;
  searchTarget?: GeneratedSearchHit;
  readOnlyLegacy?: boolean;
  selfUin?: string;
  clonedUin?: string;
  faces?: FaceContext;
  /** 头部副标题（provider · 模型 · 样本 N 条）。 */
  modelLabel: string;
  onBack: () => void;
  /** 草稿会话首条消息落库后回调（父组件据此把选中态指向新会话，不换 key）。 */
  onSessionCreated: (sessionId: string) => void;
  /** 切到同一克隆体的另一段会话（克隆体进了会话列表后，只剩这里能切）。 */
  onSwitchSession: (sessionId: string) => void;
  onNewSession: () => void;
  onOpenSettings: () => void;
}): ReactElement {
  const dialog = useAppDialog();
  const userFaces = useMemo(() => (faces ? inputFaceContext(faces.descToId) : undefined), [faces]);
  const utils = trpc.useUtils();
  const chat = trpc.account.chatWithAgentLabPersona.useMutation();
  const createSession = trpc.account.createAgentLabPersonaSession.useMutation();
  const deleteSession = trpc.account.deleteAgentLabPersonaSession.useMutation();
  const sessionList = trpc.account.listAgentLabPersonaSessions.useQuery(
    { personaId },
    { staleTime: 0 },
  );
  // 页面身份在草稿升级时保持稳定，查询身份则切到持久会话以接管正式消息 ID。
  const initialSessionId = useRef(sessionId).current;
  const [currentSessionId, setCurrentSessionId] = useState(sessionId);
  const sessionIdRef = useRef<string | null>(sessionId);
  const legacy = readOnlyLegacy || Boolean(searchTarget && searchTarget.sessionId === null);
  const sessionConversation = trpc.account.getAgentLabPersonaSessionConversation.useQuery(
    { personaId, sessionId: currentSessionId ?? '' },
    {
      enabled: !!currentSessionId,
      staleTime: 0,
      refetchOnMount: 'always',
    },
  );
  const legacyConversation = trpc.account.getAgentLabConversation.useQuery(
    { personaId },
    { enabled: legacy, staleTime: 0, refetchOnMount: 'always' },
  );
  const conversation = legacy ? legacyConversation : sessionConversation;

  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [animating, setAnimating] = useState(false);
  const seeded = useRef(false);
  const lastPersisted = useRef(conversation.data);
  const [searchOpen, setSearchOpen] = useState(false);
  const [jumpRequest, setJumpRequest] = useState(
    searchTarget ? { messageId: searchTarget.messageId, revision: 0 } : undefined,
  );
  const viewId = useRef(`virtual:clone:persona:${personaId}:${sessionId ?? 'draft'}`).current;
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
          sessionId: legacy ? null : currentSessionId,
        },
        viewId,
        name: persona.name,
        peer,
      }),
    [personaId, legacy, currentSessionId, viewId, persona.name, peer],
  );
  const messages = useMemo(
    () =>
      cloneChatMessages(history, viewId, (index) =>
        history[index]?.role === 'user' ? user : peer,
      ),
    [history, viewId, user, peer],
  );
  const renderers = useMemo<MessageRenderer[]>(
    () => [
      {
        id: 'generated-content',
        match: () => true,
        render: ({ message, mine }) => (
          <AgentMessageContent
            text={message.body}
            faces={mine ? userFaces : faces}
            personaId={mine ? undefined : personaId}
          />
        ),
      },
    ],
    [userFaces, faces, personaId],
  );

  // 首次加载持久化对话（真实会话）。
  useEffect(() => {
    if (
      !animating &&
      conversation.data &&
      !conversation.isFetching &&
      (!seeded.current || lastPersisted.current !== conversation.data)
    ) {
      setHistory(
        conversation.data.map((t) => ({ id: t.id, role: t.role, text: t.text, ts: t.ts })),
      );
      seeded.current = true;
      lastPersisted.current = conversation.data;
    }
  }, [conversation.data, conversation.isFetching, searchTarget, animating]);

  async function onSend(body: string): Promise<void> {
    if (legacy || !personaId || chat.isLoading || animating) return;
    const text = cloneChatInput(body, faces?.descToId ?? new Map()).trim();
    if (!text) return;
    setJumpRequest(undefined);
    setAnimating(true);
    setInput('');
    const nextHistory = [...history, { role: 'user' as const, text, ts: Date.now() }];
    setHistory(nextHistory);
    try {
      // 草稿会话：真正发第一条消息时才落库建会话（与 WeQ 助手一致）。
      let id = sessionIdRef.current;
      if (!id) {
        const session = await createSession.mutateAsync({ personaId });
        id = session.id;
        sessionIdRef.current = id;
        setCurrentSessionId(id);
        seeded.current = true; // 新会话无历史可 seed，别被首帧空对话覆盖本地 turns
        await utils.account.listAgentLabPersonaSessions.invalidate({ personaId });
        onSessionCreated(id);
      }
      const result = await chat.mutateAsync({ personaId, text, history, sessionId: id });
      // 多会话兜底：后端重建了会话时采纳新 id。
      if (result.sessionId && result.sessionId !== id) {
        sessionIdRef.current = result.sessionId;
        setCurrentSessionId(result.sessionId);
        onSessionCreated(result.sessionId);
      }
      // 首句标题 / 时间刷新由后端落库，这里让列表跟上。
      void utils.account.listAgentLabPersonaSessions.invalidate({ personaId });
      void utils.account.listAgentLabPersonas.invalidate();
      // 发言意愿对私聊生效且这次「懒得回」：只保留用户这条，不加回复气泡。
      if (result.silent) {
        seeded.current = true;
        void utils.account.getAgentLabPersonaSessionConversation.invalidate({
          personaId,
          sessionId: sessionIdRef.current ?? id,
        });
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
      void utils.account.getAgentLabPersonaSessionConversation.invalidate({
        personaId,
        sessionId: sessionIdRef.current ?? id,
      });
    } catch (error) {
      // 生成失败前可能已经保存用户消息，主列表仍需读取实际活动时间。
      void utils.account.listAgentLabPersonas.invalidate();
      dialog.error('发送失败', error instanceof Error ? error.message : String(error));
      setHistory(history);
      throw error;
    } finally {
      setAnimating(false);
      if (sessionIdRef.current)
        void utils.account.getAgentLabPersonaSessionConversation.invalidate({
          personaId,
          sessionId: sessionIdRef.current,
        });
    }
  }

  return (
    <>
      <ChatPane
        loadError={conversation.isError ? '记录加载失败' : undefined}
        user={user}
        conversation={chatConversation}
        messages={messages}
        messageRenderers={renderers}
        loading={Boolean(
          conversation.isFetching && !history.length && (initialSessionId || legacy),
        )}
        preference={undefined}
        draft={input}
        onDraftChange={(_id, value) => setInput(value)}
        onDraftClear={() => setInput('')}
        onSend={onSend}
        onBack={onBack}
        sendAvailable={!legacy && !chat.isLoading && !animating}
        readOnly={legacy}
        sendBlockedReason={legacy ? '旧版对话（只读）' : '克隆体正在回复'}
        settingsLabel="克隆体设置"
        onOpenConversationSettings={onOpenSettings}
        onSearchChatRecords={() => setSearchOpen(true)}
        jumpRequest={jumpRequest}
        headerActions={
          <SessionSwitcher
            sessions={sessionList.data ?? []}
            activeSessionId={sessionIdRef.current}
            draft={!legacy && !sessionIdRef.current}
            loading={sessionList.isLoading}
            disabled={legacy}
            compact
            onSwitch={onSwitchSession}
            onNew={onNewSession}
            onDelete={(target) => {
              void (async () => {
                const ok = await dialog.confirm('删除会话', '确认删除这段对话？删除后无法恢复。', {
                  okLabel: '删除',
                  tone: 'warning',
                });
                // confirm 的 okLabel 已经写明是删除，不再二次确认。
                if (!ok) return;
                await deleteSession.mutateAsync({ personaId, sessionId: target });
                await utils.account.listAgentLabPersonaSessions.invalidate({ personaId });
                // 删的就是当前这段：退回新草稿，避免停在一个已不存在的会话上。
                if (sessionIdRef.current === target) onNewSession();
              })();
            }}
          />
        }
      />
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
