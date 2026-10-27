/** 克隆体设置：配置统一保存，即时管理操作与配置分开。 */

import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { CloneUpdateButton } from './CloneUpdateButton';
import '../../styles/persona-settings.css';
import type { AgentLabModelSelection } from '@weq/agentlab';
import { ApiModelSelect } from '../../components/settings/ApiModelSelect';
import { TabActivity, useTabActive } from '../../components/RetainedTabs';
import { DraftCloseContext, useDraftClose, useDraftProtection } from '../../lib/draftClose';
import {
  Download,
  Mic,
  Save,
  Trash2,
  Brain,
  Gauge,
  X,
  Plug,
  Link2,
  KeyRound,
  UserRound,
  AudioLines,
  Users,
  Globe,
  ChevronDown,
  ExternalLink,
  Copy,
  Eye,
  EyeOff,
  Info,
  Image as ImageIcon,
  Settings2,
} from 'lucide-react';
import { ConversationSettingsFrame } from '../../components/ConversationSettingsFrame';
import {
  CloneSettingsDraftContext,
  useCloneSettingsDraft,
  useCloneSettingsSection,
} from './cloneSettingsDraft';
import { trpc } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';

/** ④ 记忆 / 画像：克隆体「对你」记住的事（来自聊天蒸馏），可单条遗忘 / 全部清空。 */
function MemoryTab({ personaId }: { personaId: string }): ReactElement {
  const active = useTabActive();
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const memories = trpc.account.getAgentLabMemories.useQuery({ personaId }, { enabled: active });
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
        遗忘和清空立即生效，不随配置保存。
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
              <button
                type="button"
                className="weq-persona-memforget"
                title="忘掉这条"
                onClick={() => void onForget(m.id)}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {list.length > 0 && (
        <div className="weq-clone-actions">
          <button
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            onClick={() => void onClear()}
          >
            <Trash2 size={13} aria-hidden="true" />
            清空全部记忆
          </button>
        </div>
      )}
    </div>
  );
}

type Tab = 'profile' | 'reply' | 'voice' | 'memory' | 'export' | 'management';

const TABS: Array<{ id: Tab; label: string; icon: ReactElement }> = [
  { id: 'profile', label: '人格与画像', icon: <UserRound size={15} /> },
  { id: 'reply', label: '回复设置', icon: <Gauge size={15} /> },
  { id: 'voice', label: '语音', icon: <Mic size={15} /> },
  { id: 'memory', label: '对我的记忆', icon: <Brain size={15} /> },
  { id: 'export', label: '导出与部署', icon: <Download size={15} /> },
  { id: 'management', label: '克隆体管理', icon: <Settings2 size={15} /> },
];

type WillingCfg = { gatePrivate?: boolean; level?: number; mustReplyOnMention?: boolean };
type TypoCfg = { enabled?: boolean; intensity?: number };

/** 错别字默认强度（与 packages/agentlab DEFAULT_TYPO_INTENSITY 保持一致）。 */
const DEFAULT_TYPO_INTENSITY = 0.1;

