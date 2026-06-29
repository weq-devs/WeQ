import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { ArrowLeft, Plus, Send, Settings, Sparkles, Trash2 } from 'lucide-react';
import { trpc } from '../trpc/client';
import { useAppDialog } from '../lib/dialogUtils';
import { autoGrowTextarea } from '../lib/textareaAutoGrow';
import { QqAvatar } from '../components/QqAvatar';
import { NewCloneModal, type BuddyOption, type FlatModels } from './agentlab/NewCloneModal';
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

type Selection = { kind: 'home' } | { kind: 'assistant' } | { kind: 'persona'; id: string };

export function AgentLabView(): ReactElement {
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const providers = trpc.bootstrap.listAgentLabProviders.useQuery();
  const buddies = trpc.account.listBuddies.useQuery({ limit: 300, offset: 0 });
  const personas = trpc.account.listAgentLabPersonas.useQuery();
  const chat = trpc.account.chatWithAgentLabPersona.useMutation();
  const deletePersona = trpc.account.deleteAgentLabPersona.useMutation();
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
  const [cloneOpen, setCloneOpen] = useState(false);
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cloneTyping, setCloneTyping] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

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

  // 切到某克隆体时，从持久化对话恢复历史（每个 persona 只 seed 一次）。
  useEffect(() => {
    if (personaId && personaConv.data && seededPersona.current !== personaId) {
      setHistory(personaConv.data.map((t) => ({ role: t.role, text: t.text })));
      seededPersona.current = personaId;
    }
  }, [personaId, personaConv.data]);

  // 选中的 persona 被删除时回退到主页。
  useEffect(() => {
    if (sel.kind === 'persona' && personas.data && !personaList.some((p) => p.id === sel.id)) {
      setSel({ kind: 'home' });
    }
  }, [sel, personas.data, personaList]);

  function selectPersona(id: string): void {
    setSel({ kind: 'persona', id });
    setHistory([]);
    setSettingsOpen(false);
    seededPersona.current = ''; // 强制从持久化对话重新 seed
    // 切入时拉一次最新持久化历史，避免命中陈旧缓存（实时查询历史）。
    void utils.account.getAgentLabConversation.invalidate({ personaId: id });
  }

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
      const segments = result.segments?.length ? result.segments : [result.text];
      setCloneTyping(true);
      await sleep(Math.min(1800, result.replyDelayMs ?? 500));
      let acc = nextHistory;
      for (let i = 0; i < segments.length; i += 1) {
        const seg = segments[i]!;
        acc = [...acc, { role: 'assistant' as const, text: seg }];
        setHistory(acc);
        if (i < segments.length - 1) {
          setCloneTyping(true);
          await sleep(Math.min(1600, 320 + seg.length * 55));
        }
      }
      setCloneTyping(false);
      // 让持久化对话缓存跟上（后端已逐条落库）；否则切走再切回会从陈旧缓存 reseed 丢消息。
      seededPersona.current = personaId; // 防止下面的失效触发 reseed 清掉刚揭示的本地历史
      void utils.account.getAgentLabConversation.invalidate({ personaId });
    } catch (error) {
      setCloneTyping(false);
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
        <div className="weq-agentlab-list-head">AgentLab</div>
        <button
          className={`weq-agentlab-item${sel.kind === 'assistant' ? ' is-active' : ''}`}
          onClick={() => setSel({ kind: 'assistant' })}
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

        <button className="weq-agentlab-newclone" onClick={() => setCloneOpen(true)}>
          <Plus size={15} /> 新建克隆
        </button>
      </aside>

      {/* 右侧主区 */}
      <section className="weq-agentlab-main">
        {sel.kind === 'home' ? (
          <UsagePanel
            resolveName={(id) => personaList.find((p) => p.id === id)?.name ?? '已删除的克隆'}
            personaCount={personaList.length}
          />
        ) : sel.kind === 'assistant' ? (
          <AssistantPanel chatModels={flatModels.chat} onBack={() => setSel({ kind: 'home' })} />
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

            <div className="weq-agentlab-transcript">
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
                    />
                  ),
                )
              )}
              {(cloneTyping || chat.isLoading) && (
                <div className="weq-agentlab-typing">
                  <span /><span /><span />
                </div>
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
          onBuilt={async (id) => {
            setCloneOpen(false);
            await utils.account.listAgentLabPersonas.invalidate();
            selectPersona(id);
          }}
        />
      ) : null}

      {settingsOpen && activePersona ? (
        <PersonaSettingsModal
          persona={{
            id: activePersona.id,
            name: activePersona.name,
            customPrompt: activePersona.customPrompt,
            voiceCloneEnabled: activePersona.voiceCloneEnabled,
          }}
          paramsContent={<PersonaParamsPanel loading={personaDetail.isLoading} detail={personaDetail.data ?? null} />}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => void utils.account.listAgentLabPersonas.invalidate()}
        />
      ) : null}
    </div>
  );
}

