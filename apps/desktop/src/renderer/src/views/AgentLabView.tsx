import { TimeLabel } from '../components/TimeLabel';
import * as timeFormat from '@weq/time';
import { z } from 'zod';
import { usePageState } from '../components/PageSnapshots';
import { LoadingIndicator } from '../components/LoadingIndicator';
import { pageValue } from '../lib/pageSnapshots';
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { MessageSquarePlus, MessagesSquare, Plus, PanelLeft, Sparkles, Trash2 } from 'lucide-react';
import { trpc } from '../trpc/client';
import { isDefaultModelSelection } from '@weq/agentlab/model-selection';
import { useModelSelectionLabel } from '../components/settings/useModelSelectionLabel';
import { useProfileResolver } from '../hooks/useProfileResolver';
import { useAppDialog } from '../lib/dialogUtils';
import { QqAvatar } from '../components/QqAvatar';
import { GroupMosaicAvatar } from '../components/GroupMosaicAvatar';
import {
  NewCloneModal,
  type BuddyOption,
  type FlatModels,
  type StartCloneArgs,
} from './agentlab/NewCloneModal';
import { getCloneTasks, startCloneTask } from './agentlab/cloneTaskStore';
import { PersonaSettingsModal } from './agentlab/PersonaSettingsModal';
import { CloneGenerationPanel } from '../components/settings/CloneGenerationPanel';
import { personaUpdatedAt } from './agentlab/personaUpdatedAt';
import { AssistantPanel } from './agentlab/AssistantPanel';
import { buildFaceMap, type FaceContext } from './agentlab/ChatBubble';
import { CloneChatPanel } from './agentlab/CloneChatPanel';
import { NewGroupModal, type GroupPersonaOption } from './agentlab/NewGroupModal';
import { GroupChatPanel } from './agentlab/GroupChatPanel';
import type { GeneratedSearchHit } from '../components/search/types';
import '../styles/agentlab-workspace.css';

/** 好友资料里 AgentLab 头像/名称真正用到的字段（够用即可，避免耦合完整 profile 结构）。 */
type AgentLabProfileWire = {
  uid: string;
  uin: string;
  nick: string;
  remark: string;
  avatarUrl: string;
};

