import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  ArrowLeft,
  ChevronDown,
  MessageSquarePlus,
  MessagesSquare,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { trpc } from '../trpc/client';
import { useAppDialog } from '../lib/dialogUtils';
import { QqAvatar } from '../components/QqAvatar';
import {
  NewCloneModal,
  type BuddyOption,
  type FlatModels,
  type StartCloneArgs,
} from './agentlab/NewCloneModal';
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
import { buildFaceMap, type FaceContext } from './agentlab/ChatBubble';
import { CloneChatPanel } from './agentlab/CloneChatPanel';
import { NewGroupModal, type GroupPersonaOption } from './agentlab/NewGroupModal';
import { GroupChatPanel } from './agentlab/GroupChatPanel';

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
      {items.map((item) => (
        <span key={item} className="weq-pp-chip">
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

function PersonaParamsPanel({
  loading,
  detail,
}: {
  loading: boolean;
  detail: PersonaParamsDetail | null;
}): ReactElement {
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
          源消息 {stats.sourceMessageCount} · 对方 {stats.friendMessageCount} · 轮次{' '}
          {stats.turnCount} · 问答对 {stats.pairCount} · 均字 {stats.avgFriendMsgChars} · 连发{' '}
          {stats.avgFriendBurst} · 语料 {stats.corpusChars} 字
          {stats.groupStyleMessageCount > 0 ? ` · 群补采 ${stats.groupStyleMessageCount} 条` : ''}
        </span>
      </Row>
      <Row label="语气">{card.tone || profile.styleSummary || '—'}</Row>
      <Row label="标点习惯">{card.punctuationStyle || '—'}</Row>
      <Row label="称呼">{card.addressing || '—'}</Row>
      <Row label="性格">
        <Chips items={card.personalityTraits} />
      </Row>
      <Row label="口头禅">
        <Chips items={card.catchphrases} />
      </Row>
      <Row label="话题">
        <Chips items={card.topics.length ? card.topics : profile.topTerms} />
      </Row>
      <Row label="语音">
        {voiceProfile?.scenarioSummary || profile.voiceUsageSummary}（占比{' '}
        {Math.round((voiceProfile?.ratio ?? profile.voiceRatio) * 100)}%）
      </Row>
      <Row label="系统表情">
        <Chips items={systemFaces} />
      </Row>
      <Row label="表情包">
        {stickers.length === 0 ? (
          <span className="weq-pp-dim">—</span>
        ) : (
          <div className="weq-pp-stickers">
            {stickers.map((s) => (
              <span key={`${s.description}-${s.scenario}-${s.count}`} className="weq-pp-sticker">
                ×{s.count} {s.description || '（未解读）'}
                {s.scenario ? `（${s.scenario}）` : ''}
              </span>
            ))}
          </div>
        )}
      </Row>
      <Row label="关系">{deep.relationship || profile.relationshipSummary || '—'}</Row>
      <Row label="事实">
        <Chips items={deep.facts} />
      </Row>
      <Row label="反应模式">
        <Chips items={deep.reactionPatterns} />
      </Row>
      <Row label="立场雷点">
        <Chips items={deep.boundaries} />
      </Row>

      <details className="weq-pp-samples">
        <summary>
          代表样本 {fewShots.length} 组 / 真实问答对抽样 {detail.pairs.length} 条
        </summary>
        <div className="weq-pp-samples-body">
          {fewShots.map((pair) => (
            <div key={`${pair.prompt}-${pair.reply}`} className="weq-pp-sample">
              <div className="weq-pp-sample-q">我：{pair.prompt}</div>
              <div>
                {detail.persona.name}：{pair.reply}
              </div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

type Selection =
  | { kind: 'home' }
  // navKey 是右侧面板的稳定挂载 key：草稿(sessionId=null) 首次发消息
  // 升级为真会话时只改 sessionId、navKey 不变，故组件不重挂载、流式不中断。
  | { kind: 'assistant'; sessionId: string | null; navKey: number }
  // 克隆体私聊：点克隆体开新草稿会话；会话下拉切换已有会话。
  | { kind: 'persona'; id: string; sessionId: string | null; navKey: number }
  // 克隆体群聊：同样支持多会话。
  | { kind: 'group'; id: string; sessionId: string | null; navKey: number };

/** 每页展开显示的会话条数（超出点「查看更多」分页）。 */
const SESSION_PAGE = 5;

/** 左栏可展开行：头部（克隆体/群聊条目）+ 展开后的会话列表（分页/新建/删除）。 */
function ExpandableSessionRow({
  head,
  active,
  ownerId,
  ownerKind,
  activeSessionId,
  onOpen,
  onOpenSession,
  onNewSession,
  onDeleteSession,
}: {
  head: ReactNode;
  active: boolean;
  ownerId: string;
  ownerKind: 'persona' | 'group';
  activeSessionId: string | null;
  /** 点条目本身：开启新会话。 */
  onOpen: () => void;
  onOpenSession: (sessionId: string) => void;
  onNewSession: () => void;
  onDeleteSession: (sessionId: string) => void;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [limit, setLimit] = useState(SESSION_PAGE);
  const personaSessions = trpc.account.listAgentLabPersonaSessions.useQuery(
    { personaId: ownerId },
    { enabled: ownerKind === 'persona' && expanded },
  );
  const groupSessions = trpc.account.listAgentLabGroupSessions.useQuery(
    { groupId: ownerId },
    { enabled: ownerKind === 'group' && expanded },
  );
  const sessions =
    ownerKind === 'persona' ? (personaSessions.data ?? []) : (groupSessions.data ?? []);
  // 收起再展开时重置分页。
  useEffect(() => {
    if (!expanded) setLimit(SESSION_PAGE);
  }, [expanded]);

  return (
    <div className={`weq-clone-row${active ? ' is-active' : ''}`}>
      <div className="weq-clone-row-head">
        <button
          className={`weq-agentlab-item${active ? ' is-active' : ''}`}
          onClick={onOpen}
          title="开启新会话"
        >
          {head}
        </button>
        <button
          type="button"
          className={`weq-clone-row-toggle${expanded ? ' is-open' : ''}`}
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? '收起会话列表' : '展开会话列表'}
          title="会话"
        >
          <ChevronDown size={14} />
        </button>
      </div>
      {expanded ? (
        <div className="weq-clone-sessions">
          {sessions.length === 0 ? (
            <div className="weq-clone-sessions-empty">还没有会话，点条目或下方新建。</div>
          ) : (
            sessions.slice(0, limit).map((s) => (
              <div
                key={s.id}
                className={`weq-clone-session${s.id === activeSessionId ? ' is-active' : ''}`}
              >
                <button
                  type="button"
                  className="weq-clone-session-open"
                  onClick={() => onOpenSession(s.id)}
                >
                  <span className="weq-clone-session-title">{s.title}</span>
                  <small>{relTime(s.updatedAt)}</small>
                </button>
                <button
                  type="button"
                  className="weq-clone-session-del"
                  title="删除会话"
                  onClick={() => onDeleteSession(s.id)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))
          )}
          {sessions.length > limit ? (
            <button
              type="button"
              className="weq-clone-session-more"
              onClick={() => setLimit((l) => l + SESSION_PAGE)}
            >
              查看更多（{sessions.length - limit}）
            </button>
          ) : null}
          <button type="button" className="weq-clone-session-new" onClick={onNewSession}>
            <Plus size={12} /> 新建会话
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function AgentLabView(): ReactElement {
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const providers = trpc.bootstrap.listAgentLabProviders.useQuery();
  const buddies = trpc.account.listBuddies.useQuery(undefined);
  const personas = trpc.account.listAgentLabPersonas.useQuery();
  const deletePersona = trpc.account.deleteAgentLabPersona.useMutation();
  const deletePersonaSession = trpc.account.deleteAgentLabPersonaSession.useMutation();
  const deleteGroupSession = trpc.account.deleteAgentLabGroupSession.useMutation();
  const groups = trpc.account.listAgentLabGroups.useQuery();
  const createGroup = trpc.account.createAgentLabGroup.useMutation();
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
        return {
          uid: item.uid,
          uin: p?.uin || item.uin || '',
          label: p?.label || item.uin || item.uid,
          avatarUrl: p?.avatarUrl,
        };
      }),
    [buddies.data, profileByUid],
  );

  const flatModels: FlatModels = useMemo(() => {
    const build = (cap: 'chat' | 'embedding' | 'vision') =>
      (providers.data ?? []).flatMap((p) =>
        p.models
          .filter((m) => m.capabilities.includes(cap))
          .map((m) => ({
            key: `${p.id}::${m.id}`,
            providerId: p.id,
            model: m.id,
            label: `${p.name} · ${m.label ?? m.id}`,
          })),
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
  const [groupOpen, setGroupOpen] = useState(false);
  // 克隆任务列表：抬到模块级 store（脱离本组件生命周期），切出 AgentLab 再回来任务不丢（bug2）。
  const cloneTasks = useSyncExternalStore(subscribeCloneTasks, getCloneTasks);
  const [viewTaskId, setViewTaskId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 递增序号，用来给每次「打开克隆体 / 群聊 / 会话」生成一个不重复的挂载 key（见 Selection.navKey）。
  const navSeq = useRef(0);

  const activePersona =
    sel.kind === 'persona' ? (personaList.find((item) => item.id === sel.id) ?? null) : null;
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
    { personaId: sel.kind === 'persona' ? sel.id : '' },
    { enabled: settingsOpen && sel.kind === 'persona' },
  );

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

  /** 点克隆体 → 开一个新草稿会话（列表默认展示克隆体本身，点它即开启新会话）。 */
  function selectPersona(id: string): void {
    setSettingsOpen(false);
    // 已在本克隆体的未落库草稿里：重复点击不重置（避免误触清掉正在输入的内容）。
    if (sel.kind === 'persona' && sel.id === id && sel.sessionId === null) return;
    navSeq.current += 1;
    setSel({ kind: 'persona', id, sessionId: null, navKey: navSeq.current });
  }

  /** 点群聊 → 开一个新草稿会话。 */
  function openGroup(id: string): void {
    if (sel.kind === 'group' && sel.id === id && sel.sessionId === null) return;
    navSeq.current += 1;
    setSel({ kind: 'group', id, sessionId: null, navKey: navSeq.current });
  }

  /** 草稿会话首条消息落库后：把选中态指向新会话（navKey 不变，面板不重挂载）。 */
  function onPersonaSessionCreated(personaId: string, navKey: number, sessionId: string): void {
    setSel((cur) =>
      cur.kind === 'persona' && cur.id === personaId && cur.navKey === navKey
        ? { ...cur, sessionId }
        : cur,
    );
  }

  function onSwitchPersonaSession(personaId: string, sessionId: string): void {
    navSeq.current += 1;
    setSel({ kind: 'persona', id: personaId, sessionId, navKey: navSeq.current });
  }

  function onNewPersonaSession(personaId: string): void {
    navSeq.current += 1;
    setSel({ kind: 'persona', id: personaId, sessionId: null, navKey: navSeq.current });
  }

  function onGroupSessionCreated(groupId: string, navKey: number, sessionId: string): void {
    setSel((cur) =>
      cur.kind === 'group' && cur.id === groupId && cur.navKey === navKey
        ? { ...cur, sessionId }
        : cur,
    );
  }

  function onSwitchGroupSession(groupId: string, sessionId: string): void {
    navSeq.current += 1;
    setSel({ kind: 'group', id: groupId, sessionId, navKey: navSeq.current });
  }

  function onNewGroupSession(groupId: string): void {
    navSeq.current += 1;
    setSel({ kind: 'group', id: groupId, sessionId: null, navKey: navSeq.current });
  }

  /** 打开一个全新草稿会话（不落库；用户真发消息才由 AssistantPanel 建会话）。 */
  function openAssistantDraft(): void {
    navSeq.current += 1;
    setSel({ kind: 'assistant', sessionId: null, navKey: navSeq.current });
  }

  /** 打开一段既有会话。 */
  function openAssistantSession(sessionId: string): void {
    navSeq.current += 1;
    setSel({ kind: 'assistant', sessionId, navKey: navSeq.current });
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
      // 删的是当前打开的会话 → 换成一个新草稿，保持「进来就有个新会话」的体验。
      navSeq.current += 1;
      const draftKey = navSeq.current;
      setSel((cur) =>
        cur.kind === 'assistant' && cur.sessionId === sessionId
          ? { kind: 'assistant', sessionId: null, navKey: draftKey }
          : cur,
      );
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

  const groupPersonaOptions: GroupPersonaOption[] = useMemo(
    () =>
      personaList.map((p) => ({
        id: p.id,
        name: p.name,
        uin: profileByUid.get(p.sourceId)?.uin,
        sourceTitle: p.sourceTitle,
      })),
    [personaList, profileByUid],
  );

  async function onCreateGroup(args: { name: string; personaIds: string[] }): Promise<void> {
    try {
      const { group } = await createGroup.mutateAsync(args);
      setGroupOpen(false);
      await utils.account.listAgentLabGroups.invalidate();
      navSeq.current += 1;
      setSel({ kind: 'group', id: group.id, sessionId: null, navKey: navSeq.current });
    } catch (error) {
      dialog.error('建群失败', error instanceof Error ? error.message : String(error));
    }
  }

  /** 左栏删除克隆体会话：确认 → 删 → 若删的是当前会话则换新草稿。 */
  async function onDeletePersonaSession(personaId: string, sessionId: string): Promise<void> {
    const ok = await dialog.confirm('删除会话', '确认删除这段对话？删除后无法恢复。', {
      okLabel: '删除',
      tone: 'warning',
    });
    if (!ok) return;
    try {
      await deletePersonaSession.mutateAsync({ personaId, sessionId });
      await utils.account.listAgentLabPersonaSessions.invalidate({ personaId });
      // 删的是当前打开的会话 → 换成新草稿，保持「进来就有个新会话」的体验。
      if (sel.kind === 'persona' && sel.id === personaId && sel.sessionId === sessionId) {
        onNewPersonaSession(personaId);
      }
    } catch (error) {
      dialog.error('删除失败', error instanceof Error ? error.message : String(error));
    }
  }

  /** 左栏删除群聊会话：确认 → 删 → 若删的是当前会话则换新草稿。 */
  async function onDeleteGroupSession(groupId: string, sessionId: string): Promise<void> {
    const ok = await dialog.confirm('删除会话', '确认删除这段对话？删除后无法恢复。', {
      okLabel: '删除',
      tone: 'warning',
    });
    if (!ok) return;
    try {
      await deleteGroupSession.mutateAsync({ groupId, sessionId });
      await utils.account.listAgentLabGroupSessions.invalidate({ groupId });
      if (sel.kind === 'group' && sel.id === groupId && sel.sessionId === sessionId) {
        onNewGroupSession(groupId);
      }
    } catch (error) {
      dialog.error('删除失败', error instanceof Error ? error.message : String(error));
    }
  }

  async function onDeletePersona(): Promise<void> {
    const personaId = sel.kind === 'persona' ? sel.id : '';
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
      await utils.account.listAgentLabPersonas.invalidate();
      dialog.success('已删除');
    } catch (error) {
      dialog.error('删除失败', error instanceof Error ? error.message : String(error));
    }
  }

  // 克隆体头部副标题：provider · 模型 · 样本 N 条。
  const personaModelLabel = useMemo(() => {
    if (!activePersona) return '加载中…';
    const p = (providers.data ?? []).find((pr) => pr.id === activePersona.models?.chat?.providerId);
    const modelText = activePersona.models?.chat?.model ?? '旧版克隆，请重建';
    return `${p ? `${p.name} · ` : ''}${modelText} · 样本 ${activePersona.corpusMessageCount} 条`;
  }, [activePersona, providers.data]);

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
            <button className="weq-agentlab-newclone" onClick={openAssistantDraft}>
              <MessageSquarePlus size={15} /> 新建对话
            </button>
            <div className="weq-agentlab-list-scroll">
              {assistantSessions.length === 0 ? (
                <div className="weq-agentlab-empty" style={{ padding: '8px 10px' }}>
                  还没有保存的对话，聊几句就会自动保存到这里。
                </div>
              ) : (
                assistantSessions.map((s) => (
                  <button
                    key={s.id}
                    className={`weq-agentlab-item${sel.sessionId === s.id ? ' is-active' : ''}`}
                    onClick={() => openAssistantSession(s.id)}
                  >
                    <span className="weq-agentlab-item-avatar is-bot">
                      <MessagesSquare size={16} />
                    </span>
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
            <button className="weq-agentlab-item" onClick={openAssistantDraft}>
              <span className="weq-agentlab-item-avatar is-bot">
                <Sparkles size={18} />
              </span>
              <span className="weq-agentlab-item-text">
                <strong>WeQ 助手</strong>
                <small>调用工具帮你完成操作</small>
              </span>
            </button>

            <div className="weq-agentlab-list-label">好友克隆</div>
            <div className="weq-agentlab-list-scroll">
              {personaList.map((p) => {
                const prof = profileByUid.get(p.sourceId);
                const active = sel.kind === 'persona' && sel.id === p.id;
                return (
                  <ExpandableSessionRow
                    key={p.id}
                    head={
                      <>
                        <QqAvatar uin={prof?.uin} size={34} />
                        <span className="weq-agentlab-item-text">
                          <strong>{p.name}</strong>
                          <small>{p.sourceTitle}</small>
                        </span>
                      </>
                    }
                    active={active}
                    ownerId={p.id}
                    ownerKind="persona"
                    activeSessionId={active ? sel.sessionId : null}
                    onOpen={() => selectPersona(p.id)}
                    onOpenSession={(sessionId) => onSwitchPersonaSession(p.id, sessionId)}
                    onNewSession={() => onNewPersonaSession(p.id)}
                    onDeleteSession={(sessionId) => void onDeletePersonaSession(p.id, sessionId)}
                  />
                );
              })}
              {/* 列表末尾常驻新建：列表为空时它就是唯一的行（替代「还没有克隆体。」）。 */}
              <button className="weq-agentlab-newclone" onClick={() => setCloneOpen(true)}>
                <Plus size={15} /> 新建克隆
              </button>
            </div>

            <div className="weq-agentlab-list-label">群聊</div>
            <div className="weq-agentlab-list-scroll">
              {(groups.data ?? []).map((g) => {
                const active = sel.kind === 'group' && sel.id === g.id;
                return (
                  <ExpandableSessionRow
                    key={g.id}
                    head={
                      <>
                        <span className="weq-agentlab-item-avatar is-bot">
                          <MessagesSquare size={16} />
                        </span>
                        <span className="weq-agentlab-item-text">
                          <strong>{g.name}</strong>
                          <small>群聊</small>
                        </span>
                      </>
                    }
                    active={active}
                    ownerId={g.id}
                    ownerKind="group"
                    activeSessionId={active ? sel.sessionId : null}
                    onOpen={() => openGroup(g.id)}
                    onOpenSession={(sessionId) => onSwitchGroupSession(g.id, sessionId)}
                    onNewSession={() => onNewGroupSession(g.id)}
                    onDeleteSession={(sessionId) => void onDeleteGroupSession(g.id, sessionId)}
                  />
                );
              })}
              <button className="weq-agentlab-newclone" onClick={() => setGroupOpen(true)}>
                <Plus size={15} /> 新建群聊
              </button>
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
          <AssistantPanel
            key={sel.navKey}
            sessionId={sel.sessionId}
            chatModels={flatModels.chat}
            onBack={() => setSel({ kind: 'home' })}
            onSessionCreated={(newId) =>
              setSel((cur) =>
                cur.kind === 'assistant' && cur.navKey === sel.navKey
                  ? { ...cur, sessionId: newId }
                  : cur,
              )
            }
          />
        ) : sel.kind === 'group' ? (
          <GroupChatPanel
            key={sel.navKey}
            groupId={sel.id}
            sessionId={sel.sessionId}
            selfUin={selfProfile.data?.uin}
            personaList={personaList}
            profileByUid={profileByUid}
            faceDescToId={faceDescToId}
            onBack={() => setSel({ kind: 'home' })}
            onDeleted={() => setSel({ kind: 'home' })}
            onSessionCreated={(sessionId) => onGroupSessionCreated(sel.id, sel.navKey, sessionId)}
          />
        ) : sel.kind === 'persona' && activePersona ? (
          <CloneChatPanel
            key={sel.navKey}
            personaId={sel.id}
            persona={activePersona}
            sessionId={sel.sessionId}
            selfUin={selfProfile.data?.uin}
            clonedUin={clonedProfile?.uin}
            faces={cloneFaces}
            modelLabel={personaModelLabel}
            onBack={() => setSel({ kind: 'home' })}
            onSessionCreated={(sessionId) => onPersonaSessionCreated(sel.id, sel.navKey, sessionId)}
            onOpenSettings={() => setSettingsOpen(true)}
            onDeletePersona={() => void onDeletePersona()}
          />
        ) : (
          <div className="weq-agentlab-chat">
            <div className="weq-agentlab-empty">加载中…</div>
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

      {groupOpen ? (
        <NewGroupModal
          personas={groupPersonaOptions}
          onClose={() => setGroupOpen(false)}
          onCreate={(args) => void onCreateGroup(args)}
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
            willing: activePersona.willing,
            typo: activePersona.typo,
          }}
          paramsContent={
            <PersonaParamsPanel
              loading={personaDetail.isLoading}
              detail={personaDetail.data ?? null}
            />
          }
          onClose={() => setSettingsOpen(false)}
          onSaved={() => void utils.account.listAgentLabPersonas.invalidate()}
        />
      ) : null}
    </div>
  );
}

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
