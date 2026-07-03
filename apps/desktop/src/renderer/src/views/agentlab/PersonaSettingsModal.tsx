/**
 * 克隆体顶部设置灯箱：5 个分页
 *   ① 训练参数（由调用方传入已渲染好的参数面板）
 *   ② 自定义额外提示（编辑 customPrompt → updateAgentLabPersona）
 *   ③ 语音克隆开关（voiceCloneEnabled；真正的语音克隆是应用层未来能力）
 *   ④ 对自己的记忆 / 画像（占位，依赖后端记忆机制）
 *   ⑤ 导出好友（占位，依赖 AI tool 导出能力）
 */

import { useState, type ReactElement, type ReactNode } from 'react';
import {
  BarChart3,
  Download,
  FileText,
  Mic,
  Settings,
  Brain,
  Gauge,
  X,
  Plug,
  Link2,
  KeyRound,
  UserRound,
  AudioLines,
  Users,
} from 'lucide-react';
import { Modal } from '../../components/Dialog';
import { trpc } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';

/** ④ 记忆 / 画像：克隆体「对你」记住的事（来自聊天蒸馏），可单条遗忘 / 全部清空。 */
function MemoryTab({ personaId }: { personaId: string }): ReactElement {
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const memories = trpc.account.getAgentLabMemories.useQuery({ personaId });
  const forget = trpc.account.forgetAgentLabMemory.useMutation();
  const clearAll = trpc.account.clearAgentLabMemories.useMutation();

  async function onForget(memoryId: string): Promise<void> {
    await forget.mutateAsync({ personaId, memoryId });
    await utils.account.getAgentLabMemories.invalidate({ personaId });
  }

  async function onClear(): Promise<void> {
    const ok = await dialog.confirm('清空记忆', '确认清空这个克隆体对你的全部记忆？', {
      okLabel: '清空',
      cancelLabel: '返回',
      tone: 'warning',
    });
    if (!ok) return;
    await clearAll.mutateAsync({ personaId });
    await utils.account.getAgentLabMemories.invalidate({ personaId });
  }

  const list = memories.data ?? [];
  return (
    <div className="weq-persona-form">
      <p className="weq-persona-note">
        克隆体一边和你聊一边会记住关于「你」的事（近况、喜好、约定等），下次聊天自然带上。常被想起的记忆更不易遗忘。
      </p>
      {list.length === 0 ? (
        <div className="weq-persona-soon" style={{ padding: '24px 0' }}>
          <Brain size={26} strokeWidth={1.4} />
          <p>还没有记忆。多聊几轮，TA 就会记住你了。</p>
        </div>
      ) : (
        <ul className="weq-persona-memlist">
          {list.map((m) => (
            <li key={m.id}>
              <span className="weq-persona-memtext">{m.text}</span>
              <button type="button" className="weq-persona-memforget" title="忘掉这条" onClick={() => void onForget(m.id)}>
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {list.length > 0 && (
        <div className="weq-clone-actions">
          <button className="weq-set-btn weq-set-btn-soft weq-set-btn-sm" onClick={() => void onClear()}>
            清空全部记忆
          </button>
        </div>
      )}
    </div>
  );
}

type Tab = 'params' | 'prompt' | 'willing' | 'voice' | 'memory' | 'export';

const TABS: Array<{ id: Tab; label: string; icon: ReactElement }> = [
  { id: 'params', label: '训练参数', icon: <BarChart3 size={15} /> },
  { id: 'prompt', label: '额外提示', icon: <FileText size={15} /> },
  { id: 'willing', label: '发言意愿', icon: <Gauge size={15} /> },
  { id: 'voice', label: '语音克隆', icon: <Mic size={15} /> },
  { id: 'memory', label: '记忆 / 画像', icon: <Brain size={15} /> },
  { id: 'export', label: '导出好友', icon: <Download size={15} /> },
];

type WillingCfg = { gatePrivate?: boolean; level?: number; mustReplyOnMention?: boolean };

/** 发言意愿：总体意愿档位 + 是否对私聊生效 + 被 @ 是否必回。 */
function WillingTab({
  persona,
  onSaved,
}: {
  persona: { id: string; willing?: WillingCfg };
  onSaved: () => void;
}): ReactElement {
  const dialog = useAppDialog();
  const update = trpc.account.updateAgentLabPersona.useMutation();
  const [level, setLevel] = useState(persona.willing?.level ?? 50);
  const [mustReply, setMustReply] = useState(persona.willing?.mustReplyOnMention !== false);
  const [gatePrivate, setGatePrivate] = useState(!!persona.willing?.gatePrivate);
  const [saving, setSaving] = useState(false);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      await update.mutateAsync({
        personaId: persona.id,
        willing: { level, mustReplyOnMention: mustReply, gatePrivate },
      });
      dialog.success('已保存', '发言意愿已更新');
      onSaved();
    } catch (e) {
      dialog.error('保存失败', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const levelHint = level >= 70 ? '话痨，很爱接话' : level <= 30 ? '高冷，多数时候潜水' : '看心情和话题';

  return (
    <div className="weq-persona-form">
      <p className="weq-persona-note">
        控制这个克隆体多爱说话。群聊里始终按意愿决定要不要接话；私聊默认必回，可在下方开启「私聊也按意愿」。
      </p>
      <label className="weq-agentlab-field">
        <span>总体发言意愿：{level} · {levelHint}</span>
        <input type="range" min={0} max={100} step={5} value={level} onChange={(e) => setLevel(Number(e.target.value))} />
      </label>
      <label className="weq-clone-check">
        <input type="checkbox" checked={mustReply} onChange={(e) => setMustReply(e.target.checked)} />
        <span>被 @ 时必定回复（关掉后被 @ 也可能不接）</span>
      </label>
      <label className="weq-clone-check">
        <input type="checkbox" checked={gatePrivate} onChange={(e) => setGatePrivate(e.target.checked)} />
        <span>私聊也按意愿（开启后 1:1 私聊里 TA 也可能懒得回你）</span>
      </label>
      <div className="weq-clone-actions">
        <button className="weq-set-btn" disabled={saving} onClick={() => void save()}>
          保存
        </button>
      </div>
    </div>
  );
}

type VoiceBinding = { providerId: string; mode: 'clone' | 'preset'; voice?: string };

/** ③ 语音克隆：门控（TA 发过语音 + 配了 TTS）+ 服务商/音色方式选择。 */
function VoiceTab({
  persona,
  onSaved,
}: {
  persona: {
    id: string;
    voiceCloneEnabled?: boolean;
    voice?: VoiceBinding;
    voiceProfile?: { ratio: number; refClips?: unknown[] };
  };
  onSaved: () => void;
}): ReactElement {
  const dialog = useAppDialog();
  const update = trpc.account.updateAgentLabPersona.useMutation();
  const providers = trpc.bootstrap.listTtsProviders.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const catalog = trpc.bootstrap.getTtsCatalog.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  const providerList = providers.data ?? [];
  const hasVoiceMsgs = (persona.voiceProfile?.ratio ?? 0) > 0 || (persona.voiceProfile?.refClips?.length ?? 0) > 0;
  const hasRefClips = (persona.voiceProfile?.refClips?.length ?? 0) > 0;
  const hasTts = providerList.length > 0;
  const canEnable = hasVoiceMsgs && hasTts;

  const [enabled, setEnabled] = useState(!!persona.voiceCloneEnabled);
  const [providerId, setProviderId] = useState(persona.voice?.providerId ?? '');
  const [mode, setMode] = useState<'clone' | 'preset'>(persona.voice?.mode ?? 'clone');
  const [voice, setVoice] = useState(persona.voice?.voice ?? '');
  const [saving, setSaving] = useState(false);

  const currentProvider = providerList.find((p) => p.id === providerId) ?? providerList[0];
  const caps = catalog.data?.find((c) => c.vendor === currentProvider?.vendor)?.capabilities;
  const cloneOk = !!caps?.clone && hasRefClips;
  const effMode: 'clone' | 'preset' = mode === 'clone' && !cloneOk ? 'preset' : mode;

  async function save(nextEnabled: boolean): Promise<void> {
    setSaving(true);
    try {
      const binding: VoiceBinding | null =
        nextEnabled && currentProvider
          ? {
              providerId: currentProvider.id,
              mode: effMode,
              voice: effMode === 'preset' ? voice.trim() || undefined : undefined,
            }
          : (persona.voice ?? null);
      await update.mutateAsync({ personaId: persona.id, voiceCloneEnabled: nextEnabled, voice: binding });
      onSaved();
    } catch (e) {
      dialog.error('保存失败', e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setSaving(false);
    }
  }

  async function onToggle(next: boolean): Promise<void> {
    setEnabled(next);
    try {
      await save(next);
    } catch {
      setEnabled(!next);
    }
  }

  return (
    <div className="weq-persona-form">
      <label className="weq-clone-check">
        <input
          type="checkbox"
          checked={enabled && canEnable}
          disabled={!canEnable}
          onChange={(e) => void onToggle(e.target.checked)}
        />
        <span>开启语音克隆</span>
      </label>

      {!hasVoiceMsgs ? (
        <p className="weq-persona-note">TA 在聊天里没有发过语音，无法做语音克隆。</p>
      ) : !hasTts ? (
        <p className="weq-persona-note">
          还没有 TTS 服务商。请先到「设置 → 语音配置」添加一个（推荐 CosyVoice：可复刻、免费）。
        </p>
      ) : (
        <p className="weq-persona-note">
          开启后，克隆体会像真人一样自主决定某些消息用语音发。
          {hasRefClips
            ? '「用 TA 的声音」会拿 TA 的真实语音做参考音频复刻。'
            : '（没采集到可用的参考音频，只能用预置音色。）'}
        </p>
      )}

      {enabled && canEnable ? (
        <>
          <label className="weq-agentlab-field">
            <span>TTS 服务商</span>
            <select className="weq-set-input" value={currentProvider?.id ?? ''} onChange={(e) => setProviderId(e.target.value)}>
              {providerList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="weq-agentlab-field">
            <span>音色方式</span>
            <select className="weq-set-input" value={effMode} onChange={(e) => setMode(e.target.value as 'clone' | 'preset')}>
              <option value="clone" disabled={!cloneOk}>
                用 TA 的声音（复刻）{cloneOk ? '' : '（不支持 / 无参考音频）'}
              </option>
              <option value="preset">预置音色</option>
            </select>
          </label>
          {effMode === 'preset' ? (
            <label className="weq-agentlab-field">
              <span>音色 id</span>
              <input
                className="weq-set-input"
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                placeholder={currentProvider?.voice || '留空用服务商默认音色'}
              />
            </label>
          ) : null}
          <div className="weq-clone-actions">
            <button className="weq-set-btn" disabled={saving} onClick={() => void save(true)}>
              保存语音设置
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** 「导出好友」页：填 napcat/snowluma 连接信息，把克隆体导出成独立 bot 产物。 */
function ExportTab({
  persona,
}: {
  persona: { id: string; name: string; voiceCloneEnabled?: boolean };
}): ReactElement {
  const dialog = useAppDialog();
  const exportMut = trpc.account.exportAgentLabPersona.useMutation();
  const [adapterType, setAdapterType] = useState<'napcat' | 'snowluma'>('napcat');
  const [wsUrl, setWsUrl] = useState('ws://127.0.0.1:8081');
  const [token, setToken] = useState('');
  const [selfId, setSelfId] = useState('');
  const [voice, setVoice] = useState(!!persona.voiceCloneEnabled);
  const [groupChat, setGroupChat] = useState(false);

  async function doExport(): Promise<void> {
    if (!wsUrl.trim()) {
      dialog.error('缺少信息', '请填写 WebSocket 地址');
      return;
    }
    if (!selfId.trim()) {
      dialog.error('缺少信息', '请填写 bot 的 QQ 号');
      return;
    }
    try {
      const r = await exportMut.mutateAsync({
        personaId: persona.id,
        adapterType,
        wsUrl: wsUrl.trim(),
        token: token.trim() || undefined,
        selfId: selfId.trim(),
        voice,
        groupChat,
      });
      if (r.canceled) return;
      dialog.success(
        '导出成功',
        `已导出到：\n${r.outDir}\n\n表情 ${r.stickerCount} 张 / 语音参考 ${r.voiceClipCount} 条。\n进入该目录执行 npm install && npm start 即可让 bot 上线。`,
      );
    } catch (e) {
      dialog.error('导出失败', e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="weq-persona-form">
      <p className="weq-persona-note">
        把「{persona.name}」导出成独立机器人：连接 NapCat / SnowLuma 后即可作为真 QQ 机器人上线。导出的
        <code>config.json</code> 含 API Key，请妥善保管产物文件夹。
      </p>

      <label className="weq-agentlab-field">
        <span><Plug size={13} /> 适配器</span>
        <select value={adapterType} onChange={(e) => setAdapterType(e.target.value as 'napcat' | 'snowluma')}>
          <option value="napcat">NapCat</option>
          <option value="snowluma">SnowLuma</option>
        </select>
      </label>

      <label className="weq-agentlab-field">
        <span><Link2 size={13} /> WebSocket 地址</span>
        <input value={wsUrl} onChange={(e) => setWsUrl(e.target.value)} placeholder="ws://127.0.0.1:8081" />
      </label>

      <label className="weq-agentlab-field">
        <span><KeyRound size={13} /> 连接 Token（没有可留空）</span>
        <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Authorization 鉴权 token" />
      </label>

      <label className="weq-agentlab-field">
        <span><UserRound size={13} /> 机器人 QQ 号</span>
        <input value={selfId} onChange={(e) => setSelfId(e.target.value)} placeholder="机器人登录的 QQ 号" />
      </label>

      <label className="weq-clone-check">
        <input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
        <AudioLines size={14} />
        <span>允许发语音（需已开启语音克隆）</span>
      </label>

      <label className="weq-clone-check">
        <input type="checkbox" checked={groupChat} onChange={(e) => setGroupChat(e.target.checked)} />
        <Users size={14} />
        <span>参与群聊（被 @ 或聊到感兴趣的话题时才接话）</span>
      </label>

      <div className="weq-clone-actions">
        <button className="weq-set-btn" disabled={exportMut.isLoading} onClick={() => void doExport()}>
          {exportMut.isLoading ? '导出中…' : '导出机器人'}
        </button>
      </div>
    </div>
  );
}

export function PersonaSettingsModal({
  persona,
  paramsContent,
  onClose,
  onSaved,
}: {
  persona: {
    id: string;
    name: string;
    customPrompt?: string;
    voiceCloneEnabled?: boolean;
    voice?: VoiceBinding;
    voiceProfile?: { ratio: number; refClips?: unknown[] };
    willing?: WillingCfg;
  };
  paramsContent: ReactNode;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const dialog = useAppDialog();
  const update = trpc.account.updateAgentLabPersona.useMutation();
  const [tab, setTab] = useState<Tab>('params');
  const [prompt, setPrompt] = useState(persona.customPrompt ?? '');

  async function savePrompt(): Promise<void> {
    try {
      await update.mutateAsync({ personaId: persona.id, customPrompt: prompt });
      dialog.success('已保存', '额外提示已更新');
      onSaved();
    } catch (e) {
      dialog.error('保存失败', e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal onClose={onClose} width={640}>
      <div className="weq-persona-modal">
        <header className="weq-persona-modal-head">
          <Settings size={16} />
          <strong>{persona.name} · 设置</strong>
        </header>
        <div className="weq-persona-modal-body">
          <nav className="weq-persona-tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`weq-persona-tab${tab === t.id ? ' is-active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </nav>
          <div className="weq-persona-tabpane">
            {tab === 'params' ? (
              paramsContent
            ) : tab === 'prompt' ? (
              <div className="weq-persona-form">
                <label className="weq-agentlab-field">
                  <span>额外提示（拼进 system prompt，优先遵守）</span>
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={6}
                    placeholder="例如：这个克隆体说话更毒舌一点；少用句号"
                  />
                </label>
                <div className="weq-clone-actions">
                  <button className="weq-set-btn" disabled={update.isLoading} onClick={() => void savePrompt()}>
                    保存
                  </button>
                </div>
              </div>
            ) : tab === 'willing' ? (
              <WillingTab persona={persona} onSaved={onSaved} />
            ) : tab === 'voice' ? (
              <VoiceTab persona={persona} onSaved={onSaved} />
            ) : tab === 'memory' ? (
              <MemoryTab personaId={persona.id} />
            ) : (
              <ExportTab persona={persona} />
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
