import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import { ArrowLeft, MessageSquarePlus, MessagesSquare, Plus, Send, Settings, Sparkles, Trash2, X } from 'lucide-react';
import { trpc } from '../trpc/client';
import { useAppDialog } from '../lib/dialogUtils';
import { autoGrowTextarea } from '../lib/textareaAutoGrow';
import { QqAvatar } from '../components/QqAvatar';
import { NewCloneModal, type BuddyOption, type FlatModels, type StartCloneArgs } from './agentlab/NewCloneModal';
import { CloneProgressModal } from './agentlab/CloneProgressModal';
import {
  startCloneTask,
  dismissCloneTask,
  subscribeCloneTasks,
  getCloneTasks,
} from './agentlab/cloneTaskStore';
import { PersonaSettingsModal } from './agentlab/PersonaSettingsModal';
import { UsagePanel } from './agentlab/UsagePanel';
import { AssistantPanel } from './agentlab/AssistantPanel';
import { ChatBubble, buildFaceMap, type FaceContext } from './agentlab/ChatBubble';

interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface PersonaParamsDetail {
  persona: {
    name: string;
    stats: {
      sourceMessageCount: number;
      friendMessageCount: number;
      avgFriendMsgChars: number;
      avgFriendBurst: number;
      turnCount: number;
      pairCount: number;
      corpusChars: number;
      groupStyleMessageCount: number;
    };
    profile: {
      extractedByLlm: boolean;
      extractError?: string;
      styleSummary: string;
      voiceRatio: number;
      voiceUsageSummary: string;
      relationshipSummary: string;
      topTerms: string[];
      card: {
        tone: string;
        personalityTraits: string[];
        catchphrases: string[];
        punctuationStyle: string;
        addressing: string;
        topics: string[];
      };
      deep: {
        facts: string[];
        relationship: string;
        reactionPatterns: string[];
        boundaries: string[];
      };
    };
    fewShots: Array<{ prompt: string; reply: string }>;
    systemFaces?: string[];
    stickers?: Array<{ count: number; description: string; scenario: string }>;
    voiceProfile?: { ratio: number; scenarioSummary: string };
  };
  pairs: Array<{ prompt: string; reply: string }>;
}

function Chips({ items }: { items: string[] }): ReactElement {
  if (!items.length) return <span className="weq-pp-dim">—</span>;
  return (
    <span className="weq-pp-chips">
      {items.map((item, index) => (
        <span key={`${item}-${index}`} className="weq-pp-chip">
          {item}
        </span>
      ))}
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="weq-pp-row">
      <span className="weq-pp-label">{label}</span>
      <div className="weq-pp-val">{children}</div>
    </div>
  );
}