/** 发言意愿：总体意愿档位 + 是否对私聊生效 + 被 @ 是否必回；顺带管错别字（人味）后处理。 */
function WillingTab({
  persona,
}: {
  persona: { id: string; willing?: WillingCfg; typo?: TypoCfg };
}): ReactElement {
  const [level, setLevel] = useState(persona.willing?.level ?? 50);
  const [mustReply, setMustReply] = useState(persona.willing?.mustReplyOnMention !== false);
  const [gatePrivate, setGatePrivate] = useState(!!persona.willing?.gatePrivate);
  const [typoOn, setTypoOn] = useState(persona.typo?.enabled !== false);
  // 内部按百分比操作（0–30），存库时 /100 成 intensity。
  const [typoPct, setTypoPct] = useState(
    Math.round((persona.typo?.intensity ?? DEFAULT_TYPO_INTENSITY) * 100),
  );
  const willingDraft = { level, mustReply, gatePrivate, typoOn, typoPct };
  useCloneSettingsSection('willing', willingDraft, {
    willing: { level, mustReplyOnMention: mustReply, gatePrivate },
    typo: { enabled: typoOn, intensity: typoPct / 100 },
  });

  const levelHint =
    level >= 70 ? '话痨，很爱接话' : level <= 30 ? '高冷，多数时候潜水' : '看心情和话题';
  const typoHint = typoPct >= 20 ? '经常手滑' : typoPct <= 5 ? '几乎不出错' : '偶尔手滑';

  return (
    <div className="weq-persona-form">
      <p className="weq-persona-note">
        控制这个克隆体多爱说话。群聊里始终按意愿决定要不要接话；私聊默认必回，可在下方开启「私聊也按意愿」。
      </p>
      <label className="weq-agentlab-field">
        <span>
          总体发言意愿：{level} · {levelHint}
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={level}
          onChange={(e) => setLevel(Number(e.target.value))}
        />
      </label>
      <label className="weq-clone-check">
        <input
          type="checkbox"
          checked={mustReply}
          onChange={(e) => setMustReply(e.target.checked)}
        />
        <span>被 @ 时必定回复（关掉后被 @ 也可能不接）</span>
      </label>
      <label className="weq-clone-check">
        <input
          type="checkbox"
          checked={gatePrivate}
          onChange={(e) => setGatePrivate(e.target.checked)}
        />
        <span>私聊也按意愿（开启后 1:1 私聊里 TA 也可能懒得回你）</span>
      </label>

      <div className="weq-persona-divider" />
      <p className="weq-persona-note">
        错别字（人味）：偶尔把「在/再」这类同音字写错、吞掉句尾句号，削弱 AI
        感。嫌太频繁就调低频率或直接关掉。
      </p>
      <label className="weq-clone-check">
        <input type="checkbox" checked={typoOn} onChange={(e) => setTypoOn(e.target.checked)} />
        <span>允许模拟聊天中的偶发错别字</span>
      </label>
      {typoOn ? (
        <label className="weq-agentlab-field">
          <span>
            手滑频率：{typoPct}% · {typoHint}
          </span>
          <input
            type="range"
            min={0}
            max={30}
            step={1}
            value={typoPct}
            onChange={(e) => setTypoPct(Number(e.target.value))}
          />
        </label>
      ) : null}
    </div>
  );
}

type VoiceBinding = { providerId: string; mode: 'clone' | 'preset'; voice?: string };

/** ③ 语音克隆：门控（TA 发过语音 + 配了 TTS）+ 服务商/音色方式选择。 */
function VoiceTab({
  persona,
}: {
  persona: {
    id: string;
    voiceCloneEnabled?: boolean;
    voice?: VoiceBinding;
    voiceProfile?: { ratio: number; refClips?: unknown[] };
  };
}): ReactElement {
  const active = useTabActive();
  const providers = trpc.bootstrap.listTtsProviders.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const catalog = trpc.bootstrap.getTtsCatalog.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  const providerList = providers.data ?? [];
  const hasVoiceMsgs =
    (persona.voiceProfile?.ratio ?? 0) > 0 || (persona.voiceProfile?.refClips?.length ?? 0) > 0;
  const hasRefClips = (persona.voiceProfile?.refClips?.length ?? 0) > 0;
  const hasTts = providerList.length > 0;
  const canEnable = hasVoiceMsgs && hasTts;

  const [enabled, setEnabled] = useState(!!persona.voiceCloneEnabled);
  const [providerId, setProviderId] = useState(persona.voice?.providerId ?? '');
  const [mode, setMode] = useState<'clone' | 'preset'>(persona.voice?.mode ?? 'clone');
  const [voice, setVoice] = useState(persona.voice?.voice ?? '');
  const voiceDraft = { enabled, providerId, mode, voice };

  const currentProvider = providerList.find((p) => p.id === providerId) ?? providerList[0];
  const caps = catalog.data?.find((c) => c.vendor === currentProvider?.vendor)?.capabilities;
  const cloneOk = !!caps?.clone && hasRefClips;
  const effMode: 'clone' | 'preset' = mode === 'clone' && !cloneOk ? 'preset' : mode;

  const binding: VoiceBinding | null =
    enabled && currentProvider
      ? {
          providerId: currentProvider.id,
          mode: effMode,
          voice: effMode === 'preset' ? voice.trim() || undefined : undefined,
        }
      : (persona.voice ?? null);
  useCloneSettingsSection(
    'voice',
    voiceDraft,
    {
      voiceCloneEnabled: enabled,
      voice: binding,
    },
    !enabled || canEnable,
  );

  return (
    <div className="weq-persona-form">
      <label className="weq-clone-check">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!canEnable && !enabled}
          onChange={(e) => setEnabled(e.target.checked)}
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
            <select
              className="weq-set-input"
              value={currentProvider?.id ?? ''}
              onChange={(e) => setProviderId(e.target.value)}
            >
              {providerList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="weq-agentlab-field">
            <span>音色方式</span>
            <SegmentedControl
              label="音色方式"
              value={effMode}
              onChange={setMode}
              options={[
                {
                  value: 'clone',
                  label: '声音复刻',
                  disabled: !cloneOk,
                  title: cloneOk ? '用 TA 的声音' : '不支持或无参考音频',
                },
                { value: 'preset', label: '预置音色' },
              ]}
            />
            {!cloneOk && <small>声音复刻不可用：服务商不支持或没有可用的参考音频。</small>}
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
        </>
      ) : null}
    </div>
  );
}

