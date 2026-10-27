/**
 * 克隆体私聊面板：
 *  - 会话管理（查看/切换/新建/删除）在左栏克隆体条目里完成，聊天区只负责对话。
 *  - 草稿会话：点克隆体进来就是新草稿，发第一条消息才落库建会话（sessionId null → 真 id），
 *    期间组件不重挂载、流式不中断（navKey 由父组件维持）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { AgentLabModelSelection } from '@weq/agentlab';
import type { GeneratedSearchHit } from '../../components/search/types';
import {
  CloneSearchButton,
  GeneratedSearchNotice,
  jumpToGeneratedMessage,
  useGeneratedSearchJump,
} from './messageSearch';
import { Download, MessageSquareText, Settings2 } from 'lucide-react';
import { CloneMessageActions } from './CloneMessageActions';
import { EmptyState } from '../../im-template/template/primitives';
import { trpc } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';
import { CloneComposer, CloneConversation, CloneConversationHeader } from './CloneConversation';
import { ChatBubble, inputFaceContext, type FaceContext } from './ChatBubble';
import { ChatTimeDivider, shouldShowChatTime } from './messageTime';
import { SessionSwitcher } from './SessionSwitcher';
import { useGeneratedSelection } from './useGeneratedSelection';

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
  modelLabel,
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
  // 挂载时快照初始 id：草稿(null) 与既有会话在本组件生命周期内身份固定，
  // 之后父组件把草稿升级成真会话（sessionId 由 null 变真）不重新拉历史，避免闪断。
  const initialSessionId = useRef(sessionId).current;
  const sessionIdRef = useRef<string | null>(sessionId);
  const legacy = readOnlyLegacy || Boolean(searchTarget && searchTarget.sessionId === null);
  const sessionConversation = trpc.account.getAgentLabPersonaSessionConversation.useQuery(
    { personaId, sessionId: initialSessionId ?? '' },
    {
      enabled: !!initialSessionId,
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
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [searchMessageId, setSearchMessageId] = useState(searchTarget?.messageId ?? null);
  const missingSearch = useGeneratedSearchJump(
    transcriptRef,
    searchMessageId,
    conversation.isSuccess && !conversation.isFetching,
    history,
  );
  const selection = useGeneratedSelection(
    { kind: 'persona', ownerId: personaId, sessionId: legacy ? null : sessionIdRef.current },
    history,
    Boolean((legacy || sessionIdRef.current) && history.some((item) => item.id)),
  );

  const scrollTranscriptToBottom = useCallback((): void => {
    if (searchMessageId) return;
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    });
  }, [searchMessageId]);

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

  useEffect(() => {
    scrollTranscriptToBottom();
  }, [history, chat.isLoading, scrollTranscriptToBottom]);

  async function onSend(): Promise<void> {
    if (legacy || !personaId || !input.trim() || chat.isLoading || animating) return;
    setSearchMessageId(null);
    const text = input.trim();
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
        seeded.current = true; // 新会话无历史可 seed，别被首帧空对话覆盖本地 turns
        await utils.account.listAgentLabPersonaSessions.invalidate({ personaId });
        onSessionCreated(id);
      }
      const result = await chat.mutateAsync({ personaId, text, history, sessionId: id });
      // 多会话兜底：后端重建了会话时采纳新 id。
      if (result.sessionId && result.sessionId !== id) {
        sessionIdRef.current = result.sessionId;
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
      setInput(text);
    } finally {
      setAnimating(false);
    }
  }

  return (
    <CloneConversation selectionMode={selection.selectionMode}>
      <CloneConversationHeader
        name={persona.name}
        detail={modelLabel}
        onBack={onBack}
        actions={
          <>
            <CloneSearchButton
              messages={history}
              onJump={(id) => {
                setSearchMessageId(id);
                jumpToGeneratedMessage(transcriptRef.current, id);
              }}
            />
            <CloneMessageActions
              actions={[
                {
                  label: '导出',
                  icon: <Download size={16} />,
                  action: () => selection.exportConversation?.(),
                  disabled: !selection.exportConversation,
                },
              ]}
            />
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
                  const ok = await dialog.confirm(
                    '删除会话',
                    '确认删除这段对话？删除后无法恢复。',
                    {
                      okLabel: '删除',
                      tone: 'warning',
                    },
                  );
                  // confirm 的 okLabel 已经写明是删除，不再二次确认。
                  if (!ok) return;
                  await deleteSession.mutateAsync({ personaId, sessionId: target });
                  await utils.account.listAgentLabPersonaSessions.invalidate({ personaId });
                  // 删的就是当前这段：退回新草稿，避免停在一个已不存在的会话上。
                  if (sessionIdRef.current === target) onNewSession();
                })();
              }}
            />
            <button
              type="button"
              className="icon-button group-header-info-action"
              onClick={onOpenSettings}
              title="会话设置"
              aria-label="克隆设置"
            >
              <Settings2 size={18} />
            </button>
          </>
        }
      />

      <div
        className="message-scroll"
        {...selection.rootProps}
        ref={(element) => {
          transcriptRef.current = element;
          selection.rootProps.ref(element);
        }}
      >
        <GeneratedSearchNotice
          missing={missingSearch}
          error={Boolean(searchMessageId && conversation.isError)}
        />
        {searchMessageId && conversation.isFetching ? (
          <div className="weq-agentlab-empty">加载记录中…</div>
        ) : history.length === 0 ? (
          <EmptyState title="还没有消息" body="发出第一条消息。" icon={<MessageSquareText />} />
        ) : (
          history.map((item, index) => {
            const prevTs = index > 0 ? history[index - 1]?.ts : undefined;
            const bubble =
              item.role === 'user' ? (
                <ChatBubble
                  mine
                  name="我"
                  uin={selfUin}
                  text={item.text}
                  faces={userFaces}
                  conversationStyle
                  messageId={item.id}
                  selectionMode={selection.selectionMode}
                  selected={selection.selected(item.id)}
                  onSelect={item.id ? () => selection.selectMessage(item.id) : undefined}
                />
              ) : (
                <ChatBubble
                  mine={false}
                  bot
                  conversationStyle
                  messageId={item.id}
                  selectionMode={selection.selectionMode}
                  selected={selection.selected(item.id)}
                  onSelect={item.id ? () => selection.selectMessage(item.id) : undefined}
                  name={persona.name}
                  uin={clonedUin}
                  text={item.text}
                  faces={faces}
                  personaId={personaId}
                  onMediaLoad={scrollTranscriptToBottom}
                />
              );
            return (
              <div
                key={item.id ?? `${item.role}-${index}`}
                {...selection.itemProps(item.id)}
                data-generated-message-id={item.id}
                className={`weq-generated-message${item.id === searchMessageId ? ' is-search-hit' : ''}${selection.selected(item.id) ? ' is-selected' : ''}`}
              >
                {shouldShowChatTime(prevTs, item.ts) ? <ChatTimeDivider ts={item.ts} /> : null}
                {bubble}
              </div>
            );
          })
        )}
      </div>
      <CloneComposer
        selectionBar={selection.toolbar}
        inputRef={composerRef}
        value={input}
        onChange={setInput}
        onSend={() => void onSend()}
        disabled={legacy}
        busy={chat.isLoading || animating}
      />
    </CloneConversation>
  );
}
