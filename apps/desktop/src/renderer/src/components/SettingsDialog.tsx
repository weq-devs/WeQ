/**
 * 设置弹窗。
 *
 * 左侧是分类导航，右侧是分类内容。外观能力单独收敛到“个性显示”页：
 * 基础模式、主题色（色相条 + 预设 + Hex）、界面背景、组件风格（占位）。
 */

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  Activity,
  AudioLines,
  Bot,
  Check,
  CloudDownload,
  DatabaseZap,
  Globe,
  HardDrive,
  HelpCircle,
  Lock,
  LockKeyhole,
  Monitor,
  Moon,
  Package,
  Palette,
  Plug,
  Radio,
  ScanText,
  Settings2,
  ScanSearch,
  ShieldCheck,
  Sun,
  User,
  X,
} from 'lucide-react';
import { GlobalSettingsSection } from './settings/GlobalSettingsSection';
import { HelpSection } from './settings/HelpSection';
import { VersionSection } from './settings/VersionSection';
import { QzoneSettingsSection } from './settings/QzoneSettingsSection';
import { AppLockSection } from './settings/AppLockSection';
import { AccountBasicsSection } from './settings/AccountBasicsSection';
import { AgentLabSection } from './settings/AgentLabSection';
import { VoiceTranscribeSection, TtsProvidersCard } from './settings/VoiceTranscribeSection';
import { OcrModelsSection } from './settings/OcrModelsSection';
import { McpServerSection } from './settings/McpServerSection';
import { ExternalRkeySection } from './settings/ExternalRkeySection';
import { SsePushSection } from './settings/SsePushSection';
import { DaemonSection } from './settings/DaemonSection';
import { DatabaseToleranceSection } from './settings/DatabaseToleranceSection';
import { DataMaintenanceSection, type MaintenanceTool } from './settings/DataMaintenanceSection';
import { SectionHeader, Toggle } from './settings/controls';
import { trpc } from '../trpc/client';
import { AntiRecallDialog } from './AntiRecallDialog';
import { WorkspacePage } from './WorkspacePages';
import { UsagePanel } from '../views/agentlab/UsagePanel';
import '../styles/settings-responsive.css';
import '../styles/settings-navigation.css';
import {
  SETTINGS_GROUPS,
  settingsGroupFor,
  settingsScopeFor,
  type SectionId,
} from './settings/navigation';
export type { SectionId } from './settings/navigation';
import {
  useThemeStore,
  type ThemeBackground,
  type ThemeComponentStyle,
  type ThemePreference,
} from '../state/theme';

/** 左侧导航的分区 id。导出出去是为了让别的界面能"直接打开某一屏"（例如损坏弹窗 → 数据库宽容）。 */
interface SettingsSection {
  id: SectionId;
  label: string;
  icon: ReactElement;
  render: (onOpenMaintenance: (tool: MaintenanceTool) => void) => ReactNode;
}