/** 已导出记录卡片：查看 WebUI 密钥 + 一键打开控制台（连不上时提示输地址）。 */
function ExportRuntimeCard({ personaId }: { personaId: string }): ReactElement | null {
  const active = useTabActive();
  const dialog = useAppDialog();
  const info = trpc.account.getAgentLabExportInfo.useQuery({ personaId }, { enabled: active });
  const openMut = trpc.account.openBotWebUi.useMutation();
  const [showKey, setShowKey] = useState(false);
  const [urlInput, setUrlInput] = useState<string | null>(null);
  useEffect(() => {
    if (!active) setShowKey(false);
  }, [active]);

  const data = info.data;
  if (!data) return null;

  async function openConsole(url?: string): Promise<void> {
    try {
      const r = await openMut.mutateAsync({ personaId, url });
      if (r.needUrl) {
        setUrlInput(url ?? r.defaultUrl);
        dialog.error(
          '连不上控制台',
          '默认地址没响应。请确认 bot 已 npm start，或在下方填入实际访问地址后重试。',
        );
      } else if (r.opened) {
        setUrlInput(null);
      }
    } catch (e) {
      dialog.error('打开失败', e instanceof Error ? e.message : String(e));
    }
  }

  async function copyKey(): Promise<void> {
    try {
      await navigator.clipboard.writeText(data!.key);
      dialog.success('已复制', 'WebUI 密钥已复制到剪贴板');
    } catch {
      /* 剪贴板不可用则忽略 */
    }
  }

  const maskedKey = showKey
    ? data.key
    : `${data.key.slice(0, 6)}${'·'.repeat(12)}${data.key.slice(-4)}`;

  return (
    <div className="weq-bot-runtime">
      <div className="weq-bot-runtime-head">
        <Globe size={14} />
        <span>运行配置 · 已导出</span>
        <span className="weq-bot-runtime-port">端口 {data.port}</span>
      </div>
      <div className="weq-bot-keyrow">
        <KeyRound size={13} />
        <code className="weq-bot-key">{maskedKey}</code>
        <button
          type="button"
          className="weq-bot-iconbtn"
          title={showKey ? '隐藏' : '显示'}
          onClick={() => setShowKey((v) => !v)}
        >
          {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
        <button
          type="button"
          className="weq-bot-iconbtn"
          title="复制密钥"
          onClick={() => void copyKey()}
        >
          <Copy size={14} />
        </button>
      </div>
      {urlInput !== null ? (
        <div className="weq-bot-urlrow">
          <input
            className="weq-set-input"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="http://127.0.0.1:8090"
          />
          <button
            className="weq-set-btn weq-set-btn-sm"
            disabled={openMut.isLoading}
            onClick={() => void openConsole(urlInput)}
          >
            <Plug size={13} aria-hidden="true" />
            连接
          </button>
        </div>
      ) : null}
      <div className="weq-clone-actions">
        <button
          className="weq-set-btn"
          disabled={openMut.isLoading}
          onClick={() => void openConsole()}
        >
          <ExternalLink size={14} /> {openMut.isLoading ? '连接中…' : '打开控制台'}
        </button>
      </div>
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
  const utils = trpc.useUtils();
  const exportMut = trpc.account.exportAgentLabPersona.useMutation();
  const canVoice = !!persona.voiceCloneEnabled;
  const [introOpen, setIntroOpen] = useState(false);
  const [adapterType, setAdapterType] = useState<'napcat' | 'snowluma'>('napcat');
  const [wsUrl, setWsUrl] = useState('ws://127.0.0.1:8081');
  const [token, setToken] = useState('');
  const [selfId, setSelfId] = useState('');
  const [voice, setVoice] = useState(canVoice);
  const [groupChat, setGroupChat] = useState(false);
  const [groupReplyMode, setGroupReplyMode] = useState<'llm' | 'heuristic'>('llm');
  const [webuiPort, setWebuiPort] = useState('8090');
  // 图像模型（可选）：写进导出 persona 的 models.vision，供 bot 解析「WebUI 上传的新表情」。
  // 留「（不设置）」则沿用克隆时的 vision（若有）。
  const [visionModel, setVisionModel] = useState<AgentLabModelSelection | null>(null);
  const exportDraft = {
    adapterType,
    wsUrl,
    token,
    selfId,
    voice,
    groupChat,
    groupReplyMode,
    webuiPort,
    visionModel,
  };
  const guard = useDraftProtection(exportDraft, exportMut.isLoading);

  async function doExport(): Promise<void> {
    if (!wsUrl.trim()) {
      dialog.error('缺少信息', '请填写 WebSocket 地址');
      return;
    }
    if (!selfId.trim()) {
      dialog.error('缺少信息', '请填写 bot 的 QQ 号');
      return;
    }
    const portNum = Number(webuiPort.trim());
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      dialog.error('端口无效', 'WebUI 端口需为 1–65535 之间的整数');
      return;
    }
    try {
      const r = await exportMut.mutateAsync({
        personaId: persona.id,
        adapterType,
        wsUrl: wsUrl.trim(),
        token: token.trim() || undefined,
        selfId: selfId.trim(),
        voice: voice && canVoice,
        groupChat,
        groupReplyMode,
        webuiPort: portNum,
        visionModel: visionModel ?? undefined,
      });
      if (r.canceled) return;
      guard.reset(exportDraft);
      await utils.account.getAgentLabExportInfo.invalidate({ personaId: persona.id });
      dialog.success(
        '导出成功',
        `已导出到：\n${r.outDir}\n\n表情 ${r.stickerCount} 张 / 语音参考 ${r.voiceClipCount} 条。\n\n` +
          `WebUI 控制台：${r.webui.url}\n访问密钥：${r.webui.key}\n（请妥善保管，也可在下方「运行配置」或产物 README 里查看）\n\n` +
          `进入该目录执行 npm install && npm start 即可让 bot 上线。`,
      );
    } catch (e) {
      dialog.error('导出失败', e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="weq-persona-form">
      <div className="weq-collapse">
        <button type="button" className="weq-collapse-head" onClick={() => setIntroOpen((v) => !v)}>
          <Info size={13} />
          <span>使用说明</span>
          <ChevronDown size={14} className={`weq-collapse-chev${introOpen ? ' is-open' : ''}`} />
        </button>
        {introOpen ? (
          <p className="weq-persona-note weq-collapse-body">
            把「{persona.name}」导出成独立机器人：连接 NapCat / SnowLuma 后即可作为真 QQ
            机器人上线。导出时会自动生成 WebUI 控制台的访问密钥与编号（可查看 token
            消耗、收发统计与克隆体总览）。导出的
            <code>config.json</code> 含 API Key 与访问密钥，请妥善保管产物文件夹。
          </p>
        ) : null}
      </div>

      <ExportRuntimeCard personaId={persona.id} />

      <label className="weq-agentlab-field">
        <span>
          <Plug size={13} /> 适配器
        </span>
        <select
          value={adapterType}
          onChange={(e) => setAdapterType(e.target.value as 'napcat' | 'snowluma')}
        >
          <option value="napcat">NapCat</option>
          <option value="snowluma">SnowLuma</option>
        </select>
      </label>

      <label className="weq-agentlab-field">
        <span>
          <Link2 size={13} /> WebSocket 地址
        </span>
        <input
          value={wsUrl}
          onChange={(e) => setWsUrl(e.target.value)}
          placeholder="ws://127.0.0.1:8081"
        />
      </label>

      <label className="weq-agentlab-field">
        <span>
          <KeyRound size={13} /> 连接 Token（没有可留空）
        </span>
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Authorization 鉴权 token"
        />
      </label>

      <label className="weq-agentlab-field">
        <span>
          <UserRound size={13} /> 机器人 QQ 号
        </span>
        <input
          value={selfId}
          onChange={(e) => setSelfId(e.target.value)}
          placeholder="机器人登录的 QQ 号"
        />
      </label>

      <label className="weq-agentlab-field">
        <span>
          <Globe size={13} /> WebUI 控制台端口
        </span>
        <input
          value={webuiPort}
          onChange={(e) => setWebuiPort(e.target.value.replace(/[^\d]/g, ''))}
          placeholder="8090"
          inputMode="numeric"
        />
      </label>

      <label className="weq-agentlab-field">
        <span>
          <ImageIcon size={13} /> 图像模型（可选，解析上传的新表情）
        </span>
        <ApiModelSelect
          allowDefault
          label="导出图像模型"
          capability="vision"
          value={visionModel}
          onChange={setVisionModel}
          emptyLabel="（不设置 · 沿用克隆时的图像模型）"
        />
      </label>

      <label className={`weq-clone-check${canVoice ? '' : ' is-disabled'}`}>
        <input
          type="checkbox"
          checked={voice && canVoice}
          disabled={!canVoice}
          onChange={(e) => setVoice(e.target.checked)}
        />
        <AudioLines size={14} />
        <span>允许发语音{canVoice ? '' : '（需先在「语音克隆」页开启）'}</span>
      </label>

      <label className="weq-clone-check">
        <input
          type="checkbox"
          checked={groupChat}
          onChange={(e) => setGroupChat(e.target.checked)}
        />
        <Users size={14} />
        <span>参与群聊（被 @ 或聊到感兴趣的话题时才接话）</span>
      </label>

      {groupChat && (
        <label className="weq-agentlab-field">
          <span>群聊回复方式</span>
          <SegmentedControl
            label="群聊回复方式"
            value={groupReplyMode}
            onChange={setGroupReplyMode}
            options={[
              { value: 'llm', label: '拟人判断' },
              { value: 'heuristic', label: '启发式' },
            ]}
          />
          <small>
            {groupReplyMode === 'llm'
              ? '更自然，每条消息多一次 LLM 调用。'
              : '按 @、点名和关系打分，响应快、更省 token。'}
          </small>
        </label>
      )}

      <div className="weq-clone-actions">
        <button
          className="weq-set-btn"
          disabled={exportMut.isLoading}
          onClick={() => void doExport()}
        >
          <Download size={14} aria-hidden="true" />
          {exportMut.isLoading ? '导出中…' : '导出机器人'}
        </button>
      </div>
    </div>
  );
}

function ProfilePrompt({ initial }: { initial: string }) {
  const [prompt, setPrompt] = useState(initial);
  useCloneSettingsSection('prompt', prompt, { customPrompt: prompt });
  return (
    <label className="weq-agentlab-field">
      <span>额外提示</span>
      <textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        rows={6}
        placeholder="例如：这个克隆体说话更毒舌一点；少用句号"
      />
    </label>
  );
}

export function PersonaSettingsModal({
  persona,
  profileContent,
  replyContent,
  fromGroup = false,
  onClose,
  onSaved,
  onDelete,
  deleting = false,
}: {
  persona: {
    id: string;
    name: string;
    sourceKind?: 'c2c' | 'group';
    sourceUin?: string;
    training?: { mode: 'private' | 'group' };
    customPrompt?: string;
    voiceCloneEnabled?: boolean;
    voice?: VoiceBinding;
    voiceProfile?: { ratio: number; refClips?: unknown[] };
    willing?: WillingCfg;
    typo?: TypoCfg;
  };
  profileContent?: ReactNode;
  replyContent: ReactNode;
  fromGroup?: boolean;
  onClose: () => void;
  onSaved: () => void;
  onDelete?: () => void;
  deleting?: boolean;
}): ReactElement {
  const dialog = useAppDialog();
  const update = trpc.account.updateAgentLabPersona.useMutation();
  const [tab, setTab] = useState<Tab>('profile');
  const [visited, setVisited] = useState<Tab[]>(['profile']);
  const form = useCloneSettingsDraft();
  const guard = useDraftClose(onClose, null, update.isLoading || deleting);

  async function save(): Promise<void> {
    if (!form.dirty || !form.valid || update.isLoading) return;
    try {
      const result = await update.mutateAsync({ personaId: persona.id, ...form.patch });
      if (!result) throw new Error('克隆体已不存在');
      form.markSaved();
      dialog.success('已保存', '克隆体设置已更新');
      onSaved();
    } catch (e) {
      dialog.error('保存失败', e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <DraftCloseContext.Provider value={guard.drafts}>
      <CloneSettingsDraftContext.Provider
        value={{ register: form.register, saving: update.isLoading }}
      >
        <ConversationSettingsFrame<Tab>
          title="克隆体设置"
          subtitle={persona.name}
          value={tab}
          onClose={guard.requestClose}
          sections={TABS}
          onValueChange={(id) => {
            setVisited((current) => (current.includes(id) ? current : [...current, id]));
            setTab(id);
          }}
        >
          <div className="weq-cvs-body-head">
            <span className="weq-cvs-body-icon">{TABS.find((item) => item.id === tab)?.icon}</span>
            <strong>{TABS.find((item) => item.id === tab)?.label}</strong>
          </div>
          <div className="weq-cvs-body-scroll">
            {fromGroup ? (
              <p className="weq-persona-scope">
                以下修改影响此克隆体的所有私聊和群聊，不仅限于当前群。
              </p>
            ) : null}
            <fieldset
              className="weq-persona-tabpane weq-persona-fields"
              disabled={update.isLoading || deleting}
            >
              {visited.map((page) => (
                <TabActivity key={page} active={tab === page}>
                  <div hidden={tab !== page} inert={tab !== page}>
                    {page === 'profile' ? (
                      <div className="weq-persona-form">
                        <p className="weq-persona-note">
                          训练范围：
                          {persona.training?.mode === 'group' ? '私聊为主，群聊补充风格' : '仅私聊'}
                          。更新画像立即启动后台任务，使用已保存的模型配置。
                        </p>
                        <ProfilePrompt initial={persona.customPrompt ?? ''} />
                        {persona.sourceKind === 'c2c' ? (
                          <CloneUpdateButton key={persona.id} persona={persona} />
                        ) : null}
                        {profileContent}
                      </div>
                    ) : page === 'reply' ? (
                      <div className="weq-persona-form">
                        {replyContent}
                        <div className="weq-persona-divider" />
                        <WillingTab persona={persona} />
                      </div>
                    ) : page === 'voice' ? (
                      <VoiceTab persona={persona} />
                    ) : page === 'memory' ? (
                      <MemoryTab personaId={persona.id} />
                    ) : page === 'export' ? (
                      <ExportTab persona={persona} />
                    ) : (
                      <div className="weq-persona-form">
                        <p className="weq-persona-note">
                          删除整个克隆体及其全部私聊历史、记忆，群聊中的既有消息会保留。此操作无法恢复。
                        </p>
                        {onDelete ? (
                          <button
                            type="button"
                            className="weq-set-btn weq-set-btn-soft"
                            disabled={deleting}
                            onClick={() => void guard.confirmLeave(onDelete)}
                          >
                            <Trash2 size={14} />
                            删除克隆体
                          </button>
                        ) : null}
                      </div>
                    )}
                  </div>
                </TabActivity>
              ))}
            </fieldset>
          </div>
          <footer className="weq-persona-savebar">
            <span role="status">
              {form.dirty ? (form.valid ? '有未保存的更改' : '请检查配置值') : '配置已保存'}
            </span>
            <button
              type="button"
              className="weq-set-btn"
              disabled={!form.dirty || !form.valid || update.isLoading || deleting}
              onClick={() => void save()}
            >
              <Save size={14} />
              {update.isLoading ? '保存中…' : '保存更改'}
            </button>
          </footer>
        </ConversationSettingsFrame>
      </CloneSettingsDraftContext.Provider>
    </DraftCloseContext.Provider>
  );
}
import { SegmentedControl } from '../../components/SegmentedControl';