function PersonaParamsPanel({ loading, detail }: { loading: boolean; detail: PersonaParamsDetail | null }): ReactElement {
  if (loading) return <div className="weq-agentlab-params">加载画像参数中…</div>;
  if (!detail) return <div className="weq-agentlab-params">暂无画像参数。</div>;
  const { stats, profile, fewShots } = detail.persona;
  const card = profile.card;
  const deep = profile.deep;
  const systemFaces = detail.persona.systemFaces ?? [];
  const stickers = detail.persona.stickers ?? [];
  const voiceProfile = detail.persona.voiceProfile;
  return (
    <div className="weq-agentlab-params">
      <div className="weq-pp-head">
        <strong className="weq-pp-title">画像参数</strong>
        <span className={`weq-pp-badge${profile.extractedByLlm ? ' is-llm' : ' is-fallback'}`}>
          {profile.extractedByLlm ? 'LLM 提炼' : '启发式兜底（未调用 LLM 或失败）'}
        </span>
      </div>

      {profile.extractError ? (
        <div className="weq-pp-error">提炼失败：{profile.extractError}</div>
      ) : null}

      <Row label="统计">
        <span className="weq-pp-stats">
          源消息 {stats.sourceMessageCount} · 对方 {stats.friendMessageCount} · 轮次 {stats.turnCount} · 问答对{' '}
          {stats.pairCount} · 均字 {stats.avgFriendMsgChars} · 连发 {stats.avgFriendBurst} · 语料{' '}
          {stats.corpusChars} 字
          {stats.groupStyleMessageCount > 0 ? ` · 群补采 ${stats.groupStyleMessageCount} 条` : ''}
        </span>
      </Row>
      <Row label="语气">{card.tone || profile.styleSummary || '—'}</Row>
      <Row label="标点习惯">{card.punctuationStyle || '—'}</Row>
      <Row label="称呼">{card.addressing || '—'}</Row>
      <Row label="性格"><Chips items={card.personalityTraits} /></Row>
      <Row label="口头禅"><Chips items={card.catchphrases} /></Row>
      <Row label="话题"><Chips items={card.topics.length ? card.topics : profile.topTerms} /></Row>
      <Row label="语音">
        {voiceProfile?.scenarioSummary || profile.voiceUsageSummary}（占比{' '}
        {Math.round((voiceProfile?.ratio ?? profile.voiceRatio) * 100)}%）
      </Row>
      <Row label="系统表情"><Chips items={systemFaces} /></Row>
      <Row label="表情包">
        {stickers.length === 0 ? (
          <span className="weq-pp-dim">—</span>
        ) : (
          <div className="weq-pp-stickers">
            {stickers.map((s, index) => (
              <span key={`sticker-${index}`} className="weq-pp-sticker">
                ×{s.count} {s.description || '（未解读）'}
                {s.scenario ? `（${s.scenario}）` : ''}
              </span>
            ))}
          </div>
        )}
      </Row>
      <Row label="关系">{deep.relationship || profile.relationshipSummary || '—'}</Row>
      <Row label="事实"><Chips items={deep.facts} /></Row>
      <Row label="反应模式"><Chips items={deep.reactionPatterns} /></Row>
      <Row label="立场雷点"><Chips items={deep.boundaries} /></Row>

      <details className="weq-pp-samples">
        <summary>
          代表样本 {fewShots.length} 组 / 真实问答对抽样 {detail.pairs.length} 条
        </summary>
        <div className="weq-pp-samples-body">
          {fewShots.map((pair, index) => (
            <div key={`fs-${index}`} className="weq-pp-sample">
              <div className="weq-pp-sample-q">我：{pair.prompt}</div>
              <div>{detail.persona.name}：{pair.reply}</div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

type Selection =
  | { kind: 'home' }
  | { kind: 'assistant'; sessionId: string | null }
  | { kind: 'persona'; id: string };

/** 会话列表里的相对时间（粗粒度，够用即可）。 */
function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ts).toLocaleDateString();
}

export function AgentLabView(): ReactElement {
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const providers = trpc.bootstrap.listAgentLabProviders.useQuery();
  const buddies = trpc.account.listBuddies.useQuery({ limit: 300, offset: 0 });
  const personas = trpc.account.listAgentLabPersonas.useQuery();
  const chat = trpc.account.chatWithAgentLabPersona.useMutation();
  const deletePersona = trpc.account.deleteAgentLabPersona.useMutation();
  const createAssistantSession = trpc.account.createAssistantSession.useMutation();
  const deleteAssistantSession = trpc.account.deleteAssistantSession.useMutation();
  const selfProfile = trpc.account.getSelfProfile.useQuery();
  const systemFaces = trpc.account.getSystemFaces.useQuery(undefined, { staleTime: Infinity });
  const faceDescToId = useMemo(() => buildFaceMap(systemFaces.data ?? []), [systemFaces.data]);

  const buddyUids = useMemo(
    () => (buddies.data ?? []).map((item) => item.uid).filter(Boolean),
    [buddies.data],
  );
  const profiles = trpc.account.getProfilesByUids.useQuery(
    { uids: buddyUids.slice(0, 300) },
    { enabled: buddyUids.length > 0 },
  );
  const profileByUid = useMemo(() => {
    const map = new Map<string, { uin: string; label: string; avatarUrl?: string }>();
    for (const row of profiles.data ?? []) {
      map.set(row.uid, {
        uin: row.uin,
        label: row.remark || row.nick || row.uin || row.uid,
        avatarUrl: row.avatarUrl || undefined,
      });
    }
    return map;
  }, [profiles.data]);

  // 后端旧版/损坏数据可能混入 undefined，统一在这里过滤一次，下面所有用法都走 personaList。
  const personaList = useMemo(
    () => (personas.data ?? []).filter((p): p is NonNullable<typeof p> => Boolean(p)),
    [personas.data],
  );

  const buddyOptions: BuddyOption[] = useMemo(
    () =>
      (buddies.data ?? []).map((item) => {
        const p = profileByUid.get(item.uid);
        return { uid: item.uid, uin: p?.uin || item.uin || '', label: p?.label || item.uin || item.uid, avatarUrl: p?.avatarUrl };
      }),
    [buddies.data, profileByUid],
  );

  const flatModels: FlatModels = useMemo(() => {
    const build = (cap: 'chat' | 'embedding' | 'vision') =>
      (providers.data ?? []).flatMap((p) =>
        p.models
          .filter((m) => m.capabilities.includes(cap))
          .map((m) => ({ key: `${p.id}::${m.id}`, providerId: p.id, model: m.id, label: `${p.name} · ${m.label ?? m.id}` })),
      );
    return { chat: build('chat'), embedding: build('embedding'), vision: build('vision') };
  }, [providers.data]);

  const [sel, setSel] = useState<Selection>({ kind: 'home' });
  // WeQ 助手会话列表：仅进入助手模式时拉取。
  const assistantSessionsQuery = trpc.account.listAssistantSessions.useQuery(undefined, {
    enabled: sel.kind === 'assistant',
  });
  const assistantSessions = assistantSessionsQuery.data ?? [];
  const [cloneOpen, setCloneOpen] = useState(false);
  // 克隆任务列表：抬到模块级 store（脱离本组件生命周期），切出 AgentLab 再回来任务不丢（bug2）。
  const cloneTasks = useSyncExternalStore(subscribeCloneTasks, getCloneTasks);
  const [viewTaskId, setViewTaskId] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const personaId = sel.kind === 'persona' ? sel.id : '';
  const activePersona = personaList.find((item) => item.id === personaId) ?? null;
  const clonedProfile = activePersona ? profileByUid.get(activePersona.sourceId) : undefined;
  // 克隆体气泡的系统表情渲染上下文：用 TA 的 faceText 白名单 + 全局 faceText→id 映射。
  const cloneFaces: FaceContext | undefined = useMemo(
    () =>
      activePersona?.systemFaces?.length
        ? { whitelist: activePersona.systemFaces, descToId: faceDescToId }
        : undefined,
    [activePersona?.systemFaces, faceDescToId],
  );
  const personaDetail = trpc.account.getAgentLabPersonaDetail.useQuery(
    { personaId },
    { enabled: settingsOpen && !!personaId },
  );
  const personaConv = trpc.account.getAgentLabConversation.useQuery(
    { personaId },
    { enabled: !!personaId },
  );
  const seededPersona = useRef('');

  function scrollTranscriptToBottom(): void {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    });
  }

  // 切换克隆体（personaId 变化）时重置 seed 并清空历史，等新会话数据到位再恢复。
  // 注意：只依赖 personaId——发消息后的 invalidate 不会改变 personaId，于是不会清掉刚揭示的本地历史。
  useEffect(() => {
    seededPersona.current = '';
    setHistory([]);
  }, [personaId]);

  // 持久化对话就绪、且当前克隆体尚未 seed 过时，从持久化对话恢复历史（每个 persona 只 seed 一次）。
  useEffect(() => {
    if (!personaId || seededPersona.current === personaId || !personaConv.data) return;
    setHistory(personaConv.data.map((t) => ({ role: t.role, text: t.text })));
    seededPersona.current = personaId;
  }, [personaId, personaConv.data]);

  // 发送、收到分段回复、等待态变化时始终跟随到会话底部。
  useEffect(() => {
    scrollTranscriptToBottom();
  }, [history, chat.isLoading, personaId]);

  // 选中的 persona 被删除时回退到主页。
  useEffect(() => {
    if (sel.kind === 'persona' && personas.data && !personaList.some((p) => p.id === sel.id)) {
      setSel({ kind: 'home' });
    }
  }, [sel, personas.data, personaList]);

  // 进度订阅由 cloneTaskStore 在模块级维护（脱离本组件，切视图不中断）。
  // 这里只负责：有任务构建完成时刷新克隆体列表（同时覆盖「构建期切走、回来才看到完成」的情况）。
  const doneTaskIds = cloneTasks
    .filter((t) => t.status === 'done')
    .map((t) => t.personaId)
    .join(',');
  useEffect(() => {
    if (doneTaskIds) void utils.account.listAgentLabPersonas.invalidate();
  }, [doneTaskIds, utils]);

  function selectPersona(id: string): void {
    // 已是当前克隆体则忽略：重复点击不应清空已揭示的历史（bug1）。
    if (sel.kind === 'persona' && sel.id === id) return;
    setSel({ kind: 'persona', id });
    setSettingsOpen(false);
    // 切入时拉一次最新持久化历史，避免命中陈旧缓存（实时查询历史）。
    void utils.account.getAgentLabConversation.invalidate({ personaId: id });
  }

  async function onNewAssistantSession(): Promise<void> {
    try {
      const session = await createAssistantSession.mutateAsync();
      await utils.account.listAssistantSessions.invalidate();
      setSel({ kind: 'assistant', sessionId: session.id });
    } catch (error) {
      dialog.error('新建失败', error instanceof Error ? error.message : String(error));
    }
  }

  async function onDeleteAssistantSession(sessionId: string): Promise<void> {
    const ok = await dialog.confirm('删除对话', '确认删除这段对话？删除后无法恢复。', {
      okLabel: '删除',
      tone: 'warning',
    });
    if (!ok) return;
    try {
      await deleteAssistantSession.mutateAsync({ sessionId });
      await utils.account.listAssistantSessions.invalidate();
      // 删的是当前打开的会话 → 回到「选择/新建」空态。
      setSel((cur) => (cur.kind === 'assistant' && cur.sessionId === sessionId ? { kind: 'assistant', sessionId: null } : cur));
    } catch (error) {
      dialog.error('删除失败', error instanceof Error ? error.message : String(error));
    }
  }

  // 由配置弹窗发起构建：交给模块级 store 登记任务 + 后台跑构建 → 关弹窗 → 打开进度灯箱。
  // 构建脱离本组件，切走再回来任务态仍在（bug2）。完成后由上面的 doneTaskIds effect 刷新列表。
  function startClone(args: StartCloneArgs): void {
    setCloneOpen(false);
    setViewTaskId(args.params.personaId);
    void startCloneTask(args);
  }

  function openPersonaFromTask(personaId: string): void {
    dismissCloneTask(personaId);
    setViewTaskId(null);
    selectPersona(personaId);
  }

  function dismissTask(personaId: string): void {
    dismissCloneTask(personaId);
    setViewTaskId((cur) => (cur === personaId ? null : cur));
  }

  const viewingTask = cloneTasks.find((t) => t.personaId === viewTaskId) ?? null;

  async function onSend(): Promise<void> {
    if (!personaId || !input.trim()) return;
    const text = input.trim();
    setInput('');
    if (composerRef.current) composerRef.current.style.height = 'auto';
    const nextHistory = [...history, { role: 'user' as const, text }];
    setHistory(nextHistory);
    try {
      const result = await chat.mutateAsync({ personaId, text, history });
      // 分段连发 + 打字延迟：逐条揭示，模拟真人一句一句发。
      // renderedTurns = 后端按 actions 顺序落库的标记文本（文字 / [[sticker:md5]] / [[voice:id]]），
      // 表情图、语音气泡都在其中，前端按序揭示即可；缺省时回退旧字段（兼容）。
      const segments =
        result.renderedTurns && result.renderedTurns.length > 0
          ? [...result.renderedTurns]
          : [...(result.segments ?? []), ...(result.sticker ? [`[[sticker:${result.sticker.md5}]]`] : [])];
      if (segments.length === 0) segments.push(result.text);
      await sleep(Math.min(1800, result.replyDelayMs ?? 500));
      let acc = nextHistory;
      for (let i = 0; i < segments.length; i += 1) {
        const seg = segments[i]!;
        acc = [...acc, { role: 'assistant' as const, text: seg }];
        setHistory(acc);
        if (i < segments.length - 1) {
          await sleep(Math.min(1600, 320 + seg.length * 55));
        }
      }
      // 让持久化对话缓存跟上（后端已逐条落库）；否则切走再切回会从陈旧缓存 reseed 丢消息。
      seededPersona.current = personaId; // 防止下面的失效触发 reseed 清掉刚揭示的本地历史
      void utils.account.getAgentLabConversation.invalidate({ personaId });
    } catch (error) {
      dialog.error('发送失败', error instanceof Error ? error.message : String(error));
      setHistory(history);
      setInput(text);
    }
  }

  async function onDeletePersona(): Promise<void> {
    if (!personaId) return;
    const ok = await dialog.confirm('删除克隆', '确认删除当前克隆体？', {
      okLabel: '删除',
      cancelLabel: '返回',
      tone: 'warning',
    });
    if (!ok) return;
    try {
      await deletePersona.mutateAsync({ personaId });
      setSel({ kind: 'home' });
      setHistory([]);
      await utils.account.listAgentLabPersonas.invalidate();
      dialog.success('已删除');
    } catch (error) {
      dialog.error('删除失败', error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="weq-agentlab-shell">
      {/* 左侧 agent 列表 */}
      <aside className="weq-agentlab-list">
        {sel.kind === 'assistant' ? (
          <>
            <button className="weq-agentlab-list-back" onClick={() => setSel({ kind: 'home' })}>
              <ArrowLeft size={14} /> 返回 AgentLab
            </button>
            <div className="weq-agentlab-list-head weq-asst-list-head">
              <Sparkles size={15} /> WeQ 助手 · 对话
            </div>
            <button className="weq-agentlab-newclone" onClick={() => void onNewAssistantSession()}>
              <MessageSquarePlus size={15} /> 新建对话
            </button>
            <div className="weq-agentlab-list-scroll">
              {assistantSessions.length === 0 ? (
                <div className="weq-agentlab-empty" style={{ padding: '8px 10px' }}>
                  还没有对话，点上方「新建对话」开始。
                </div>
              ) : (
                assistantSessions.map((s) => (
                  <button
                    key={s.id}
                    className={`weq-agentlab-item${sel.sessionId === s.id ? ' is-active' : ''}`}
                    onClick={() => setSel({ kind: 'assistant', sessionId: s.id })}
                  >
                    <span className="weq-agentlab-item-avatar is-bot"><MessagesSquare size={16} /></span>
                    <span className="weq-agentlab-item-text">
                      <strong>{s.title}</strong>
                      <small>{relTime(s.updatedAt)}</small>
                    </span>
                    <span
                      className="weq-clone-task-close"
                      role="button"
                      tabIndex={0}
                      aria-label="删除对话"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDeleteAssistantSession(s.id);
                      }}
                    >
                      <Trash2 size={13} />
                    </span>
                  </button>
                ))
              )}
            </div>
          </>
        ) : (
          <>
        <div className="weq-agentlab-list-head">AgentLab</div>
        <button
          className="weq-agentlab-item"
          onClick={() => setSel({ kind: 'assistant', sessionId: null })}
        >
          <span className="weq-agentlab-item-avatar is-bot"><Sparkles size={18} /></span>
          <span className="weq-agentlab-item-text">
            <strong>WeQ 助手</strong>
            <small>调用工具帮你完成操作</small>
          </span>
        </button>

        <div className="weq-agentlab-list-label">好友克隆</div>
        <div className="weq-agentlab-list-scroll">
          {personaList.length === 0 ? (
            <div className="weq-agentlab-empty" style={{ padding: '8px 10px' }}>还没有克隆体。</div>
          ) : (
            personaList.map((p) => {
              const prof = profileByUid.get(p.sourceId);
              return (
                <button
                  key={p.id}
                  className={`weq-agentlab-item${sel.kind === 'persona' && sel.id === p.id ? ' is-active' : ''}`}
                  onClick={() => selectPersona(p.id)}
                >
                  <QqAvatar uin={prof?.uin} size={34} />
                  <span className="weq-agentlab-item-text">
                    <strong>{p.name}</strong>
                    <small>{p.sourceTitle}</small>
                  </span>
                </button>
              );
            })
          )}
        </div>

        {cloneTasks.length > 0 ? (
          <div className="weq-clone-tasklist">
            {cloneTasks.map((t) => (
              <button
                key={t.personaId}
                type="button"
                className={`weq-clone-task is-${t.status}`}
                onClick={() => setViewTaskId(t.personaId)}
                title="查看克隆进度"
              >
                <QqAvatar uin={t.uin} size={28} />
                <span className="weq-clone-task-text">
                  <strong>{t.name}</strong>
                  <small>
                    {t.status === 'running'
                      ? `${t.phase} · ${Math.round(t.percent)}%`
                      : t.status === 'done'
                        ? '克隆完成 · 点击查看'
                        : '克隆失败 · 点击查看'}
                  </small>
                  {t.status === 'running' ? (
                    <span className="weq-clone-task-bar">
                      <i style={{ width: `${Math.round(t.percent)}%` }} />
                    </span>
                  ) : null}
                </span>
                {t.status !== 'running' ? (
                  <span
                    className="weq-clone-task-close"
                    role="button"
                    tabIndex={0}
                    aria-label="移除任务"
                    onClick={(e) => {
                      e.stopPropagation();
                      dismissTask(t.personaId);
                    }}
                  >
                    <X size={13} />
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}

        <button className="weq-agentlab-newclone" onClick={() => setCloneOpen(true)}>
          <Plus size={15} /> 新建克隆
        </button>
          </>
        )}
      </aside>

      {/* 右侧主区 */}
      <section className="weq-agentlab-main">
        {sel.kind === 'home' ? (
          <UsagePanel
            resolveName={(id) => personaList.find((p) => p.id === id)?.name ?? '已删除的克隆'}
            hasPersona={(id) => id === '__assistant__' || personaList.some((p) => p.id === id)}
            personaCount={personaList.length}
          />
        ) : sel.kind === 'assistant' ? (
          sel.sessionId ? (
            <AssistantPanel
              key={sel.sessionId}
              sessionId={sel.sessionId}
              chatModels={flatModels.chat}
              onBack={() => setSel({ kind: 'assistant', sessionId: null })}
            />
          ) : (
            <div className="weq-agentlab-chat">
              <div className="weq-agentlab-empty">
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}>
                  <Sparkles size={30} strokeWidth={1.5} />
                  <span>
                    从左侧选择一段对话继续，或<strong>新建一段对话</strong>，开始和 WeQ 助手聊天。
                  </span>
                  <button className="weq-set-btn" onClick={() => void onNewAssistantSession()}>
                    <MessageSquarePlus size={14} /> 新建对话
                  </button>
                </div>
              </div>
            </div>
          )
        ) : (
          <div className="weq-agentlab-chat">
            <header className="weq-agentlab-head">
              <div className="weq-agentlab-head-left">
                <button
                  type="button"
                  className="weq-set-iconbtn"
                  onClick={() => setSel({ kind: 'home' })}
                  aria-label="返回主页"
                  title="返回"
                >
                  <ArrowLeft size={16} />
                </button>
                <div>
                  <strong>{activePersona?.name ?? '克隆体'}</strong>
                  <span>
                    {activePersona
                      ? `${activePersona.models?.chat?.model ?? '旧版克隆，请重建'} · 样本 ${activePersona.corpusMessageCount} 条`
                      : '加载中…'}
                  </span>
                </div>
              </div>
              <div className="weq-agentlab-head-actions">
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
                  disabled={!activePersona}
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings size={12} />
                  设置
                </button>
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
                  disabled={!activePersona}
                  onClick={() => void onDeletePersona()}
                >
                  <Trash2 size={12} />
                  删除
                </button>
              </div>
            </header>

            <div className="weq-agentlab-transcript" ref={transcriptRef}>
              {history.length === 0 ? (
                <div className="weq-agentlab-empty">这里会显示你和克隆体的测试对话。</div>
              ) : (
                history.map((item, index) =>
                  item.role === 'user' ? (
                    <ChatBubble
                      key={`u-${index}`}
                      mine
                      name="我"
                      uin={selfProfile.data?.uin}
                      text={item.text}
                    />
                  ) : (
                    <ChatBubble
                      key={`a-${index}`}
                      mine={false}
                      bot
                      name={activePersona?.name ?? '克隆体'}
                      uin={clonedProfile?.uin}
                      text={item.text}
                      faces={cloneFaces}
                      personaId={personaId}
                      onMediaLoad={scrollTranscriptToBottom}
                    />
                  ),
                )
              )}
            </div>
            <div className="weq-agentlab-composer">
              <textarea
                ref={composerRef}
                rows={1}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  autoGrowTextarea(e.currentTarget);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void onSend();
                  }
                }}
                placeholder="输入一句话测试克隆效果（Enter 发送，Shift+Enter 换行）"
                disabled={!activePersona || chat.isLoading}
              />
              <button
                type="button"
                className="weq-set-btn"
                onClick={() => void onSend()}
                disabled={!activePersona || chat.isLoading || !input.trim()}
              >
                <Send size={14} />
                发送
              </button>
            </div>
          </div>
        )}
      </section>

      {cloneOpen ? (
        <NewCloneModal
          buddies={buddyOptions}
          flatModels={flatModels}
          onClose={() => setCloneOpen(false)}
          onStart={(args) => void startClone(args)}
        />
      ) : null}

      {viewingTask ? (
        <CloneProgressModal
          task={viewingTask}
          onHide={() => setViewTaskId(null)}
          onOpenPersona={openPersonaFromTask}
          onDismiss={dismissTask}
        />
      ) : null}

      {settingsOpen && activePersona ? (
        <PersonaSettingsModal
          persona={{
            id: activePersona.id,
            name: activePersona.name,
            customPrompt: activePersona.customPrompt,
            voiceCloneEnabled: activePersona.voiceCloneEnabled,
            voice: activePersona.voice,
            voiceProfile: activePersona.voiceProfile,
          }}
          paramsContent={<PersonaParamsPanel loading={personaDetail.isLoading} detail={personaDetail.data ?? null} />}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => void utils.account.listAgentLabPersonas.invalidate()}
        />
      ) : null}
    </div>
  );
}
