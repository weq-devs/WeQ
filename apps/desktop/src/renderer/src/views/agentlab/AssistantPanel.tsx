/** 助手数据与运行控制适配；可见界面全部由 ChatPane 提供。 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Play, Square, X } from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import { ChatPane } from '../../im-template/template/chatPane';
import type { Message } from '../../im-template/template/types';
import type { MessageRenderer } from '../../im-template/template/messageRenderers';
import { cloneChatUser, cloneChatConversation, cloneChatInput } from './cloneChatAdapter';
import { useSharedAssistantDraft } from '../../hooks/useSharedAssistantDraft';
import { readAssistantDraft, rememberAssistantDraft } from '../../lib/assistantWorkspace';
import { assistantResultVersion } from '../../lib/workspaceReadState';
import type { AssistantActivity } from '../../lib/workspaceIndicators';
import type { GeneratedSearchHit } from '../../components/search/types';
import { ChatRecordsModal } from '../../components/search/ChatRecordsModal';
import { AiImageComposer } from '../../components/AiImageComposer';
import { aiImageDraft, parseAiImageDraft, changeAiImageDraftText, type AiImageAssetRef } from '../../lib/aiImageDraft';
import { AssistantReplyContent, type AssistantReplyActions } from './AssistantReplyContent';
import { useStableCallback } from '../../hooks/useStableCallback';
import { timeDate } from '@weq/time';
import { AssistantSettingsPanel, AssistantQuickTools } from './AssistantSettingsPanel';
import {
  applyAssistantStep,
  persistedAssistantTurn,
  type AssistantTurn,
} from './assistantTranscript';
import type { FlatModels } from './NewCloneModal';
export { AssistantSettingsPanel as AssistantSettings } from './AssistantSettingsPanel';

const PRESETS = [
  '我最近一周和谁聊得最火热？',
  '看看我最活跃的群最近都在聊什么',
  '帮我写一份我的聊天数据周报',
  '找找最近有谁跟我约过「吃饭」',
];

interface AssistantViewMessage extends Message {
  assistantTurn: AssistantTurn;
  assistantActions?: AssistantReplyActions;
}

const QueueTextEditor = memo(function QueueTextEditor({ id, label, value, onSave }: { id: string; label: string; value: string; onSave: (id: string, value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const previous = useRef(value);
  useEffect(() => { const prior = previous.current; setDraft((current) => current === prior ? value : current); previous.current = value; }, [value]);
  return <textarea aria-label={label} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== value) onSave(id, draft); }} />;
});

export function AssistantPanel({
  sessionId,
  searchTarget,
  onBack,
  onBackToDirectory,
  onSessionCreated,
  draftAccount,
  workspaceTitle,
  onActivityChange,
  headless = false,
}: {
  sessionId: string | null;
  searchTarget?: GeneratedSearchHit;
  chatModels: FlatModels['chat'];
  onBack: () => void;
  onBackToDirectory?: () => void;
  onSessionCreated: (id: string) => void;
  compact?: boolean;
  draftAccount?: string;
  workspaceTitle?: string;
  onActivityChange?: (activity: AssistantActivity, result?: string) => void;
  headless?: boolean;
}) {
  const utils = trpc.useUtils();
  const [currentId, setCurrentId] = useState(sessionId);
  const idRef = useRef(currentId);
  idRef.current = currentId;
  const [input, setInput] = useState(() =>
    draftAccount ? readAssistantDraft(draftAccount, sessionId) : '',
  );
  const [imageUploading, setImageUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopPending = useRef(false);
  const request = useRef<{ raw: string; id: string } | undefined>(undefined);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(false);
  const [search, setSearch] = useState(false);
  const [jump, setJump] = useState(
    searchTarget ? { messageId: searchTarget.messageId, revision: 0 } : undefined,
  );
  const account = trpc.account.getAccountConfig.useQuery();
  const profile = trpc.account.getSelfProfile.useQuery();
  const config = trpc.account.getAssistantConfig.useQuery();
  const binding = account.data
    ? {
        expectedAccountUin: String(account.data.uin),
        expectedAccountConfigId: account.data.configId,
      }
    : null;
  const bindingRef = useRef(binding);
  bindingRef.current = binding;
  const conversation = trpc.account.getAssistantConversation.useQuery(
    { ...binding, sessionId: currentId ?? '' },
    { enabled: Boolean(binding && currentId), staleTime: 0, refetchOnMount: 'always' },
  );
  const [turns, setTurns] = useState<AssistantTurn[]>(
    () => conversation.data?.map(persistedAssistantTurn) ?? [],
  );
  const queue = trpc.account.assistantQueue.useQuery(
    { ...binding!, sessionId: currentId ?? '' },
    {
      enabled: Boolean(binding && currentId),
      refetchInterval: (data) => (data?.running ? 2000 : false),
    },
  );
  const resume = trpc.account.getAssistantResumeState.useQuery(
    { ...binding, sessionId: currentId ?? '' },
    { enabled: Boolean(binding && currentId) },
  );
  const sharedDraft = useSharedAssistantDraft(
    `assistant:${currentId ?? 'new'}`,
    input,
    setInput,
    Boolean(draftAccount),
  );
  useEffect(() => {
    if (draftAccount) rememberAssistantDraft(draftAccount, currentId, input);
  }, [draftAccount, currentId, input]);
  useEffect(() => {
    if (!conversation.data) return;
    setTurns((current) => {
      const byId = new Map(current.map((turn) => [turn.id, turn]));
      return conversation.data.map((turn) =>
        turn.status === 'running' && byId.get(turn.id)?.running
          ? byId.get(turn.id)!
          : persistedAssistantTurn(turn),
      );
    });
  }, [conversation.data]);
  useEffect(() => {
    if (searchTarget) setJump({ messageId: searchTarget.messageId, revision: Date.now() });
  }, [searchTarget]);
  const running = Boolean(queue.data?.running || turns.some((turn) => turn.running));
  const activity: AssistantActivity = running
    ? 'running'
    : error || turns.some((turn) => turn.role === 'assistant')
      ? 'finished'
      : 'idle';
  const version = activity === 'finished' ? assistantResultVersion(turns) : undefined;
  useEffect(() => {
    onActivityChange?.(activity, version);
  }, [activity, version, onActivityChange]);
  useEffect(() => {
    if (!running && !sending) {
      setStopping(false);
      stopPending.current = false;
    }
  }, [running, sending]);
  useEffect(() => {
    let frame: number | undefined;
    let legacyRun = '';
    type Event = Parameters<
      NonNullable<
        NonNullable<Parameters<typeof client.account.onAssistantEvent.subscribe>[1]>['onData']
      >
    >[0];
    const pending: Event[] = [];
    const flush = () => {
      frame = undefined;
      const events = pending.splice(0);
      setTurns((current) => {
        const next = [...current];
        for (const event of events) {
          if (event.step.kind === 'queue') continue;
          if (event.step.kind === 'reset') {
            next.length = 0;
            continue;
          }
          if (event.step.kind === 'remove_turn') {
            const id = event.step.id;
            const index = next.findIndex((turn) => turn.id === id);
            if (index >= 0) next.splice(index, 1);
            continue;
          }
          if (event.step.kind === 'turn') {
            const turn = persistedAssistantTurn(event.step.turn);
            const index = next.findIndex((row) => row.id === turn.id);
            if (index < 0) next.push(turn);
            else next[index] = turn;
          } else {
            const index = event.messageId
              ? next.findIndex((row) => row.id === event.messageId)
              : next.length - 1;
            if (index >= 0 && next[index]?.role === 'assistant')
              next[index] = applyAssistantStep(next[index]!, event.step);
          }
        }
        return next;
      });
      if (
        events.some((event) =>
          ['queue', 'reset', 'final', 'aborted', 'error'].includes(event.step.kind),
        )
      ) {
        const id = idRef.current;
        if (id) {
          void utils.account.assistantQueue.invalidate();
          void utils.account.getAssistantResumeState.invalidate({ sessionId: id });
          if (
            events.some((event) => ['reset', 'final', 'aborted', 'error'].includes(event.step.kind))
          )
            void utils.account.getAssistantConversation.invalidate({ sessionId: id });
        }
        void utils.account.listAssistantSessions.invalidate();
      }
    };
    const subscription = client.account.onAssistantEvent.subscribe(undefined, {
      onData: (event) => {
        if (event.sessionId !== idRef.current) return;
        if (
          event.accountConfigId &&
          event.accountConfigId !== bindingRef.current?.expectedAccountConfigId
        )
          return;
        if (
          !event.messageId &&
          !['turn', 'queue', 'reset', 'remove_turn'].includes(event.step.kind)
        ) {
          if (legacyRun !== event.runId) {
            legacyRun = event.runId;
            void utils.account.assistantQueue.invalidate();
          }
          if (['final', 'aborted', 'error'].includes(event.step.kind)) {
            legacyRun = '';
            void utils.account.getAssistantConversation.invalidate({ sessionId: event.sessionId });
            void utils.account.getAssistantResumeState.invalidate({ sessionId: event.sessionId });
            void utils.account.assistantQueue.invalidate();
          }
          return;
        }
        pending.push(event);
        if (frame === undefined) frame = requestAnimationFrame(flush);
      },
      onError: (reason) => setError(reason.message),
    });
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      subscription.unsubscribe();
    };
  }, [utils]);
  async function control(action: 'stop' | 'continue' | 'next') {
    if (!bindingRef.current || !idRef.current) return;
    try {
      setError('');
      await client.account.controlAssistantQueue.mutate({
        ...bindingRef.current,
        sessionId: idRef.current,
        action,
      });
      await utils.account.assistantQueue.invalidate();
    } catch (reason) {
      setStopping(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  const editQueuedMessage = useStableCallback(async (requestId: string, patch: { text?: string; beforeId?: string; cancel?: boolean }) => {
    const owner = bindingRef.current; const sessionId = idRef.current;
    if (!owner || !sessionId) return;
    try { setError(''); await client.account.editAssistantQueue.mutate({ ...owner, sessionId, requestId, ...patch }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { void utils.account.assistantQueue.invalidate(); }
  });
  const saveQueuedText = useStableCallback((id: string, value: string) => { void editQueuedMessage(id, { text: value }); });
  async function send(body: string, preset = false) {
    if (!binding || sending || imageUploading) return;
    const text = cloneChatInput(body, new Map());
    const images = preset ? [] : parseAiImageDraft(input).images;
    if (!text.trim() && !images.length) return;
    const submitted = aiImageDraft(text, images);
    if (!request.current || request.current.raw !== submitted)
      request.current = { raw: submitted, id: crypto.randomUUID() };
    const clearDraft = preset ? undefined : sharedDraft.prepareSubmitted(input);
    setSending(true);
    setError('');
    try {
      let id = idRef.current;
      if (!id) {
        const created = await client.account.createAssistantSession.mutate(binding);
        id = created.id;
        idRef.current = id;
        setCurrentId(id);
        onSessionCreated(id);
        if (stopPending.current) return;
      }
      await client.account.submitAssistantMessage.mutate({
        ...binding,
        sessionId: id,
        requestId: request.current.id,
        text,
        images,
      });
      request.current = undefined;
      if (!preset) setInput((value) => (value === input ? '' : value));
      if (clearDraft) void clearDraft().catch(() => {});
      if (stopPending.current) await control('stop');
      void utils.account.assistantQueue.invalidate();
      void utils.account.getAssistantConversation.invalidate({ sessionId: id });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setSending(false);
    }
  }
  const user = useMemo(() => cloneChatUser('self', '我', profile.data?.uin), [profile.data?.uin]);
  const peer = useMemo(
    () => ({ ...cloneChatUser('assistant', 'WeQ 助手'), kind: 'bot' as const }),
    [],
  );
  const viewId = `assistant:${currentId ?? 'new'}`;
  const chat = useMemo(
    () =>
      cloneChatConversation({
        target: { kind: 'assistant', ownerId: 'assistant', sessionId: currentId },
        viewId,
        name: workspaceTitle ?? '新会话',
        peer: { ...peer, displayName: workspaceTitle ?? '新会话' },
      }),
    [currentId, viewId, workspaceTitle, peer],
  );
  const project = useMemo(() => {
    const projection = new WeakMap<AssistantTurn, AssistantViewMessage>();
    return (turn: AssistantTurn, index: number) => {
      const cached = projection.get(turn);
      if (cached) return cached;
      const sender = turn.role === 'user' ? user : peer;
      const message = {
        id: turn.id ?? `pending:${index}`,
        generatedPending: !turn.id || turn.status === 'running',
        conversationId: viewId,
        senderId: sender.id,
        sender,
        body:
          (turn.running ? turn.streamingText || turn.text : turn.text) ||
          (turn.images?.length ? '[图片]' : ''),
        createdAt: timeDate(turn.ts)?.toISOString() ?? new Date(0).toISOString(),
        assistantTurn: turn,
      };
      projection.set(turn, message);
      return message;
    };
  }, [viewId, user, peer]);
  const baseMessages = useMemo(() => turns.map(project), [turns, project]);
  const continueCurrent = useStableCallback(() => {
    void control('continue');
  });
  const runNext = useStableCallback(() => {
    void control('next');
  });
  const restoreQuestion = useStableCallback(() => {
    const question = turns.findLast((turn) => turn.role === 'user');
    if (question) {
      const images = question.images ?? [];
      const assets = images.filter((image): image is AiImageAssetRef => typeof image.path === 'string');
      setInput(aiImageDraft(question.text, assets));
      if (assets.length !== images.length) setError('原消息中的聊天图片引用仍保留在历史中，本次编辑仅带入已保存附件。');
    }
  });
  const lastAssistant = turns.findLast((turn) => turn.role === 'assistant');
  const recoveryId =
    !running &&
    (lastAssistant?.status === 'failed' ||
      lastAssistant?.status === 'stopped' ||
      lastAssistant?.error)
      ? lastAssistant?.id
      : undefined;
  const resumable = !running && resume.data?.resumable === true;
  const queuePaused = Boolean(
    queue.data?.paused && queue.data.items.some((item) => item.status !== 'running'),
  );
  const messages = useMemo(
    () =>
      recoveryId
        ? baseMessages.map((message) =>
            message.id === recoveryId
              ? {
                  ...message,
                  assistantActions: {
                    onContinue: resumable ? continueCurrent : undefined,
                    onRestore: resumable ? undefined : restoreQuestion,
                    onNext: queuePaused ? runNext : undefined,
                  },
                }
              : message,
          )
        : baseMessages,
    [baseMessages, recoveryId, resumable, queuePaused, continueCurrent, restoreQuestion, runNext],
  );
  const renderers = useMemo<MessageRenderer[]>(
    () => [
      {
        id: 'assistant-content',
        match: () => true,
        render: ({ message }) => (
          <AssistantReplyContent
            turn={(message as AssistantViewMessage).assistantTurn}
            actions={(message as AssistantViewMessage).assistantActions}
          />
        ),
      },
    ],
    [],
  );
  if (headless) return null;
  const stopAction = {
    id: 'assistant-stop',
    label: stopping ? '停止中' : '停止当前任务',
    icon: Square,
    disabled: () => stopping,
    onClick: () => {
      stopPending.current = true;
      setStopping(true);
      void control('stop');
    },
  };
  const stopActions = running || sending ? [stopAction] : [];
  const waiting = queue.data?.items.filter((item) => item.status !== 'running') ?? [];
  return (
    <>
      <AiImageComposer
        fill
        value={input}
        setValue={setInput}
        onBusyChange={setImageUploading}
        onSendImages={() => void send(parseAiImageDraft(input).text)}
      >
        {(attachments) => (
          <ChatPane
            user={user}
            conversation={chat}
            messages={messages}
            messageRenderers={renderers}
            composerActions={{
              desktopToolbar: stopActions,
              mobileToolbar: stopActions,
              mobileExpandedToolbar: stopActions,
            }}
            loading={conversation.isFetching && !turns.length}
            loadError={conversation.error?.message}
            preference={undefined}
            draft={parseAiImageDraft(input).text}
            onDraftChange={(_id, text) => setInput((value) => changeAiImageDraftText(value, text))}
            onDraftClear={() => {}}
            onSend={(body) => send(body)}
            sendAvailable={Boolean(
              binding && config.data && !sending && !stopping && !imageUploading,
            )}
            sendBlockedReason={
              stopping
                ? '任务正在停止'
                : sending
                  ? '正在提交消息'
                  : imageUploading
                    ? '图片准备中'
                    : !binding
                      ? '账号未就绪'
                      : !config.data
                        ? '参数读取中'
                        : undefined
            }
            onBack={onBackToDirectory ?? onBack}
            hasExternalAttachments={parseAiImageDraft(input).images.length > 0}
            composerAttachments={attachments}
            onOpenConversationSettings={() => setSettings(true)}
            settingsLabel="助手设置"
            onSearchChatRecords={() => setSearch(true)}
            jumpRequest={jump}
            timelineNotice={
              turns.length === 0 ? (
                <div className="weq-conversation-notice">
                  {PRESETS.map((text) => (
                    <button
                      key={text}
                      type="button"
                      className="weq-set-btn weq-set-btn-soft"
                      onClick={() => void send(text, true).catch(() => {})}
                    >
                      {text}
                    </button>
                  ))}
                </div>
              ) : null
            }
            composerTools={
              <>
                <AssistantQuickTools />
                {resume.data?.resumable && !running && !recoveryId ? (
                  <button
                    type="button"
                    className="weq-set-btn"
                    onClick={() => void control('continue')}
                  >
                    <Play size={14} />
                    继续当前任务并恢复队列
                  </button>
                ) : null}
                {queue.data?.paused && waiting.length && !running && !recoveryId ? (
                  <button
                    type="button"
                    className="weq-set-btn"
                    onClick={() => void control('next')}
                  >
                    <Play size={14} />
                    跳过当前任务并执行下一条
                  </button>
                ) : null}
                {error || (!recoveryId && queue.data?.error) ? (
                  <p role="alert">{error || queue.data?.error}</p>
                ) : null}
                {waiting.length ? (
                  <div className="weq-assistant-queue" aria-label="待处理消息">
                    {waiting.map((item, index) => (
                      <div key={item.requestId}>
                        <QueueTextEditor id={item.requestId} label={`待处理消息 ${index + 1}`} value={item.text} onSave={saveQueuedText} />
                        {index ? (
                          <button
                            type="button"
                            className="icon-button"
                            title="上移消息"
                            aria-label="上移消息"
                            onClick={() => void editQueuedMessage(item.requestId, { beforeId: waiting[index - 1]!.requestId })}
                          >
                            <ArrowUp size={14} />
                          </button>
                        ) : null}
                        {index < waiting.length - 1 ? (
                          <button
                            type="button"
                            className="icon-button"
                            title="下移消息"
                            aria-label="下移消息"
                            onClick={() => void editQueuedMessage(waiting[index + 1]!.requestId, { beforeId: item.requestId })}
                          >
                            <ArrowDown size={14} />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="icon-button"
                          title="取消消息"
                          aria-label="取消消息"
                          onClick={() => void editQueuedMessage(item.requestId, { cancel: true })}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            }
          />
        )}
      </AiImageComposer>
      {settings ? <AssistantSettingsPanel onClose={() => setSettings(false)} /> : null}
      {search ? (
        <ChatRecordsModal
          fixed
          initialKeyword=""
          initialHit={{
            category: 'chatRecord',
            source: 'buddy',
            partition: viewId,
            targetUid: viewId,
            targetUin: '',
            name: workspaceTitle ?? 'WeQ 助手',
            count: messages.length,
          }}
          renderers={renderers}
          localSource={{
            conversation: chat,
            messages,
            user,
            onJump: (messageId) => setJump({ messageId, revision: Date.now() }),
          }}
          onClose={() => setSearch(false)}
          onJumpMessage={() => {}}
        />
      ) : null}
    </>
  );
}
