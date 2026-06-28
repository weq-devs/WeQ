import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { Bot, BarChart3, MessageSquarePlus, Send, Sparkles, Trash2 } from 'lucide-react';
import { trpc } from '../trpc/client';
import { useAppDialog } from '../lib/dialogUtils';

interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

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
  if (!items.length) return <span style={{ opacity: 0.45 }}>—</span>;
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {items.map((item, index) => (
        <span
          key={`${item}-${index}`}
          style={{ padding: '1px 6px', borderRadius: 6, background: 'rgba(127,127,127,0.16)', fontSize: 12 }}
        >
          {item}
        </span>
      ))}
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: 8, alignItems: 'start', fontSize: 13 }}>
      <span style={{ opacity: 0.6 }}>{label}</span>
      <div style={{ minWidth: 0 }}>{children}</div>
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
    <div
      className="weq-agentlab-params"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '10px 14px',
        margin: '0 0 8px',
        borderRadius: 10,
        background: 'rgba(127,127,127,0.07)',
        maxHeight: 320,
        overflowY: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>画像参数</strong>
        <span
          style={{
            padding: '1px 8px',
            borderRadius: 6,
            fontSize: 12,
            background: profile.extractedByLlm ? 'rgba(46,160,67,0.2)' : 'rgba(219,154,4,0.2)',
          }}
        >
          {profile.extractedByLlm ? 'LLM 提炼' : '启发式兜底（未调用 LLM 或失败）'}
        </span>
      </div>

      {profile.extractError ? (
        <div style={{ fontSize: 12, color: '#d9534f' }}>提炼失败：{profile.extractError}</div>
      ) : null}

      <Row label="统计">
        <span style={{ fontSize: 12, opacity: 0.85 }}>
          源消息 {stats.sourceMessageCount} · 对方 {stats.friendMessageCount} · 轮次 {stats.turnCount} · 问答对{' '}
          {stats.pairCount} · 均字 {stats.avgFriendMsgChars} · 连发 {stats.avgFriendBurst} · 语料{' '}
          {stats.corpusChars} 字
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
          <span style={{ opacity: 0.45 }}>—</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {stickers.map((s, index) => (
              <span key={`sticker-${index}`} style={{ fontSize: 12, opacity: 0.85 }}>
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

      <details>
        <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.7 }}>
          代表样本 {fewShots.length} 组 / 真实问答对抽样 {detail.pairs.length} 条
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
          {fewShots.map((pair, index) => (
            <div key={`fs-${index}`} style={{ fontSize: 12, lineHeight: 1.5 }}>
              <div style={{ opacity: 0.6 }}>我：{pair.prompt}</div>
              <div>{detail.persona.name}：{pair.reply}</div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function randomPersonaId(targetUid: string): string {
  return `persona-${targetUid}-${Date.now()}`;
}

export function AgentLabView(): ReactElement {
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const providers = trpc.bootstrap.listAgentLabProviders.useQuery();
  const buddies = trpc.account.listBuddies.useQuery({ limit: 300, offset: 0 });
  const buddyUids = useMemo(
    () => (buddies.data ?? []).map((item) => item.uid).filter(Boolean),
    [buddies.data],
  );
  const profiles = trpc.account.getProfilesByUids.useQuery(
    { uids: buddyUids.slice(0, 200) },
    {
      enabled: buddyUids.length > 0,
    },
  );
  const personas = trpc.account.listAgentLabPersonas.useQuery();
  const build = trpc.account.buildAgentLabFromC2c.useMutation();
  const chat = trpc.account.chatWithAgentLabPersona.useMutation();
  const deletePersona = trpc.account.deleteAgentLabPersona.useMutation();

  const [targetUid, setTargetUid] = useState('');
  const [personaId, setPersonaId] = useState('');
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [profileNames, setProfileNames] = useState<Record<string, string>>({});
  const [showParams, setShowParams] = useState(false);
  const [cloneName, setCloneName] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [chatSel, setChatSel] = useState('');
  const [embSel, setEmbSel] = useState('');
  const [visSel, setVisSel] = useState('');

  const personaDetail = trpc.account.getAgentLabPersonaDetail.useQuery(
    { personaId },
    { enabled: showParams && !!personaId },
  );

  // 把所有 provider 里具备某能力的模型摊平成 "providerId::model" 选项。
  const flatModels = useMemo(() => {
    const build = (cap: 'chat' | 'embedding' | 'vision') =>
      (providers.data ?? []).flatMap((p) =>
        p.models
          .filter((m) => m.capabilities.includes(cap))
          .map((m) => ({ key: `${p.id}::${m.id}`, providerId: p.id, model: m.id, label: `${p.name} · ${m.label ?? m.id}` })),
      );
    return { chat: build('chat'), embedding: build('embedding'), vision: build('vision') };
  }, [providers.data]);

  useEffect(() => {
    const first = flatModels.chat[0];
    if (!chatSel && first) setChatSel(first.key);
  }, [flatModels.chat, chatSel]);

  useEffect(() => {
    const first = personas.data?.[0];
    if (!personaId && first) setPersonaId(first.id);
  }, [personas.data, personaId]);

  useEffect(() => {
    const rows = profiles.data;
    if (!rows?.length) return;
    const next: Record<string, string> = {};
    for (const row of rows) next[row.uid] = row.remark || row.nick || row.uin || row.uid;
    setProfileNames(next);
  }, [profiles.data]);

  const buddyOptions = useMemo(
    () =>
      (buddies.data ?? []).map((item) => ({
        uid: item.uid,
        label: profileNames[item.uid] || item.uin || item.uid,
      })),
    [buddies.data, profileNames],
  );

  const activePersona = personas.data?.find((item) => item.id === personaId) ?? null;

  function parseSel(key: string): { providerId: string; model: string } | undefined {
    const [providerId, model] = key.split('::');
    return providerId && model ? { providerId, model } : undefined;
  }

  async function onBuild(): Promise<void> {
    const chatRef = parseSel(chatSel);
    if (!chatRef || !targetUid) {
      dialog.error('无法构建', '请先选择聊天模型和好友。');
      return;
    }
    const label = buddyOptions.find((item) => item.uid === targetUid)?.label;
    const embRef = parseSel(embSel);
    const visRef = parseSel(visSel);
    try {
      const persona = await build.mutateAsync({
        personaId: randomPersonaId(targetUid),
        name: cloneName.trim() || undefined,
        models: {
          chat: chatRef,
          ...(embRef ? { embedding: embRef } : {}),
          ...(visRef ? { vision: visRef } : {}),
        },
        customPrompt: customPrompt.trim() || undefined,
        targetUid,
        title: label,
      });
      setPersonaId(persona.id);
      setHistory([]);
      await utils.account.listAgentLabPersonas.invalidate();
    } catch (error) {
      dialog.error('构建 persona 失败', error instanceof Error ? error.message : String(error));
    }
  }

  async function onSend(): Promise<void> {
    if (!personaId || !input.trim()) return;
    const text = input.trim();
    setInput('');
    const nextHistory = [...history, { role: 'user' as const, text }];
    setHistory(nextHistory);
    try {
      const result = await chat.mutateAsync({ personaId, text, history });
      setHistory([...nextHistory, { role: 'assistant', text: result.text }]);
    } catch (error) {
      dialog.error('发送失败', error instanceof Error ? error.message : String(error));
      setHistory(history);
      setInput(text);
    }
  }

  async function onDeletePersona(): Promise<void> {
    if (!personaId) return;
    const ok = await dialog.confirm('删除 persona', '确认删除当前克隆？', {
      okLabel: '删除',
      cancelLabel: '返回',
      tone: 'warning',
    });
    if (!ok) return;
    try {
      await deletePersona.mutateAsync({ personaId });
      setPersonaId('');
      setHistory([]);
      await utils.account.listAgentLabPersonas.invalidate();
    } catch (error) {
      dialog.error('删除失败', error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="weq-agentlab-view">
      <section className="weq-agentlab-panel weq-agentlab-builder">
        <header className="weq-agentlab-head">
          <div>
            <strong>AgentLab</strong>
            <span>好友克隆实验页。前端先保持简单，重点是把后端链路打通。</span>
          </div>
          <Sparkles size={18} />
        </header>
        <div className="weq-agentlab-grid">
          <label className="weq-agentlab-field">
            <span>克隆对象</span>
            <select value={targetUid} onChange={(e) => setTargetUid(e.target.value)}>
              <option value="">请选择好友</option>
              {buddyOptions.map((item) => (
                <option key={item.uid} value={item.uid}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="weq-agentlab-field">
            <span>克隆体名称（可选，默认用好友昵称）</span>
            <input value={cloneName} onChange={(e) => setCloneName(e.target.value)} placeholder="给这个克隆体起个名" />
          </label>
          <label className="weq-agentlab-field">
            <span>聊天模型</span>
            <select value={chatSel} onChange={(e) => setChatSel(e.target.value)}>
              <option value="">请选择聊天模型</option>
              {flatModels.chat.map((m) => (
                <option key={m.key} value={m.key}>{m.label}</option>
              ))}
            </select>
          </label>
          <label className="weq-agentlab-field">
            <span>向量模型（可选，配了才做相似检索）</span>
            <select value={embSel} onChange={(e) => setEmbSel(e.target.value)}>
              <option value="">不使用向量</option>
              {flatModels.embedding.map((m) => (
                <option key={m.key} value={m.key}>{m.label}</option>
              ))}
            </select>
          </label>
          <label className="weq-agentlab-field">
            <span>视觉模型（可选，配了才解读表情包）</span>
            <select value={visSel} onChange={(e) => setVisSel(e.target.value)}>
              <option value="">不解读表情包</option>
              {flatModels.vision.map((m) => (
                <option key={m.key} value={m.key}>{m.label}</option>
              ))}
            </select>
          </label>
        </div>
        {flatModels.chat.length === 0 ? (
          <div className="weq-agentlab-empty" style={{ margin: '4px 0' }}>
            还没有可用的聊天模型，请先到「设置 → 模型服务商」添加 provider 和模型。
          </div>
        ) : null}
        <label className="weq-agentlab-field" style={{ display: 'block', marginTop: 6 }}>
          <span>自定义提示（可选，拼进 system prompt）</span>
          <textarea
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder="例如：这个克隆体说话更毒舌一点"
            rows={2}
            style={{ width: '100%', resize: 'vertical' }}
          />
        </label>
        <div className="weq-agentlab-actions">
          <button type="button" className="weq-set-btn" onClick={() => void onBuild()} disabled={build.isLoading}>
            <MessageSquarePlus size={14} />
            {build.isLoading ? '构建中...' : '构建克隆'}
          </button>
        </div>
        <div className="weq-agentlab-personas">
          {(personas.data ?? []).map((item) => (
            <button
              key={item.id}
              type="button"
              className={`weq-agentlab-persona${personaId === item.id ? ' is-active' : ''}`}
              onClick={() => {
                setPersonaId(item.id);
                setHistory([]);
              }}
            >
              <span>{item.name}</span>
              <small>{item.sourceTitle}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="weq-agentlab-panel weq-agentlab-chat">
        <header className="weq-agentlab-head">
          <div>
            <strong>{activePersona?.name ?? '未选择 persona'}</strong>
            <span>
              {activePersona
                ? `${activePersona.models?.chat?.model ?? '旧版克隆，请重建'} · 样本 ${activePersona.corpusMessageCount} 条`
                : '先在左侧构建或选择一个克隆。'}
            </span>
          </div>
          <div className="weq-agentlab-head-actions">
            <Bot size={18} />
            <button
              type="button"
              className={`weq-set-btn weq-set-btn-soft weq-set-btn-sm${showParams ? ' is-active' : ''}`}
              disabled={!activePersona}
              onClick={() => setShowParams((v) => !v)}
            >
              <BarChart3 size={12} />
              {showParams ? '隐藏参数' : '查看参数'}
            </button>
            <button type="button" className="weq-set-btn weq-set-btn-soft weq-set-btn-sm" disabled={!activePersona} onClick={() => void onDeletePersona()}>
              <Trash2 size={12} />
              删除
            </button>
          </div>
        </header>

        {showParams && activePersona ? (
          <PersonaParamsPanel
            loading={personaDetail.isLoading}
            detail={personaDetail.data ?? null}
          />
        ) : null}
        <div className="weq-agentlab-transcript">
          {history.length === 0 ? (
            <div className="weq-agentlab-empty">这里会显示你和克隆体的测试对话。</div>
          ) : (
            history.map((item, index) => (
              <div key={`${item.role}-${index}`} className={`weq-agentlab-msg is-${item.role}`}>
                <span className="weq-agentlab-msg-role">{item.role === 'user' ? '你' : activePersona?.name ?? '克隆体'}</span>
                <p>{item.text}</p>
              </div>
            ))
          )}
        </div>
        <div className="weq-agentlab-composer">
          <textarea value={input} onChange={(e) => setInput(e.target.value)} placeholder="输入一句话测试克隆效果" disabled={!activePersona || chat.isLoading} />
          <button type="button" className="weq-set-btn" onClick={() => void onSend()} disabled={!activePersona || chat.isLoading || !input.trim()}>
            <Send size={14} />
            发送
          </button>
        </div>
      </section>
    </div>
  );
}