const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'global',
    label: '窗口行为',
    icon: <Settings2 size={16} strokeWidth={1.8} />,
    render: () => <GlobalSettingsSection />,
  },
  {
    id: 'version',
    label: '版本',
    icon: <Package size={16} strokeWidth={1.8} />,
    render: () => <VersionSection />,
  },
  {
    id: 'appearance',
    label: '主题与背景',
    icon: <Palette size={16} strokeWidth={1.8} />,
    render: () => <AppearanceSection page="theme" />,
  },
  {
    id: 'applock',
    label: '应用锁',
    icon: <LockKeyhole size={16} strokeWidth={1.8} />,
    render: () => <AppLockSection />,
  },
  {
    id: 'account',
    label: '接入与监听',
    icon: <User size={16} strokeWidth={1.8} />,
    render: () => <AccountBasicsSection />,
  },
  {
    id: 'accounts',
    label: '账号管理',
    icon: <User size={16} />,
    render: (onOpen) => (
      <>
        <GlobalSettingsSection section="accounts" />
        <button
          type="button"
          className="weq-maintenance-entry"
          onClick={() => onOpen('login-accounts')}
        >
          <User size={18} />
          <span>QQ 登录账号管理</span>
        </button>
      </>
    ),
  },
  { id: 'anti-recall', label: '防撤回', icon: <ShieldCheck size={16} />, render: () => null },
  {
    id: 'qzone',
    label: 'QQ 空间设置',
    icon: <Globe size={16} strokeWidth={1.8} />,
    render: () => <QzoneSettingsSection />,
  },
  {
    id: 'database',
    label: '损坏处理与容错',
    icon: <DatabaseZap size={16} strokeWidth={1.8} />,
    render: () => <DatabaseToleranceSection />,
  },
  {
    id: 'maintenance',
    label: '维护工具',
    icon: <HardDrive size={16} strokeWidth={1.8} />,
    render: (onOpen) => <DataMaintenanceSection onOpen={onOpen} />,
  },
  {
    id: 'database-status',
    label: '容错记录',
    icon: <DatabaseZap size={16} />,
    render: () => <DatabaseToleranceSection page="status" />,
  },
  {
    id: 'voice',
    label: '语音转写',
    icon: <AudioLines size={16} strokeWidth={1.8} />,
    render: () => <VoiceTranscribeSection />,
  },
  {
    id: 'diagnostics',
    label: '高级诊断',
    icon: <ScanSearch size={16} />,
    render: (onOpen) => (
      <>
        <SectionHeader title="高级诊断" />
        <button type="button" className="weq-maintenance-entry" onClick={() => onOpen('capture')}>
          <Radio size={18} />
          <span>ntqq 抓包</span>
        </button>
        <button type="button" className="weq-maintenance-entry" onClick={() => onOpen('reverse')}>
          <ScanSearch size={18} />
          <span>Protobuf / JCE 逆向</span>
        </button>
      </>
    ),
  },
  {
    id: 'model-usage',
    label: '模型使用统计',
    icon: <Activity size={16} />,
    render: () => <ModelUsageSection />,
  },
  {
    id: 'ocr',
    label: '图片识别',
    icon: <ScanText size={16} strokeWidth={1.8} />,
    render: () => <OcrModelsSection />,
  },
  {
    id: 'agentlab',
    label: '模型配置',
    icon: <Bot size={16} strokeWidth={1.8} />,
    render: () => <AgentLabSection />,
  },
  {
    id: 'mcp',
    label: 'MCP 服务器',
    icon: <Plug size={16} strokeWidth={1.8} />,
    render: () => <McpServerSection />,
  },
  {
    id: 'rkey',
    label: '外部 RKEY',
    icon: <CloudDownload size={16} strokeWidth={1.8} />,
    render: () => <ExternalRkeySection />,
  },
  {
    id: 'sse',
    label: 'SSE 推送',
    icon: <Radio size={16} strokeWidth={1.8} />,
    render: () => <SsePushSection />,
  },
  {
    id: 'daemon',
    label: '后台服务',
    icon: <Activity size={16} strokeWidth={1.8} />,
    render: () => <DaemonSection />,
  },
  {
    id: 'help',
    label: '帮助',
    icon: <HelpCircle size={16} strokeWidth={1.8} />,
    render: () => <HelpSection />,
  },
  {
    id: 'message-display',
    label: '消息显示',
    icon: <Monitor size={16} />,
    render: () => <AppearanceSection page="messages" />,
  },
  {
    id: 'startup',
    label: '开机启动',
    icon: <Monitor size={16} />,
    render: () => <DaemonSection panel="startup" />,
  },
  {
    id: 'saving',
    label: '默认保存',
    icon: <HardDrive size={16} />,
    render: () => <GlobalSettingsSection section="saving" />,
  },
  {
    id: 'storage',
    label: '缓存与网络',
    icon: <HardDrive size={16} />,
    render: () => <GlobalSettingsSection section="storage" />,
  },
  {
    id: 'media',
    label: '媒体来源',
    icon: <HardDrive size={16} />,
    render: () => <AccountBasicsSection page="media" />,
  },
  {
    id: 'credentials',
    label: '账号凭据',
    icon: <Lock size={16} />,
    render: () => <AccountBasicsSection page="credentials" />,
  },
  {
    id: 'logs',
    label: '日志设置',
    icon: <Activity size={16} />,
    render: () => <GlobalSettingsSection section="logs" />,
  },
  {
    id: 'updates',
    label: '更新提醒',
    icon: <Package size={16} />,
    render: () => <DaemonSection panel="updates" />,
  },
  {
    id: 'tts',
    label: '语音合成',
    icon: <AudioLines size={16} />,
    render: () => <TtsProvidersCard />,
  },
];