/** 传空数组给 resolver = 不预热，全部按需分块补全。常量引用保证 useMemo 依赖稳定。 */
const NO_PRIMED_PROFILES: readonly AgentLabProfileWire[] = [];

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
  if (loading) return <div className="weq-agentlab-params">加载画像中…</div>;
  if (!detail) return <div className="weq-agentlab-params">暂无画像。</div>;
  const { stats, profile, fewShots } = detail.persona;
  const card = profile.card;
  const deep = profile.deep;
  const systemFaces = detail.persona.systemFaces ?? [];
  const stickers = detail.persona.stickers ?? [];
  const voiceProfile = detail.persona.voiceProfile;
  return (
    <div className="weq-agentlab-params">
      <div className="weq-pp-head">
        <strong className="weq-pp-title">画像与样本</strong>
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

type Selection = (
  | { kind: 'home' }
  // navKey 是右侧面板的稳定挂载 key：草稿(sessionId=null) 首次发消息
  // 升级为真会话时只改 sessionId、navKey 不变，故组件不重挂载、流式不中断。
  | { kind: 'assistant'; sessionId: string | null; navKey: number }
  // 共享列表恢复最近会话；显式新建才打开空草稿。
  | { kind: 'persona'; id: string; sessionId: string | null; navKey: number }
  // 克隆体群聊：同样支持多会话。
  | { kind: 'group'; id: string; sessionId: string | null; navKey: number }
) & { searchTarget?: GeneratedSearchHit; readOnlyLegacy?: boolean };

function CloneConversationRow({
  head,
  active,
  onOpen,
}: {
  head: ReactNode;
  active: boolean;
  onOpen: () => void;
}): ReactElement {
  return (
    <button className={`weq-agentlab-item${active ? ' is-active' : ''}`} onClick={onOpen}>
      {head}
    </button>
  );
}

export function AgentLabView({
  mode = 'clones',
  searchTarget,
  openTarget,
  createRequest,
  createFriendUids,
  openGroupRequest,
  embedded = false,
  onBackToDirectory,
  onConversationCreated,
}: {
  mode?: 'clones' | 'assistant';
  searchTarget?: GeneratedSearchHit | null;
  openTarget?: { kind: 'persona' | 'group'; id: string; revision: number } | null;
  /** 新建克隆请求的版本号；用 revision 区分「再点一次也要重新打开」。 */
  createRequest?: { revision: number; friendUids?: string[] } | null;
  /** 兼容旧调用：单独传好友 uid 列表（与 createRequest 二选一）。 */
  createFriendUids?: string[];
  /** 新建克隆体群聊请求的版本号。 */
  openGroupRequest?: number;
  embedded?: boolean;
  onBackToDirectory?: () => void;
  onConversationCreated?: (target: { kind: 'persona' | 'group'; id: string }) => void;
}): ReactElement {
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const providers = trpc.bootstrap.listAgentLabProviders.useQuery();
  const buddies = trpc.account.listBuddies.useQuery(undefined);
  const personas = trpc.account.listAgentLabPersonas.useQuery();
  const deletePersona = trpc.account.deleteAgentLabPersona.useMutation();
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
  // 好友资料必须按 IPC 的单次上限（200）分批补全：以前这里一次性传 slice(0, 300)，
  // 好友数一过 200 整条查询就被 schema 打回，profileByUid 变空 Map，所有克隆体
  // 因为拿不到 uin 而回落成默认灰头像。分块交给统一的 profile resolver。
  const { profileByUid: buddyProfiles, resolveProfiles } =
    useProfileResolver<AgentLabProfileWire>(NO_PRIMED_PROFILES);
  useEffect(() => {
    resolveProfiles(buddyUids);
  }, [buddyUids, resolveProfiles]);
  const profileByUid = useMemo(() => {
    const map = new Map<string, { uin: string; label: string; avatarUrl?: string }>();
    for (const row of buddyProfiles.values()) {
      map.set(row.uid, {
        uin: row.uin,
        label: row.remark || row.nick || row.uin || row.uid,
        avatarUrl: row.avatarUrl || undefined,
      });
    }
    return map;
  }, [buddyProfiles]);

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

  const [sel, setSel] = usePageState<Selection>(
    'agentlab:selection',
    () => {
      if (searchTarget && (searchTarget.kind === 'assistant') === (mode === 'assistant')) {
        return searchTarget.kind === 'assistant'
          ? { kind: 'assistant', sessionId: searchTarget.sessionId, navKey: 0, searchTarget }
          : {
              kind: searchTarget.kind,
              id: searchTarget.ownerId,
              sessionId: searchTarget.sessionId,
              navKey: 0,
              searchTarget,
            };
      }
      return mode === 'assistant'
        ? { kind: 'assistant', sessionId: null, navKey: 0 }
        : { kind: 'home' };
    },
    z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('home') }),
        z.object({
          kind: z.literal('assistant'),
          sessionId: z.string().nullable(),
          navKey: z.number(),
        }),
        z.object({
          kind: z.literal('persona'),
          id: z.string(),
          sessionId: z.string().nullable(),
          navKey: z.number(),
        }),
        z.object({
          kind: z.literal('group'),
          id: z.string(),
          sessionId: z.string().nullable(),
          navKey: z.number(),
        }),
      ])
      .and(z.object({ readOnlyLegacy: z.boolean().optional() })),
  );
  // WeQ 助手会话列表：仅进入助手模式时拉取。
  const assistantSessionsQuery = trpc.account.listAssistantSessions.useQuery(undefined, {
    enabled: sel.kind === 'assistant',
  });
  const assistantSessions = assistantSessionsQuery.data ?? [];
  const [cloneOpen, setCloneOpen] = useState(false);
  const [clonePreselect, setClonePreselect] = useState<string[]>([]);
  useEffect(() => {
    if (!createRequest) return;
    setClonePreselect(createRequest.friendUids ?? createFriendUids ?? []);
    setCloneOpen(true);
  }, [createRequest, createFriendUids]);
  useEffect(() => {
    if (openGroupRequest) setGroupOpen(true);
  }, [openGroupRequest]);
  const [appliedOpenTarget, setAppliedOpenTarget] = usePageState<string | null>(
    'agentlab:open-target',
    null,
    pageValue.optionalString,
  );
  const openTargetKey = JSON.stringify(openTarget ?? null);
  useEffect(() => {
    if (searchTarget || !openTarget || appliedOpenTarget === openTargetKey) return;
    setAppliedOpenTarget(openTargetKey);
    navSeq.current += 1;
    setSel({
      kind: openTarget.kind,
      id: openTarget.id,
      sessionId: null,
      navKey: navSeq.current,
    });
  }, [openTarget, openTargetKey, appliedOpenTarget, setAppliedOpenTarget, searchTarget, setSel]);
  const [groupOpen, setGroupOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memberSettingsId, setMemberSettingsId] = useState<string | null>(null);
  const [mobileListOpen, setMobileListOpen] = useState(false);
  useEffect(() => setMobileListOpen(false), [sel]);
  // 递增序号，用来给每次「打开克隆体 / 群聊 / 会话」生成一个不重复的挂载 key（见 Selection.navKey）。
  const navSeq = useRef(sel.kind === 'home' ? 0 : sel.navKey);
  const [appliedSearch, setAppliedSearch] = usePageState<string | null>(
    'agentlab:search',
    null,
    pageValue.optionalString,
  );
  const searchKey = JSON.stringify([searchTarget ?? null, mode]);
  useEffect(() => {
    if (appliedSearch === searchKey) return;
    setAppliedSearch(searchKey);
    if (!searchTarget || (searchTarget.kind === 'assistant') !== (mode === 'assistant')) return;
    navSeq.current += 1;
    if (searchTarget.kind === 'assistant') {
      setSel({
        kind: 'assistant',
        sessionId: searchTarget.sessionId,
        navKey: navSeq.current,
        searchTarget,
      });
    } else {
      setSel({
        kind: searchTarget.kind,
        id: searchTarget.ownerId,
        sessionId: null,
        navKey: navSeq.current,
        searchTarget,
      });
    }
  }, [searchTarget, mode, searchKey, appliedSearch, setAppliedSearch, setSel]);

  const activePersona =
    sel.kind === 'persona' ? (personaList.find((item) => item.id === sel.id) ?? null) : null;
  const settingsPersona = memberSettingsId
    ? (personaList.find((item) => item.id === memberSettingsId) ?? null)
    : activePersona;
  const clonedProfile = activePersona ? profileByUid.get(activePersona.sourceId) : undefined;
  // 克隆体气泡的系统表情渲染上下文：用 TA 的 faceText 白名单 + 全局 faceText→id 映射。
  const cloneFaces: FaceContext | undefined = useMemo(
    () => ({ whitelist: activePersona?.systemFaces ?? [], descToId: faceDescToId }),
    [activePersona?.systemFaces, faceDescToId],
  );
  const personaDetail = trpc.account.getAgentLabPersonaDetail.useQuery(
    { personaId: settingsPersona?.id ?? '' },
    { enabled: settingsOpen && !!settingsPersona },
  );

  // 选中的 persona 被删除时回退到主页。
  useEffect(() => {
    if (sel.kind === 'persona' && personas.data && !personaList.some((p) => p.id === sel.id)) {
      setSel({ kind: 'home' });
    }
  }, [sel, personas.data, personaList, setSel]);

  /** 角色和群始终打开自己的长期对话，重复点击不会重挂载输入区。 */
  function selectPersona(id: string): void {
    setSettingsOpen(false);
    setMemberSettingsId(null);
    // 已在本克隆体的未落库草稿里：重复点击不重置（避免误触清掉正在输入的内容）。
    if (sel.kind === 'persona' && sel.id === id) return;
    navSeq.current += 1;
    setSel({ kind: 'persona', id, sessionId: null, navKey: navSeq.current });
  }

  function openGroup(id: string): void {
    setSettingsOpen(false);
    setMemberSettingsId(null);
    if (sel.kind === 'group' && sel.id === id) return;
    navSeq.current += 1;
    setSel({ kind: 'group', id, sessionId: null, navKey: navSeq.current });
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

  // 由配置弹窗发起构建：关弹窗 → 模块级 store 登记后台任务并打开统一列表。
  // 构建脱离本组件，切走再回来任务态仍在。完成后由主界面刷新共享克隆体列表。
  function startClone(args: StartCloneArgs): void {
    setCloneOpen(false);
    void startCloneTask(args).then(() => {
      if (
        getCloneTasks().some(
          (task) => task.personaId === args.params.personaId && task.status === 'done',
        )
      ) {
        void utils.account.listAgentLabPersonas.invalidate();
        onConversationCreated?.({ kind: 'persona', id: args.params.personaId });
      }
    });
  }

  const groupPersonaOptions: GroupPersonaOption[] = useMemo(
    () =>
      personaList.map((p) => ({
        id: p.id,
        name: p.name,
        // 好友资料还没补全（或好友已被删）时用后端随 persona 下发的 sourceUin 兜底。
        uin: profileByUid.get(p.sourceId)?.uin || p.sourceUin,
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
      onConversationCreated?.({ kind: 'group', id: group.id });
    } catch (error) {
      dialog.error('建群失败', error instanceof Error ? error.message : String(error));
    }
  }

  async function onDeletePersona(): Promise<void> {
    const personaId = settingsPersona?.id;
    if (!personaId) return;
    const ok = await dialog.confirm(
      '删除克隆体',
      `永久删除「${settingsPersona?.name}」及其全部私聊历史和记忆，无法恢复，也不会进入“已删除会话”。正在进行的回答会先停止并等待写入结束；群聊中的既有消息会保留。`,
      {
        okLabel: '删除',
        cancelLabel: '返回',
        tone: 'warning',
      },
    );
    if (!ok) return;
    try {
      const deleted = await deletePersona.mutateAsync({ personaId });
      if (!deleted) throw new Error('克隆体删除失败');
      setSettingsOpen(false);
      setMemberSettingsId(null);
      if (sel.kind === 'persona' && sel.id === personaId) {
        setSel({ kind: 'home' });
        if (embedded) onBackToDirectory?.();
      }
      await Promise.all([
        utils.account.listAgentLabPersonas.invalidate(),
        utils.account.listAgentLabGroups.invalidate(),
        utils.account.getAgentLabGroupDetail.invalidate(),
      ]);
      dialog.success('已删除');
    } catch (error) {
      dialog.error('删除失败', error instanceof Error ? error.message : String(error));
    }
  }

  // 克隆体头部副标题：provider · 模型 · 样本 N 条 · 画像更新时间。
  const selectionLabel = useModelSelectionLabel();
  const personaModelLabel = useMemo(() => {
    if (!activePersona) return '加载中…';
    const ref = activePersona.models?.chat;
    const p =
      ref && !isDefaultModelSelection(ref)
        ? (providers.data ?? []).find((pr) => pr.id === ref.providerId)
        : undefined;
    const modelText = selectionLabel(ref, '旧版克隆，请重建');
    return `${p ? `${p.name} · ` : ''}${modelText} · 样本 ${activePersona.corpusMessageCount} 条 · 更新于 ${personaUpdatedAt(activePersona)}`;
  }, [activePersona, providers.data, selectionLabel]);

  return (
    <div
      className={`weq-agentlab-shell weq-agentlab-workspace${embedded ? ' is-embedded' : ''}${sel.kind !== 'home' ? ' is-conversation' : ''}${mobileListOpen ? ' is-list-open' : ''}`}
    >
      {/* 左侧 agent 列表 */}
      <aside
        className="weq-agentlab-list"
        hidden={embedded}
        style={embedded ? { display: 'none' } : undefined}
      >
        {sel.kind !== 'home' && !embedded ? (
          <button
            type="button"
            className="weq-agentlab-mobile-nav"
            onClick={() => setMobileListOpen(false)}
            title="返回对话"
            aria-label="返回对话"
          >
            <PanelLeft size={18} />
          </button>
        ) : null}
        {sel.kind === 'assistant' ? (
          <>
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
                      <small>
                        <TimeLabel value={s.updatedAt} precision="millisecond">
                          {relTime(s.updatedAt)}
                        </TimeLabel>
                      </small>
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
            <div className="weq-agentlab-list-head">克隆消息 · 模拟对话</div>

            <div className="weq-agentlab-list-label">好友克隆</div>
            <div className="weq-agentlab-list-scroll">
              {personaList.map((p) => {
                const prof = profileByUid.get(p.sourceId);
                const active = sel.kind === 'persona' && sel.id === p.id;
                return (
                  <CloneConversationRow
                    key={p.id}
                    head={
                      <>
                        <QqAvatar uin={prof?.uin || p.sourceUin} size={34} />
                        <span className="weq-agentlab-item-text">
                          <strong>{p.name}</strong>
                          <small>{p.sourceTitle}</small>
                        </span>
                      </>
                    }
                    active={active}
                    onOpen={() => selectPersona(p.id)}
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
                  <CloneConversationRow
                    key={g.id}
                    head={
                      <>
                        {/* 群头像用克隆体成员头像拼合成头像；成员 uin 还没解析出来时回落到群图标。
                            用可选链兼容升级前写进缓存、没有 memberUins 的旧结果。 */}
                        {g.memberUins?.length ? (
                          <GroupMosaicAvatar uins={g.memberUins} size={34} shape="square" />
                        ) : (
                          <span className="weq-agentlab-item-avatar is-bot">
                            <MessagesSquare size={16} />
                          </span>
                        )}
                        <span className="weq-agentlab-item-text">
                          <strong>{g.name}</strong>
                          <small>群聊</small>
                        </span>
                      </>
                    }
                    active={active}
                    onOpen={() => openGroup(g.id)}
                  />
                );
              })}
              <button className="weq-agentlab-newclone" onClick={() => setGroupOpen(true)}>
                <Plus size={15} /> 新建群聊
              </button>
            </div>
          </>
        )}
      </aside>

      {/* 右侧主区 */}
      <section className="weq-agentlab-main">
        {sel.kind !== 'home' && !embedded ? (
          <button
            type="button"
            className="weq-agentlab-mobile-nav"
            onClick={() => setMobileListOpen(true)}
            title="会话列表"
            aria-label="会话列表"
          >
            <PanelLeft size={18} />
          </button>
        ) : null}
        {sel.kind === 'home' ? (
          embedded ? null : (
            <div className="weq-agentlab-empty">暂无打开的克隆会话</div>
          )
        ) : sel.kind === 'assistant' ? (
          <AssistantPanel
            key={sel.navKey}
            sessionId={sel.sessionId}
            searchTarget={sel.searchTarget}
            chatModels={flatModels.chat}
            onBack={openAssistantDraft}
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
            searchTarget={sel.searchTarget}
            selfUin={selfProfile.data?.uin}
            personaList={personaList}
            profileByUid={profileByUid}
            faceDescToId={faceDescToId}
            onBack={() => {
              setSel({ kind: 'home' });
              if (embedded) onBackToDirectory?.();
            }}
            onDeleted={() => {
              setSel({ kind: 'home' });
              if (embedded) onBackToDirectory?.();
            }}
            onOpenPersonaSettings={(personaId) => {
              setMemberSettingsId(personaId);
              setSettingsOpen(true);
            }}
            personaSettingsOpen={settingsOpen && !!memberSettingsId}
          />
        ) : sel.kind === 'persona' && activePersona ? (
          <CloneChatPanel
            key={sel.navKey}
            personaId={sel.id}
            persona={activePersona}
            sessionId={sel.sessionId}
            searchTarget={sel.searchTarget}
            selfUin={selfProfile.data?.uin}
            clonedUin={clonedProfile?.uin || activePersona.sourceUin}
            faces={cloneFaces}
            modelLabel={personaModelLabel}
            onBack={() => {
              setSel({ kind: 'home' });
              if (embedded) onBackToDirectory?.();
            }}
            onOpenSettings={() => {
              setMemberSettingsId(null);
              setSettingsOpen(true);
            }}
          />
        ) : (
          <div className="weq-agentlab-chat">
            <div className="weq-agentlab-empty" role="status">
              <LoadingIndicator />
            </div>
          </div>
        )}
      </section>

      {cloneOpen ? (
        <NewCloneModal
          buddies={buddyOptions}
          initialSelectedUids={clonePreselect}
          flatModels={flatModels}
          onClose={() => setCloneOpen(false)}
          onStart={(args) => void startClone(args)}
        />
      ) : null}

      {groupOpen ? (
        <NewGroupModal
          personas={groupPersonaOptions}
          creating={createGroup.isLoading}
          onClose={() => setGroupOpen(false)}
          onCreate={(args) => void onCreateGroup(args)}
        />
      ) : null}

      {settingsOpen && settingsPersona ? (
        <PersonaSettingsModal
          key={settingsPersona.id}
          persona={settingsPersona}
          fromGroup={!!memberSettingsId}
          onDelete={() => void onDeletePersona()}
          deleting={deletePersona.isLoading}
          replyContent={
            <CloneGenerationPanel
              key={settingsPersona.id}
              persona={settingsPersona}
              onSaved={() => {
                void utils.account.listAgentLabPersonas.invalidate();
                void utils.account.getAgentLabPersonaDetail.invalidate();
              }}
            />
          }
          profileContent={
            <>
              <Row label="训练检索模型">
                {selectionLabel(settingsPersona.models?.embedding, '未使用')}
              </Row>
              <Row label="训练视觉模型">
                {selectionLabel(settingsPersona.models?.vision, '未使用')}
              </Row>
              <PersonaParamsPanel
                loading={personaDetail.isLoading}
                detail={personaDetail.data ?? null}
              />
            </>
          }
          onClose={() => {
            setSettingsOpen(false);
            setMemberSettingsId(null);
          }}
          onSaved={() => {
            void utils.account.listAgentLabPersonas.invalidate();
            void utils.account.getAgentLabPersonaDetail.invalidate();
          }}
        />
      ) : null}
    </div>
  );
}

/** 会话列表里的相对时间（粗粒度，够用即可）。 */
function relTime(ts: number): string {
  return timeFormat.formatRelativeTime(ts);
}