/** Quick-pick accent presets. First entry is the WeQ default blue. */
const ACCENT_PRESETS = [
  '#0099ff',
  '#3b82f6',
  '#6f8aa6',
  '#16b8a6',
  '#32b67a',
  '#f59e0b',
  '#ef4444',
  '#ec4899',
  '#8b5cf6',
];

const DEFAULT_ACCENT = '#0099ff';

export function SettingsDialog({
  open,
  onClose,
  initialSection,
  onOpenMaintenance,
  onOpenRecalls,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * 打开时先落到哪一屏。每次 `open` 从 false 变 true 都会重新应用 ——
   * 否则"先关掉、再从损坏弹窗点进来"会停在用户上次看的那个分区上。
   */
  initialSection?: SectionId;
  onOpenMaintenance: (tool: MaintenanceTool) => void;
  onOpenRecalls: (kind: 'c2c' | 'group', conv: string) => void;
}): ReactElement | null {
  const [activeId, setActiveId] = useState<SectionId>(() => initialSection ?? 'global');
  const navRef = useRef<HTMLElement | null>(null);
  const subnavRef = useRef<HTMLElement | null>(null);
  const sections = SETTINGS_SECTIONS;
  const group = settingsGroupFor(activeId);
  const groupSections = group.sections.map((id) => sections.find((section) => section.id === id)!);

  useEffect(() => {
    if (open && initialSection) setActiveId(initialSection);
  }, [open, initialSection]);

  useEffect(() => {
    if (open) {
      navRef.current
        ?.querySelector<HTMLElement>('.weq-settings-nav-item.is-active')
        ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      subnavRef.current
        ?.querySelector<HTMLElement>('.weq-settings-subnav-item.is-active')
        ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  }, [open, activeId]);

  if (!open) return null;

  const active = sections.find((s) => s.id === activeId) ?? sections[0] ?? SETTINGS_SECTIONS[0]!;

  return (
    <WorkspacePage title="设置" onClose={onClose}>
      <section
        className="weq-settings-dialog"
        role="region"
        aria-labelledby="weq-settings-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          className="weq-settings-close"
          type="button"
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <nav ref={navRef} className="weq-settings-nav" aria-label="设置分类">
          <h2 id="weq-settings-title" className="weq-settings-nav-title">
            设置
          </h2>
          <ul>
            {SETTINGS_GROUPS.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`weq-settings-nav-item${s.id === group.id ? ' is-active' : ''}`}
                  aria-current={s.id === group.id ? 'page' : undefined}
                  onClick={() => setActiveId(s.sections[0]!)}
                >
                  <span className="weq-settings-nav-icon">
                    {sections.find((section) => section.id === s.sections[0])!.icon}
                  </span>
                  <span>{s.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="weq-settings-content">
          <nav ref={subnavRef} className="weq-settings-subnav" aria-label={`${group.label}分类`}>
            {groupSections.map((section) => (
              <button
                key={section.id}
                type="button"
                className={`weq-settings-subnav-item${section.id === activeId ? ' is-active' : ''}`}
                aria-current={section.id === activeId ? 'page' : undefined}
                onClick={() => setActiveId(section.id)}
              >
                {section.label}
              </button>
            ))}
          </nav>
          {settingsScopeFor(active.id) ? (
            <div className="weq-settings-scope">{settingsScopeFor(active.id)}</div>
          ) : null}
          <div className="weq-settings-body" key={active.id}>
            {active.id === 'anti-recall' ? (
              <AntiRecallDialog
                embedded
                onClose={onClose}
                onOpenRecalls={(kind, conv) => {
                  onClose();
                  onOpenRecalls(kind, conv);
                }}
              />
            ) : (
              active.render(onOpenMaintenance)
            )}
          </div>
        </div>
      </section>
    </WorkspacePage>
  );
}

function ModelUsageSection(): ReactElement {
  const personas = trpc.account.listAgentLabPersonas.useQuery();
  const names = new Map((personas.data ?? []).map((persona) => [persona.id, persona.name]));
  return (
    <div className="weq-settings-model-usage">
      <SectionHeader title="模型使用统计" />
      <UsagePanel
        personaCount={names.size}
        resolveName={(id) => names.get(id) ?? '已删除的克隆'}
        hasPersona={(id) => id === '__assistant__' || names.has(id)}
      />
    </div>
  );
}

function AppearanceSection({ page }: { page: 'theme' | 'messages' }): ReactElement {
  const preference = useThemeStore((state) => state.preference);
  const accent = useThemeStore((state) => state.accent);
  const background = useThemeStore((state) => state.background);
  const componentStyle = useThemeStore((state) => state.componentStyle);
  const setPreference = useThemeStore((state) => state.setPreference);
  const setAccent = useThemeStore((state) => state.setAccent);
  const setBackground = useThemeStore((state) => state.setBackground);
  const setComponentStyle = useThemeStore((state) => state.setComponentStyle);

  // 「纯文本消息渲染 Markdown」——不像主题那样存 localStorage，而是走 AppSettings
  // （config.json）：渲染层要通过 App.tsx 的 TextMarkdownContext 广播给每条气泡。
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const setRenderTextMarkdown = trpc.bootstrap.setRenderTextMarkdown.useMutation();
  const setShowAvatarPendant = trpc.bootstrap.setShowAvatarPendant.useMutation();
  const setLinkPreview = trpc.bootstrap.setLinkPreview.useMutation();
  const setShowMsgDecoration = trpc.bootstrap.setShowMsgDecoration.useMutation();
  const setShowMessageSeq = trpc.bootstrap.setShowMessageSeq.useMutation();
  const setShowMessageTime = trpc.bootstrap.setShowMessageTime.useMutation();
  const [seqError, setSeqError] = useState<string | null>(null);
  const [textMarkdown, setTextMarkdown] = useState(true);
  const [pendant, setPendant] = useState(true);
  const [msgDecoration, setMsgDecoration] = useState(true);
  const [linkCard, setLinkCard] = useState(true);
  const [linkShot, setLinkShot] = useState(false);

  useEffect(() => {
    const enabled = settings.data?.renderTextMarkdown;
    if (typeof enabled === 'boolean') setTextMarkdown(enabled);
  }, [settings.data?.renderTextMarkdown]);

  useEffect(() => {
    const enabled = settings.data?.showAvatarPendant;
    if (typeof enabled === 'boolean') setPendant(enabled);
  }, [settings.data?.showAvatarPendant]);

  useEffect(() => {
    const enabled = settings.data?.showMsgDecoration;
    if (typeof enabled === 'boolean') setMsgDecoration(enabled);
  }, [settings.data?.showMsgDecoration]);

  useEffect(() => {
    const cfg = settings.data?.linkPreview;
    if (typeof cfg?.enabled === 'boolean') setLinkCard(cfg.enabled);
    if (typeof cfg?.screenshot === 'boolean') setLinkShot(cfg.screenshot);
  }, [settings.data?.linkPreview]);

  // 本地先翻转求手感，失败回滚 + 重新拉服务端值。
  async function onSetTextMarkdown(next: boolean): Promise<void> {
    const prev = textMarkdown;
    setTextMarkdown(next);
    try {
      await setRenderTextMarkdown.mutateAsync({ enabled: next });
    } catch {
      setTextMarkdown(prev);
    }
    await settings.refetch();
  }

  async function onSetPendant(next: boolean): Promise<void> {
    const prev = pendant;
    setPendant(next);
    try {
      await setShowAvatarPendant.mutateAsync({ enabled: next });
    } catch {
      setPendant(prev);
    }
    await settings.refetch();
  }

  async function onSetMsgDecoration(next: boolean): Promise<void> {
    const prev = msgDecoration;
    setMsgDecoration(next);
    try {
      await setShowMsgDecoration.mutateAsync({ enabled: next });
    } catch {
      setMsgDecoration(prev);
    }
    await settings.refetch();
  }

  async function onSetLinkCard(next: boolean): Promise<void> {
    const prev = linkCard;
    setLinkCard(next);
    try {
      await setLinkPreview.mutateAsync({ enabled: next });
    } catch {
      setLinkCard(prev);
    }
    await settings.refetch();
  }

  async function onSetLinkShot(next: boolean): Promise<void> {
    const prev = linkShot;
    setLinkShot(next);
    try {
      await setLinkPreview.mutateAsync({ screenshot: next });
    } catch {
      setLinkShot(prev);
    }
    await settings.refetch();
  }

  return (
    <section className="weq-settings-section">
      <SectionHeader
        icon={<Palette size={16} strokeWidth={1.8} />}
        title={page === 'theme' ? '主题与背景' : '消息显示'}
      />

      {page === 'theme' && (
        <>
          <div className="weq-settings-appearance-card">
            <div className="weq-settings-appearance-head">
              <div>
                <strong>基础模式</strong>
                <span>控制浅色、深色与跟随系统</span>
              </div>
            </div>
            <ThemeModeSwitcher value={preference} onChange={setPreference} />
          </div>

          <div className="weq-settings-appearance-card">
            <div className="weq-settings-appearance-head">
              <div>
                <strong>主题色</strong>
                <span>拖动色相条或输入色值挑选主色，界面主色、描边与按钮都会跟随</span>
              </div>
            </div>
            <ColorPicker value={accent} onChange={setAccent} />
          </div>

          <div className="weq-settings-appearance-card">
            <div className="weq-settings-appearance-head">
              <div>
                <strong>界面背景</strong>
                <span>给聊天、联系人与导出页切换不同画布质感</span>
              </div>
            </div>
            <ThemeBackgroundRow value={background} onChange={setBackground} />
          </div>

          <div className="weq-settings-appearance-card is-placeholder">
            <div className="weq-settings-appearance-head">
              <div>
                <strong>组件风格</strong>
                <span>切换整套组件皮肤，目前仅提供经典版</span>
              </div>
            </div>
            <ComponentStyleRow value={componentStyle} onChange={setComponentStyle} />
          </div>
        </>
      )}
      {page === 'messages' && (
        <>
          <div className="weq-settings-appearance-card">
            <div className="weq-settings-appearance-head">
              <div>
                <strong>纯文本消息渲染 Markdown</strong>
                <span>
                  把普通文本消息里的 # 标题、**加粗**、代码块等语法渲染成富文本。这是 WeQ
                  自己的功能——QQ 只把专门的 Markdown 消息当富文本，关掉后纯文本原样显示 （QQ 原生
                  Markdown 消息不受影响）。
                </span>
              </div>
              <Toggle
                checked={textMarkdown}
                disabled={settings.isLoading || setRenderTextMarkdown.isLoading}
                onChange={(next) => void onSetTextMarkdown(next)}
                label="纯文本消息渲染 Markdown"
              />
            </div>
          </div>
          <div className="weq-settings-appearance-card">
            <div className="weq-settings-appearance-head">
              <div>
                <strong>聊天头像挂件</strong>
                <span>
                  把 QQ 里正在用的挂件叠在聊天页头像的外圈。只作用于自己的头像——别人的挂件
                  要逐个联网查，想看请在资料卡里打开「个性主页」。
                </span>
              </div>
              <Toggle
                checked={pendant}
                disabled={settings.isLoading || setShowAvatarPendant.isLoading}
                onChange={(next) => void onSetPendant(next)}
                label="聊天头像挂件"
              />
            </div>
          </div>
          <div className="weq-settings-appearance-card">
            <div className="weq-settings-appearance-head">
              <div>
                <strong>显示消息序号（seq）</strong>
              </div>
              <Toggle
                checked={settings.data?.showMessageSeq ?? false}
                disabled={!settings.data || setShowMessageSeq.isLoading}
                onChange={(enabled) => {
                  setSeqError(null);
                  setShowMessageSeq.mutate(
                    { enabled },
                    {
                      onSuccess: () => {
                        void settings.refetch();
                      },
                      onError: (error) => setSeqError(error.message),
                    },
                  );
                }}
                label="显示消息序号（seq）"
              />
            </div>
            {seqError ? <p role="alert">{seqError}</p> : null}
            <div className="weq-settings-appearance-head">
              <strong>显示发送时间（精确到秒）</strong>
              <Toggle
                checked={settings.data?.showMessageTime ?? false}
                disabled={!settings.data || setShowMessageTime.isLoading}
                onChange={(enabled) => {
                  setSeqError(null);
                  setShowMessageTime.mutate(
                    { enabled },
                    {
                      onSuccess: () => {
                        void settings.refetch();
                      },
                      onError: (error) => setSeqError(error.message),
                    },
                  );
                }}
                label="显示发送时间（精确到秒）"
              />
            </div>
          </div>
          <div className="weq-settings-appearance-card">
            <div className="weq-settings-appearance-head">
              <div>
                <strong>消息装扮（气泡/字体/挂件）</strong>
                <span>
                  渲染每条消息里的气泡皮肤、聊天字体与挂件（来自消息 DB 列 40801）。关掉后
                  统一使用全局装扮设置，不做逐条渲染。
                </span>
              </div>
              <Toggle
                checked={msgDecoration}
                disabled={settings.isLoading || setShowMsgDecoration.isLoading}
                onChange={(next) => void onSetMsgDecoration(next)}
                label="消息装扮"
              />
            </div>
          </div>
          <div className="weq-settings-appearance-card">
            <div className="weq-settings-appearance-head">
              <div>
                <strong>链接预览卡片</strong>
                <span>
                  一条消息只有一个链接时，抓取网页标题、简介和封面渲染成卡片。会按链接访问
                  对应网页（结果本地缓存），关掉后链接仍标蓝可点，但完全不出网。
                </span>
              </div>
              <Toggle
                checked={linkCard}
                disabled={settings.isLoading || setLinkPreview.isLoading}
                onChange={(next) => void onSetLinkCard(next)}
                label="链接预览卡片"
              />
            </div>
          </div>
          <div className="weq-settings-appearance-card">
            <div className="weq-settings-appearance-head">
              <div>
                <strong>无封面时网页截图</strong>
                <span>
                  网页没提供封面图时，在一个隔离的后台窗口里把它打开并截取首屏当封面。这会
                  真正运行对方页面的脚本（沙盒内、不落盘、退出即清），默认关闭。
                </span>
              </div>
              <Toggle
                checked={linkShot}
                disabled={!linkCard || settings.isLoading || setLinkPreview.isLoading}
                onChange={(next) => void onSetLinkShot(next)}
                label="无封面时网页截图"
              />
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function ThemeModeSwitcher({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (next: ThemePreference) => void;
}) {
  const options: Array<{ value: ThemePreference; label: string; icon: ReactNode }> = [
    { value: 'light', label: '浅色', icon: <Sun size={14} /> },
    { value: 'dark', label: '深色', icon: <Moon size={14} /> },
    { value: 'system', label: '跟随系统', icon: <Monitor size={14} /> },
  ];

  return (
    <div className="weq-settings-theme-switch-inner" role="radiogroup" aria-label="主题模式">
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={`weq-settings-theme-option${active ? ' is-active' : ''}`}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
          >
            <span className="weq-settings-theme-option-icon">{option.icon}</span>
            <span className="weq-settings-theme-option-label">{option.label}</span>
            {active ? <Check size={14} /> : null}
          </button>
        );
      })}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * 主题色调色器（色相条 + 明度条 + Hex 输入 + 预设快捷色）。
 * 主色存为自由 hex，空值回落到内置 --weq-accent。
 * ──────────────────────────────────────────────────────────────────── */

type Hsl = { h: number; s: number; l: number };

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function normalizeHex(input: string): string | null {
  let hex = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return `#${hex.toLowerCase()}`;
}

function hexToHsl(input: string): Hsl | null {
  const hex = normalizeHex(input);
  if (!hex) return null;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Track a horizontal drag on a bar; reports fraction 0..1 on down + move. */
function trackBar(
  event: ReactPointerEvent<HTMLDivElement>,
  onFraction: (fraction: number) => void,
): void {
  const rect = event.currentTarget.getBoundingClientRect();
  const compute = (clientX: number) => clamp01((clientX - rect.left) / rect.width);
  onFraction(compute(event.clientX));
  const move = (ev: PointerEvent) => onFraction(compute(ev.clientX));
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// Lightness slider maps fraction 0..1 onto this readable band (avoids near
// black / near white accents that wash the UI out).
const LIGHT_MIN = 0.16;
const LIGHT_SPAN = 0.66;

function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (hex: string) => void;
}): ReactElement {
  const effective = value || DEFAULT_ACCENT;
  const hsl = hexToHsl(effective) ?? hexToHsl(DEFAULT_ACCENT)!;
  // Use a confident saturation when the hue strip drives the color so dragging
  // never produces a muddy accent; honor the picked saturation otherwise.
  const sat = Math.max(hsl.s, 0.5);

  const [hexDraft, setHexDraft] = useState(effective);
  useEffect(() => setHexDraft(effective), [effective]);

  const huePct = (hsl.h / 360) * 100;
  const lightFraction = clamp01((hsl.l - LIGHT_MIN) / LIGHT_SPAN);

  const pickHue = (fraction: number) => onChange(hslToHex(fraction * 360, sat, hsl.l));
  const pickLight = (fraction: number) =>
    onChange(hslToHex(hsl.h, sat, LIGHT_MIN + fraction * LIGHT_SPAN));

  const lightGradient = `linear-gradient(to right, ${hslToHex(hsl.h, sat, LIGHT_MIN)}, ${hslToHex(
    hsl.h,
    sat,
    0.5,
  )}, ${hslToHex(hsl.h, sat, LIGHT_MIN + LIGHT_SPAN)})`;

  const commitHex = (raw: string) => {
    const hex = normalizeHex(raw);
    if (hex) onChange(hex);
    else setHexDraft(effective);
  };

  return (
    <div className="weq-settings-colorpicker">
      <div className="weq-cp-preview" style={{ ['--weq-cp-color' as string]: effective }}>
        <span className="weq-cp-preview-dot" />
        <span className="weq-cp-preview-label">当前主色</span>
        <span className="weq-cp-preview-hex">{effective.toUpperCase()}</span>
      </div>

      <div
        className="weq-cp-bar weq-cp-hue"
        role="slider"
        aria-label="色相"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsl.h)}
        onPointerDown={(e) => trackBar(e, pickHue)}
      >
        <span className="weq-cp-thumb" style={{ left: `${huePct}%` }} />
      </div>

      <div
        className="weq-cp-bar weq-cp-light"
        role="slider"
        aria-label="明度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(lightFraction * 100)}
        style={{ background: lightGradient }}
        onPointerDown={(e) => trackBar(e, pickLight)}
      >
        <span className="weq-cp-thumb" style={{ left: `${lightFraction * 100}%` }} />
      </div>

      <div className="weq-cp-row">
        <label className="weq-cp-hex">
          <span>#</span>
          <input
            value={hexDraft.replace(/^#/, '')}
            spellCheck={false}
            maxLength={7}
            onChange={(e) => setHexDraft(e.target.value)}
            onBlur={(e) => commitHex(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitHex((e.target as HTMLInputElement).value);
            }}
            aria-label="主色十六进制值"
          />
        </label>
        <div className="weq-cp-presets" role="group" aria-label="预设主色">
          {ACCENT_PRESETS.map((swatch) => {
            const active = effective.toLowerCase() === swatch.toLowerCase();
            return (
              <button
                key={swatch}
                type="button"
                className={`weq-cp-swatch${active ? ' is-active' : ''}`}
                style={{ ['--weq-swatch-color' as string]: swatch }}
                onClick={() => onChange(swatch)}
                title={swatch}
                aria-label={swatch}
              >
                {active ? <Check size={12} /> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ThemeBackgroundRow({
  value,
  onChange,
}: {
  value: ThemeBackground;
  onChange: (next: ThemeBackground) => void;
}) {
  const options: Array<{ value: ThemeBackground; label: string; desc: string }> = [
    { value: 'plain', label: '纯净', desc: '近纯色，最克制' },
    { value: 'paper', label: '纸感', desc: '轻微纤维感，更柔和' },
    { value: 'grid', label: '细网格', desc: '很淡的秩序线条' },
    { value: 'dots', label: '微点阵', desc: '比网格更轻的颗粒感' },
    { value: 'wash', label: '淡洗染', desc: '极浅的色块过渡' },
    { value: 'telegram', label: '电报墙', desc: 'Telegram 风格简笔画平铺' },
  ];

  return (
    <div className="weq-settings-preset-grid" role="radiogroup" aria-label="界面背景风格">
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={`weq-settings-preset-card${active ? ' is-active' : ''}`}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
          >
            <span
              className={`weq-settings-preset-preview is-bg-${option.value}`}
              aria-hidden="true"
            />
            <strong>{option.label}</strong>
            <small>{option.desc}</small>
          </button>
        );
      })}
    </div>
  );
}

function ComponentStyleRow({
  value,
  onChange,
}: {
  value: ThemeComponentStyle;
  onChange: (next: ThemeComponentStyle) => void;
}) {
  return (
    <div className="weq-settings-preset-grid" role="radiogroup" aria-label="组件风格">
      <button
        type="button"
        className={`weq-settings-preset-card${value === 'classic' ? ' is-active' : ''}`}
        role="radio"
        aria-checked={value === 'classic'}
        onClick={() => onChange('classic')}
      >
        <span className="weq-settings-preset-preview is-style-classic" aria-hidden="true" />
        <strong>经典</strong>
        <small>当前默认组件套</small>
      </button>
      <div
        className="weq-settings-preset-card is-locked"
        role="radio"
        aria-checked={false}
        aria-disabled="true"
      >
        <span className="weq-settings-preset-preview is-style-soon" aria-hidden="true">
          <Lock size={16} />
        </span>
        <strong>敬请期待</strong>
        <small>更多组件套规划中</small>
      </div>
    </div>
  );
}
