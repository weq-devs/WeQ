/**
 * 设置整页。
 *
 * 左侧一级分类，右侧二级页；旧页面与条目入口统一解析到规范位置。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  AudioLines,
  Bell,
  Bot,
  Bug,
  BrainCircuit,
  BookOpen,
  Check,
  ChevronRight,
  Clock,
  Code2,
  DatabaseZap,
  Globe,
  HardDrive,
  ImageIcon,
  HelpCircle,
  Lock,
  LockKeyhole,
  Mail,
  Monitor,
  MessagesSquare,
  Moon,
  Package,
  Palette,
  PhoneCall,
  Plug,
  Power,
  Radio,
  ScanText,
  Settings2,
  Smile,
  Send,
  ScanSearch,
  ScrollText,
  Sun,
  User,
  Users,
  X,
} from 'lucide-react';
import { GlobalSettingsSection } from './settings/GlobalSettingsSection';
import { HelpSection } from './settings/HelpSection';
import { VersionSection } from './settings/VersionSection';
import { QzoneSettingsSection } from './settings/QzoneSettingsSection';
import { CallRecordingSection } from './settings/CallRecordingSection';
import { MailSettingsSection } from './settings/MailSettingsSection';
import { PrivacySection } from './settings/PrivacySection';
import { TypingStatusSettingsCard } from './settings/TypingStatusSettingsCard';
import { AccountBasicsSection } from './settings/AccountBasicsSection';
import { ComponentAppearance } from './settings/ComponentAppearance';
import { AgentLabSection } from './settings/AgentLabSection';
import { IntentSenseSection } from './settings/IntentSenseSection';
import { InteractionProfileSection } from './settings/InteractionProfileSection';
import { ReplySuggestionsSection } from './settings/ReplySuggestionsSection';
import { VoiceTranscribeSection, TtsProvidersCard } from './settings/VoiceTranscribeSection';
import { OcrModelsSection } from './settings/OcrModelsSection';
import { McpServerSection } from './settings/McpServerSection';
import { OneBotSection } from './settings/OneBotSection';
import { RemoteSection } from './settings/RemoteSection';
import { BackupSection } from './settings/BackupSection';
import { ExternalRkeySection } from './settings/ExternalRkeySection';
import { SsePushSection } from './settings/SsePushSection';
import { AssistantSection } from './settings/AssistantSection';
import { StartupSection } from './settings/StartupSection';
import { DatabaseSettingsSection } from './settings/DatabaseSettingsSection';
import { DataMaintenanceSection, type MaintenanceTool } from './settings/DataMaintenanceSection';
import { DatabaseManagementSection } from './settings/DatabaseManagementSection';
import { ResourceManagementSection } from './settings/ResourceManagementSection';
import { ChatImageCacheSettings } from './settings/ChatImageCacheSettings';
import { QqShowSettings } from './settings/QqShowSettings';
import { VoiceAutoTranscribeSetting } from './settings/VoiceAutoTranscribeSetting';
import {
  Card,
  Row,
  SectionHeader,
  SettingsNavigateContext,
  SettingsScopeContext,
  Toggle,
} from './settings/controls';
import { trpc } from '../trpc/client';
import { DEFAULT_ACCENT, normalizeHex } from '../../../shared/theme_colors';
import { AntiRecallDialog } from './AntiRecallDialog';
import { WorkspacePage } from './WorkspacePages';
import { LoginAccountPanel } from './LoginAccountPanel';
import { ReverseTool } from './ReverseTool';
import { SignerStatusCard } from './settings/SignerStatusCard';
import { mobileBack, useMobileBack } from '../hooks/useMobileNavigation';
import { UsagePanel } from '../views/agentlab/UsagePanel';
import '../styles/settings-responsive.css';
import '../styles/settings-navigation.css';
import '../styles/app-search.css';
import type { SettingsSearchTarget } from './settings/searchTarget';
import { RetainedTabs, TabActivity, useTabActive } from './RetainedTabs';
import {
  PageSnapshotsFallback,
  usePageSnapshotKey,
  usePageSnapshotReset,
  usePageState,
} from './PageSnapshots';
import { pageSnapshots } from '../lib/pageSnapshots';
import { DraftCloseContext, useDraftClose } from '../lib/draftClose';
import { useToast } from './Toast';
import { Modal } from './Dialog';
import type { SettingsNavigation } from '../hooks/useSettingsNavigation';
import { z } from 'zod';
import { RetainedSettingsPage } from './settings/RetainedSettingsPage';
const PerformanceMonitor = lazy(() => import('./settings/PerformanceMonitor'));
import { useAppLock } from '../state/lock';
import {
  SETTINGS_GROUPS,
  resolveSettingsTarget,
  settingsScopeFor,
  type SectionId,
  type SettingsPageId,
} from './settings/navigation';
export type { SectionId } from './settings/navigation';
import { useThemeStore, type ThemeBackground, type ThemePreference } from '../state/theme';
import { SharedDisplayToggle } from './settings/SharedDisplayToggle';
import { useUpdateStore } from '../state/update';
import { SettingsResetButton } from './settings/SettingsReset';
import { flushSettingsSaves, hasPendingSettingsSaves } from '../lib/settingsSaveQueue';
import { ContactCardSettings } from './settings/ContactCardSettings';
import { useRemoteClient } from '../lib/remoteClient';
import { remoteSettingAvailable } from '../../../shared/remote_capabilities';

/** 左侧导航的分区 id。导出出去是为了让别的界面能"直接打开某一屏"（例如损坏弹窗 → 数据库宽容）。 */
interface SettingsSection {
  id: SettingsPageId;
  label: string;
  icon: ReactElement;
  render: (onOpenMaintenance: (tool: MaintenanceTool) => void) => ReactNode;
}

const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'contact-card',
    label: '联系人名片',
    icon: <User size={16} />,
    render: () => <ContactCardSettings />,
  },
  {
    id: 'backup',
    label: '配置备份与恢复',
    icon: <HardDrive size={16} />,
    render: () => <BackupSection />,
  },
  {
    id: 'global',
    label: '提醒与窗口',
    icon: <Settings2 size={16} strokeWidth={1.8} />,
    render: () => <GlobalSettingsSection />,
  },
  {
    id: 'version',
    label: '版本与更新',
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
    id: 'privacy',
    label: '隐私',
    icon: <LockKeyhole size={16} strokeWidth={1.8} />,
    render: () => <PrivacySection />,
  },
  {
    id: 'account',
    label: '监听与读取',
    icon: <User size={16} strokeWidth={1.8} />,
    render: () => <AccountBasicsSection />,
  },
  {
    id: 'accounts',
    label: 'WeQ 账号管理',
    icon: <User size={16} />,
    render: () => <GlobalSettingsSection section="accounts" />,
  },
  {
    id: 'media',
    label: '媒体来源',
    icon: <HardDrive size={16} />,
    render: () => <AccountBasicsSection page="media" />,
  },
  {
    id: 'qq-accounts',
    label: 'QQ 登录记录管理',
    icon: <Users size={16} />,
    render: () => (
      <div className="weq-set" data-setting-id="qq-accounts">
        <SectionHeader title="QQ 登录记录管理" icon={<Users size={16} strokeWidth={1.8} />} />
        <LoginAccountPanel />
      </div>
    ),
  },
  {
    id: 'call-recording',
    label: '通话录音',
    icon: <PhoneCall size={16} strokeWidth={1.8} />,
    render: () => <CallRecordingSection />,
  },
  {
    id: 'qzone',
    label: 'QQ 空间',
    icon: <Globe size={16} strokeWidth={1.8} />,
    render: () => <QzoneSettingsSection />,
  },
  {
    id: 'mail',
    label: 'QQ 邮箱',
    icon: <Mail size={16} strokeWidth={1.8} />,
    render: () => <MailSettingsSection />,
  },
  {
    id: 'database-repair',
    label: '损坏与修复',
    icon: <DatabaseZap size={16} strokeWidth={1.8} />,
    render: (onOpen) => <DatabaseSettingsSection page="repair" onOpen={onOpen} />,
  },
  {
    id: 'database-management',
    label: '数据库管理',
    icon: <HardDrive size={16} strokeWidth={1.8} />,
    render: () => <DatabaseManagementSection />,
  },
  {
    id: 'database-tolerance',
    label: '数据库容错',
    icon: <DatabaseZap size={16} />,
    render: (onOpen) => <DatabaseSettingsSection page="tolerance" onOpen={onOpen} />,
  },
  {
    id: 'qq-storage',
    label: 'QQ 资源管理',
    icon: <HardDrive size={16} />,
    render: () => <ResourceManagementSection />,
  },
  {
    id: 'voice',
    label: '语音识别',
    icon: <AudioLines size={16} strokeWidth={1.8} />,
    render: () => <VoiceTranscribeSection />,
  },
  {
    id: 'resource-loading',
    label: '资源加载',
    icon: <Globe size={16} />,
    render: () => <GlobalSettingsSection section="network" />,
  },
  {
    id: 'performance-monitor',
    label: '性能监视',
    icon: <Activity size={16} />,
    render: () => (
      <Suspense fallback={<p>正在加载性能监视…</p>}>
        <PerformanceMonitor />
      </Suspense>
    ),
  },
  {
    id: 'diagnostics',
    label: 'QQ 协议工具',
    icon: <ScanSearch size={16} />,
    render: (onOpen) => (
      <div className="weq-set">
        <SectionHeader title="QQ 协议工具" icon={<ScanSearch size={16} strokeWidth={1.8} />} />
        <div className="weq-maintenance-list">
          <button
            type="button"
            className="weq-maintenance-entry"
            data-setting-id="qqnt-capture"
            onClick={() => onOpen('capture')}
          >
            <Radio size={18} aria-hidden />
            <span>QQNT 抓包</span>
            <ChevronRight size={16} aria-hidden />
          </button>
        </div>
        <SignerStatusCard />
        <Card
          title="Protobuf / JCE 逆向"
          icon={<Code2 size={15} strokeWidth={1.8} />}
          settingId="reverse-tool"
        >
          <ReverseTool />
        </Card>
      </div>
    ),
  },
  {
    id: 'model-usage',
    label: 'API 用量',
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
    label: 'API 配置',
    icon: <Bot size={16} strokeWidth={1.8} />,
    render: () => (
      <>
        <AgentLabSection />
        <div className="weq-set">
          <TtsProvidersCard />
        </div>
      </>
    ),
  },
  {
    id: 'interaction-profile',
    label: '互动画像',
    icon: <BrainCircuit size={16} />,
    render: () => <InteractionProfileSection />,
  },
  {
    id: 'reply-suggestions',
    label: '推荐回复',
    icon: <BrainCircuit size={16} strokeWidth={1.8} />,
    render: () => <ReplySuggestionsSection />,
  },
  {
    id: 'intent-sense',
    label: '意图感知',
    icon: <BrainCircuit size={16} strokeWidth={1.8} />,
    render: () => <IntentSenseSection />,
  },
  {
    id: 'mcp',
    label: 'MCP 服务器',
    icon: <Plug size={16} strokeWidth={1.8} />,
    render: () => <McpServerSection />,
  },
  {
    id: 'onebot',
    label: 'OneBot / cc-connect',
    icon: <Plug size={16} strokeWidth={1.8} />,
    render: () => <OneBotSection />,
  },
  {
    id: 'remote',
    label: 'Web 与 Remote',
    icon: <Monitor size={16} strokeWidth={1.8} />,
    render: () => <RemoteSection />,
  },
  {
    id: 'assistant',
    label: 'QQ 公众号推送',
    icon: <Radio size={16} />,
    render: () => <AssistantSection />,
  },
  {
    id: 'sse',
    label: 'SSE 推送',
    icon: <Radio size={16} strokeWidth={1.8} />,
    render: () => <SsePushSection />,
  },
  {
    id: 'faq',
    label: '常见问题',
    icon: <HelpCircle size={16} strokeWidth={1.8} />,
    render: () => <HelpSection page="faq" />,
  },
  {
    id: 'feedback',
    label: '反馈',
    icon: <Bug size={16} strokeWidth={1.8} />,
    render: () => <HelpSection page="feedback" />,
  },
  {
    id: 'chat-messages',
    label: '阅读与未读',
    icon: <BookOpen size={16} />,
    render: () => <AppearanceSection page="messages" category="reading" />,
  },
  {
    id: 'message-display',
    label: '消息显示',
    icon: <Monitor size={16} />,
    render: () => <AppearanceSection page="messages" category="display" />,
  },
  {
    id: 'chat-interaction',
    label: '互动与防撤回',
    icon: <Send size={16} />,
    render: () => (
      <>
        <AppearanceSection page="messages" category="sending" />
        <TypingStatusSettingsCard />
      </>
    ),
  },
  {
    id: 'startup',
    label: '启动与主页',
    icon: <Power size={16} />,
    render: () => <StartupSection />,
  },
  {
    id: 'weq-storage',
    label: 'WeQ 存储管理',
    icon: <HardDrive size={16} />,
    render: () => (
      <>
        <div className="weq-set">
          <SectionHeader title="WeQ 存储管理" icon={<HardDrive size={16} strokeWidth={1.8} />} />
        </div>
        <GlobalSettingsSection section="storage" heading={false} />
      </>
    ),
  },
  {
    id: 'credentials',
    label: '凭据管理',
    icon: <Lock size={16} />,
    render: (onOpen) => (
      <>
        <AccountBasicsSection page="credentials" />
        <DataMaintenanceSection
          title={null}
          onOpen={onOpen}
          tools={['key-scan', 'other-device-key']}
        />
        <div data-setting-id="external-rkey">
          <ExternalRkeySection />
        </div>
      </>
    ),
  },
  {
    id: 'logs',
    label: '日志',
    icon: <ScrollText size={16} />,
    render: () => <HelpSection page="logs" />,
  },
];

/** Quick-pick accent presets. First entry is the WeQ default blue. */
const ACCENT_PRESETS = [
  DEFAULT_ACCENT,
  '#3b82f6',
  '#6f8aa6',
  '#16b8a6',
  '#32b67a',
  '#f59e0b',
  '#ef4444',
  '#ec4899',
  '#8b5cf6',
];

export function SettingsDialog(props: Parameters<typeof SettingsContent>[0]): ReactElement {
  return (
    <PageSnapshotsFallback scope="bootstrap-settings">
      <SettingsContent {...props} />
    </PageSnapshotsFallback>
  );
}

function SettingsContent({
  open,
  onClose,
  initialSection,
  searchTarget,
  onOpenMaintenance,
  onOpenRecalls,
  recallDetails,
  onCloseRecalls,
  isCurrentSource,
  navigationGuard,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * 打开时先落到哪一屏。每次 `open` 从 false 变 true 都会重新应用 ——
   * 否则"先关掉、再从损坏弹窗点进来"会停在用户上次看的那个分区上。
   */
  initialSection?: SectionId;
  searchTarget?: SettingsSearchTarget | null;
  onOpenMaintenance: (tool: MaintenanceTool) => void;
  onOpenRecalls: (kind: 'c2c' | 'group', conv: string) => void;
  recallDetails?: ReactNode;
  onCloseRecalls?: () => void;
  isCurrentSource?: () => boolean;
  navigationGuard?: { current: SettingsNavigation | null };
}): ReactElement | null {
  const remote = useRemoteClient();
  const target = useMemo(
    () => resolveSettingsTarget(searchTarget ?? { section: initialSection ?? 'startup' }),
    [initialSection, searchTarget],
  );
  const [activeId, setActiveId] = usePageState<SettingsPageId>(
    'settings:active',
    () => target.section,
    z.custom<SettingsPageId>(
      (value) =>
        typeof value === 'string' &&
        SETTINGS_GROUPS.some((group) => group.sections.some((section) => section === value)),
    ),
  );
  const updateAvailable = useUpdateStore((state) => state.available);
  const locked = useAppLock((state) => state.locked);
  const navRef = useRef<HTMLElement | null>(null);
  const [mobileCategoryOpen, setMobileCategoryOpen] = useState(
    Boolean(initialSection || searchTarget),
  );
  const subnavRef = useRef<HTMLElement | null>(null);
  const sections = SETTINGS_SECTIONS.filter((entry) => !remote || remoteSettingAvailable(entry.id));
  const groups = SETTINGS_GROUPS.map((group) => ({
    ...group,
    sections: group.sections.filter((id) => sections.some((section) => section.id === id)),
  })).filter((group) => group.sections.length > 0);
  const group = groups.find((entry) => entry.sections.includes(activeId)) ?? groups[0]!;
  const groupSections = group.sections.map((id) => sections.find((section) => section.id === id)!);
  const snapshots = usePageSnapshotReset('workspace:main:设置');
  const activeKey = usePageSnapshotKey('settings:active');
  useEffect(() => {
    if (!open || !activeKey) return;
    try {
      pageSnapshots.write(activeKey, activeId);
    } catch {
      useToast.getState().push({ tone: 'error', title: '设置页面位置保存失败' });
    }
  }, [open, activeKey, activeId]);
  const activeSnapshots = usePageSnapshotReset('workspace:main:设置', `settings:${activeId}`);
  const [closing, setClosing] = useState(false);
  const guard = useDraftClose(() => setClosing(true), null);
  const alive = useRef(open);
  useEffect(() => {
    alive.current = open;
    return () => {
      alive.current = false;
    };
  }, [open]);
  const [pendingNavigation, setPendingNavigation] = useState<{ navigate: () => void } | null>(null);
  const snapshotDraft = useCallback(
    () => ({ dirty: snapshots.hasDrafts(), busy: false }),
    [snapshots],
  );
  const requestNavigation = useCallback<SettingsNavigation>(
    (navigate) => {
      const check = () => {
        if (!alive.current) return;
        const drafts = [...guard.drafts]
          .filter((read) => read !== snapshotDraft)
          .map((read) => read());
        if (drafts.some((draft) => draft.busy)) return;
        if (!activeSnapshots.hasDrafts() && !drafts.some((draft) => draft.dirty)) {
          navigate();
          return;
        }
        setPendingNavigation((current) => current ?? { navigate });
      };
      if (hasPendingSettingsSaves()) void flushSettingsSaves().then(check);
      else check();
    },
    [activeSnapshots, guard.drafts, snapshotDraft],
  );
  const switchSection = useCallback(
    (section: SettingsPageId) => {
      if (remote && !remoteSettingAvailable(section)) section = 'startup';
      if (section !== activeId) requestNavigation(() => setActiveId(section));
    },
    [activeId, requestNavigation, setActiveId, remote],
  );
  const switchSectionRef = useRef(switchSection);
  switchSectionRef.current = switchSection;
  useEffect(() => {
    if (!open || !navigationGuard) return;
    navigationGuard.current = requestNavigation;
    return () => {
      if (navigationGuard.current === requestNavigation) navigationGuard.current = null;
    };
  }, [open, navigationGuard, requestNavigation]);
  useMobileBack(
    open && !closing && mobileCategoryOpen,
    () => requestNavigation(() => setMobileCategoryOpen(false)),
    30,
    () => navRef.current?.parentElement ?? null,
  );
  useEffect(() => {
    if (!closing) return;
    // 子页先卸载并写回滚动快照，再统一清除，避免关闭后旧位置重新写入。
    try {
      snapshots.reset();
    } catch {
      useToast
        .getState()
        .push({ tone: 'error', title: '设置页面状态清除失败', detail: '请检查本机存储后重试。' });
      setClosing(false);
      return;
    }
    setActiveId('startup');
    setMobileCategoryOpen(false);
    onClose();
    setClosing(false);
  }, [closing, snapshots, setActiveId, onClose]);
  useEffect(() => {
    guard.drafts.add(snapshotDraft);
    return () => {
      guard.drafts.delete(snapshotDraft);
    };
  }, [guard.drafts, snapshotDraft]);

  useEffect(() => {
    if (open && (initialSection || searchTarget)) switchSectionRef.current(target.section);
    if (open) setMobileCategoryOpen(Boolean(initialSection || searchTarget));
  }, [open, initialSection, searchTarget, target]);

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

  if (!open || closing) return null;

  const active = sections.find((s) => s.id === activeId) ?? sections[0] ?? SETTINGS_SECTIONS[0]!;
  const requestClose = () => {
    if (hasPendingSettingsSaves())
      void flushSettingsSaves().then(() => {
        if (alive.current) guard.requestClose();
      });
    else guard.requestClose();
  };

  return (
    <DraftCloseContext.Provider value={guard.drafts}>
      <WorkspacePage
        title="设置"
        onClose={requestClose}
        onNavigate={onClose}
        onBack={() => requestNavigation(onClose)}
        standalone
      >
        <section
          className="weq-settings-dialog weq-mobile-settings"
          data-mobile-category={mobileCategoryOpen || undefined}
          role="region"
          aria-labelledby="weq-settings-title"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <header className="weq-mobile-settings-header">
            <button
              type="button"
              aria-label={mobileCategoryOpen ? '返回设置分类' : '返回'}
              title={mobileCategoryOpen ? '返回设置分类' : '返回'}
              onClick={() =>
                // 标题写着「返回设置分类」时只回到一级分类，不经过返回栈退出设置。
                mobileCategoryOpen
                  ? requestNavigation(() => setMobileCategoryOpen(false))
                  : mobileBack() || requestNavigation(onClose)
              }
            >
              <ArrowLeft size={22} />
            </button>
            <strong>{mobileCategoryOpen ? group.label : '设置'}</strong>
          </header>
          <button
            className="weq-settings-close"
            type="button"
            title="关闭"
            aria-label="关闭"
            onClick={requestClose}
          >
            <X size={18} />
          </button>
          <nav ref={navRef} className="weq-settings-nav" aria-label="设置分类">
            <h2 id="weq-settings-title" className="weq-settings-nav-title">
              设置
            </h2>
            <ul>
              {groups.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`weq-settings-nav-item${s.id === group.id ? ' is-active' : ''}`}
                    aria-current={s.id === group.id ? 'page' : undefined}
                    onClick={() => {
                      if (s.sections[0] === activeId) {
                        setMobileCategoryOpen(true);
                        return;
                      }
                      requestNavigation(() => {
                        setActiveId(s.sections[0]!);
                        setMobileCategoryOpen(true);
                      });
                    }}
                  >
                    <span className="weq-settings-nav-icon">
                      {sections.find((section) => section.id === s.sections[0])!.icon}
                    </span>
                    <span className="weq-settings-nav-label">
                      {s.label}
                      {updateAvailable && s.sections.includes('version') ? (
                        <span className="weq-settings-update-mark" aria-label="有新版本可更新" />
                      ) : null}
                    </span>
                    <ChevronRight className="weq-mobile-settings-chevron" size={18} />
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
                  onClick={() => switchSection(section.id)}
                >
                  <span className="weq-settings-subnav-icon" aria-hidden="true">
                    {section.icon}
                  </span>
                  <span className="weq-settings-subnav-label">{section.label}</span>
                  {updateAvailable && section.id === 'version' ? (
                    <span className="weq-settings-update-mark" aria-label="有新版本可更新" />
                  ) : null}
                </button>
              ))}
            </nav>
            <div className="weq-settings-pages">
              <TabActivity active={!locked}>
                <PageSnapshotsFallback scope="bootstrap-settings">
                  <RetainedTabs snapshotKey="settings" activeKey={active.id}>
                    <RetainedSettingsPage
                      pageId={active.id}
                      target={target}
                      revision={searchTarget?.revision}
                    >
                      <SettingsScopeContext.Provider value={settingsScopeFor(active.id)}>
                        <SettingsNavigateContext.Provider
                          value={(section) => switchSection(section as SettingsPageId)}
                        >
                          {active.id === 'chat-interaction' ? (
                            <>
                              {active.render(onOpenMaintenance)}
                              <SettingsScopeContext.Provider value={null}>
                                <AntiRecallDialog
                                  embedded
                                  onClose={() => {}}
                                  onOpenRecalls={onOpenRecalls}
                                  recallDetails={recallDetails}
                                  onCloseRecalls={onCloseRecalls}
                                  isCurrentSource={isCurrentSource}
                                />
                              </SettingsScopeContext.Provider>
                            </>
                          ) : (
                            active.render(onOpenMaintenance)
                          )}
                        </SettingsNavigateContext.Provider>
                      </SettingsScopeContext.Provider>
                    </RetainedSettingsPage>
                  </RetainedTabs>
                </PageSnapshotsFallback>
              </TabActivity>
            </div>
          </div>
        </section>
      </WorkspacePage>
      {pendingNavigation && (
        <Modal
          onClose={() => setPendingNavigation(null)}
          className="weq-message-modal"
          labelledBy="weq-settings-leave-title"
        >
          <div className="weq-dialog weq-dialog-warning">
            <div className="weq-dialog-head">
              <span className="weq-dialog-icon" aria-hidden>
                <AlertTriangle size={20} strokeWidth={1.85} />
              </span>
              <h3 id="weq-settings-leave-title" className="weq-dialog-title">
                当前设置尚未保存
              </h3>
              <button
                type="button"
                className="weq-dialog-x"
                aria-label="继续编辑"
                onClick={() => setPendingNavigation(null)}
              >
                <X size={16} />
              </button>
            </div>
            <div className="weq-dialog-body">
              先留在当前页保存，或暂时离开。暂时离开会保留未保存内容，返回后可继续编辑。
            </div>
            <div className="weq-dialog-foot">
              <button
                type="button"
                className="weq-action-soft"
                onClick={() => {
                  const navigate = pendingNavigation.navigate;
                  setPendingNavigation(null);
                  navigate();
                }}
              >
                暂时离开
              </button>
              <button
                type="button"
                className="weq-action-primary"
                onClick={() => {
                  setPendingNavigation(null);
                  const body = navRef.current?.parentElement?.querySelector('.weq-settings-body');
                  const save = [
                    ...(body?.querySelectorAll<HTMLButtonElement>('button') ?? []),
                  ].find((button) => !button.disabled && button.textContent?.includes('保存'));
                  const control =
                    save ?? body?.querySelector<HTMLElement>('input, textarea, select');
                  control?.scrollIntoView?.({ block: 'center' });
                  control?.focus();
                }}
              >
                先保存
              </button>
            </div>
          </div>
        </Modal>
      )}
    </DraftCloseContext.Provider>
  );
}

function ModelUsageSection(): ReactElement {
  const active = useTabActive();
  const personas = trpc.account.listAgentLabPersonas.useQuery(undefined, { enabled: active });
  const names = new Map((personas.data ?? []).map((persona) => [persona.id, persona.name]));
  return (
    <div className="weq-settings-model-usage">
      <SectionHeader title="API 用量" icon={<Activity size={16} strokeWidth={1.8} />} />
      <UsagePanel
        personaCount={names.size}
        resolveName={(id) => names.get(id) ?? '已删除的克隆'}
        hasPersona={(id) => id === '__assistant__' || names.has(id)}
      />
    </div>
  );
}

function AppearanceSection({
  page,
  heading = true,
  category = 'reading',
}: {
  page: 'theme' | 'messages';
  heading?: boolean;
  category?: 'reading' | 'display' | 'sending';
}): ReactElement {
  const active = useTabActive();
  const preference = useThemeStore((state) => state.preference);
  const accent = useThemeStore((state) => state.accent);
  const background = useThemeStore((state) => state.background);
  const setPreference = useThemeStore((state) => state.setPreference);
  const setAccent = useThemeStore((state) => state.setAccent);
  const setBackground = useThemeStore((state) => state.setBackground);

  // 业务开关复用电脑 AppSettings，主题等界面偏好走共享 clientState；本机仅保留启动快照。
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const setRenderTextMarkdown = trpc.bootstrap.setRenderTextMarkdown.useMutation();
  const setLinkPreview = trpc.bootstrap.setLinkPreview.useMutation();
  const setShowMessageUnreadBadge = trpc.bootstrap.setShowMessageUnreadBadge.useMutation();
  const setShowContactUnreadCount = trpc.bootstrap.setShowContactUnreadCount.useMutation();
  const setReadFromFirstUnread = trpc.bootstrap.setReadFromFirstUnread.useMutation();
  const setAutoFollowLatestMessages = trpc.bootstrap.setAutoFollowLatestMessages.useMutation();
  const setJumpToLatestAfterSend = trpc.bootstrap.setJumpToLatestAfterSend.useMutation();
  const setShowScrollToBottomButton = trpc.bootstrap.setShowScrollToBottomButton.useMutation();
  const setSendWithQqFont = trpc.bootstrap.setSendWithQqFont.useMutation();
  const setShowGroupAssistantMessageCount =
    trpc.bootstrap.setShowGroupAssistantMessageCount.useMutation();
  const utils = trpc.useUtils();
  const [badgeError, setBadgeError] = useState<string | null>(null);
  const [readingError, setReadingError] = useState<string | null>(null);
  const [textMarkdown, setTextMarkdown] = useState(true);
  const [linkCard, setLinkCard] = useState(true);
  const [linkShot, setLinkShot] = useState(false);

  useEffect(() => {
    const enabled = settings.data?.renderTextMarkdown;
    if (typeof enabled === 'boolean') setTextMarkdown(enabled);
  }, [settings.data?.renderTextMarkdown]);

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
      {heading && (
        <SectionHeader
          icon={
            page === 'theme' ? (
              <Palette size={16} strokeWidth={1.8} />
            ) : category === 'reading' ? (
              <BookOpen size={16} />
            ) : category === 'sending' ? (
              <Send size={16} />
            ) : (
              <Monitor size={16} />
            )
          }
          title={
            page === 'theme'
              ? '主题与背景'
              : category === 'reading'
                ? '阅读与未读'
                : category === 'sending'
                  ? '互动与防撤回'
                  : '消息显示'
          }
        />
      )}

      {page === 'theme' && (
        <>
          <div className="weq-settings-appearance-card">
            <div className="weq-settings-appearance-head">
              <div>
                <span className="weq-settings-appearance-title">
                  <span className="weq-set-card-icon" aria-hidden>
                    <Sun size={15} strokeWidth={1.8} />
                  </span>
                  <strong>基础模式</strong>
                </span>
                <span>控制浅色、深色与跟随系统</span>
              </div>
              <SettingsResetButton card="theme-mode" />
            </div>
            <ThemeModeSwitcher value={preference} onChange={setPreference} />
          </div>

          <div className="weq-settings-appearance-card">
            <div className="weq-settings-appearance-head">
              <div>
                <span className="weq-settings-appearance-title">
                  <span className="weq-set-card-icon" aria-hidden>
                    <Palette size={15} strokeWidth={1.8} />
                  </span>
                  <strong>主题色</strong>
                </span>
                <span>拖动色相条或输入色值挑选主色，界面主色、描边与按钮都会跟随</span>
              </div>
              <SettingsResetButton card="theme-accent" />
            </div>
            <ColorPicker value={accent} onChange={setAccent} />
          </div>

          <div className="weq-settings-appearance-card">
            <div className="weq-settings-appearance-head">
              <div>
                <span className="weq-settings-appearance-title">
                  <span className="weq-set-card-icon" aria-hidden>
                    <ImageIcon size={15} strokeWidth={1.8} />
                  </span>
                  <strong>界面背景</strong>
                </span>
                <span>给聊天、联系人与导出页切换不同画布质感</span>
              </div>
              <SettingsResetButton card="theme-background" />
            </div>
            <ThemeBackgroundRow value={background} onChange={setBackground} />
          </div>

          <ComponentAppearance />
        </>
      )}
      {page === 'messages' && (
        <>
          {category === 'reading' && (
            <Card title="全部会话" icon={<MessagesSquare size={15} />}>
              <Row
                settingId="all-conversations-include-hidden"
                label="包含已隐藏会话"
                control={
                  <SharedDisplayToggle
                    name="allConversationsIncludeHidden"
                    label="包含已隐藏会话"
                    fallback={false}
                  />
                }
              />
              <Row
                settingId="all-conversations-include-deleted"
                label="包含已删除会话"
                control={
                  <SharedDisplayToggle
                    name="allConversationsIncludeDeleted"
                    label="包含已删除会话"
                    fallback={false}
                  />
                }
              />
            </Card>
          )}
          {category === 'reading' && (
            <Card title="未读显示" icon={<Bell size={15} strokeWidth={1.8} />}>
              <Row
                settingId="message-unread-badge"
                label="在消息图标上显示红点"
                control={
                  <Toggle
                    checked={settings.data?.showMessageUnreadBadge ?? true}
                    disabled={!settings.data || setShowMessageUnreadBadge.isLoading}
                    onChange={(enabled) => {
                      setBadgeError(null);
                      setShowMessageUnreadBadge.mutate(
                        { enabled },
                        {
                          onSuccess: () => void utils.bootstrap.getSettings.invalidate(),
                          onError: (error) => setBadgeError(error.message),
                        },
                      );
                    }}
                    label="在消息图标上显示红点"
                  />
                }
              />
              {badgeError ? <p role="alert">{badgeError}</p> : null}
              {[
                {
                  key: 'showContactUnreadCount' as const,
                  settingId: 'contact-unread-count',
                  label: '在联系人界面显示未读消息数',
                  mutation: setShowContactUnreadCount,
                },
                {
                  key: 'showGroupAssistantMessageCount' as const,
                  settingId: 'group-assistant-count',
                  label: '群助手显示总消息数',
                  mutation: setShowGroupAssistantMessageCount,
                },
              ].map(({ key, settingId, label, mutation }) => (
                <Row
                  key={key}
                  settingId={settingId}
                  label={label}
                  control={
                    <Toggle
                      checked={settings.data?.[key] ?? false}
                      disabled={!settings.data || mutation.isLoading}
                      onChange={(enabled) => {
                        setReadingError(null);
                        mutation.mutate(
                          { enabled },
                          {
                            onSuccess: () => void utils.bootstrap.getSettings.invalidate(),
                            onError: (error) => setReadingError(error.message),
                          },
                        );
                      }}
                      label={label}
                    />
                  }
                />
              ))}
              <AccountBasicsSection page="read" heading={false} />
            </Card>
          )}
          {(category === 'reading' || category === 'sending') && (
            <Card
              title={category === 'reading' ? '阅读与定位' : '发送消息'}
              icon={
                category === 'reading' ? (
                  <BookOpen size={15} strokeWidth={1.8} />
                ) : (
                  <Send size={15} strokeWidth={1.8} />
                )
              }
            >
              {category === 'reading' ? (
                <Row
                  settingId="keep-conversation-position-on-hover"
                  label="鼠标停留时保持会话位置"
                  desc="鼠标位于会话列表内时，新消息仍正常更新，但不调整会话顺序；移出并关闭菜单后恢复排序。"
                  control={
                    <SharedDisplayToggle
                      name="keepConversationPositionOnHover"
                      label="鼠标停留时保持会话位置"
                      fallback={false}
                    />
                  }
                />
              ) : null}
              {[
                {
                  key: 'readFromFirstUnread' as const,
                  settingId: 'read-first-unread',
                  label: '从第一条新消息开始阅读',
                  fallback: false,
                  mutation: setReadFromFirstUnread,
                },
                {
                  key: 'autoFollowLatestMessages' as const,
                  settingId: 'auto-follow-latest-messages',
                  label: '自动跟随最新消息',
                  fallback: true,
                  mutation: setAutoFollowLatestMessages,
                },
                {
                  key: 'jumpToLatestAfterSend' as const,
                  settingId: 'jump-latest-after-send',
                  label: '发送消息后定位到最新消息',
                  fallback: true,
                  mutation: setJumpToLatestAfterSend,
                },
                {
                  key: 'showScrollToBottomButton' as const,
                  settingId: 'scroll-to-bottom-button',
                  label: '向下滚动时显示定位到底部按钮',
                  fallback: true,
                  mutation: setShowScrollToBottomButton,
                },
                {
                  key: 'sendWithQqFont' as const,
                  settingId: 'send-with-qq-font',
                  label: '使用 QQ 账号设置的个性字体发送消息',
                  fallback: true,
                  mutation: setSendWithQqFont,
                },
              ]
                .filter(({ key }) => (key === 'sendWithQqFont') === (category === 'sending'))
                .map(({ key, settingId, label, fallback, mutation }) => (
                  <Row
                    key={key}
                    settingId={settingId}
                    label={label}
                    control={
                      <Toggle
                        checked={settings.data?.[key] ?? fallback}
                        disabled={!settings.data || mutation.isLoading}
                        onChange={(enabled) => {
                          setReadingError(null);
                          mutation.mutate(
                            { enabled },
                            {
                              onSuccess: () => void utils.bootstrap.getSettings.invalidate(),
                              onError: (error) => setReadingError(error.message),
                            },
                          );
                        }}
                        label={label}
                      />
                    }
                  />
                ))}
            </Card>
          )}
          {readingError ? <p role="alert">{readingError}</p> : null}
          {category === 'display' && (
            <>
              <Card
                title="时间与序号"
                icon={<Clock size={15} strokeWidth={1.8} />}
                settingId="custom-message-display"
              >
                <Row
                  settingId="message-seq"
                  label="显示消息序号（seq）"
                  control={
                    <SharedDisplayToggle
                      name="showMessageSeq"
                      fallback={settings.data?.showMessageSeq ?? false}
                      disabled={!settings.data}
                      label="显示消息序号（seq）"
                    />
                  }
                />
                <Row
                  settingId="message-date"
                  label="显示发送日期"
                  control={
                    <SharedDisplayToggle
                      name="showMessageDate"
                      fallback={settings.data?.showMessageDate ?? false}
                      disabled={!settings.data}
                      label="显示发送日期"
                    />
                  }
                />
                <Row
                  settingId="message-time"
                  label="显示发送时间"
                  control={
                    <SharedDisplayToggle
                      name="showMessageTime"
                      fallback={settings.data?.showMessageTime ?? false}
                      disabled={!settings.data}
                      label="显示发送时间"
                    />
                  }
                />
              </Card>
              <Card title="头像与装扮" icon={<Smile size={15} strokeWidth={1.8} />}>
                {[
                  {
                    key: 'showAvatarPendant' as const,
                    settingId: 'avatar-pendant',
                    label: '聊天头像挂件',
                  },
                  {
                    key: 'showMessageBubble' as const,
                    settingId: 'message-bubble',
                    label: '消息气泡',
                  },
                  {
                    key: 'showMessageFont' as const,
                    settingId: 'message-font',
                    label: '消息字体',
                  },
                ].map(({ key, settingId, label }) => (
                  <Row
                    key={key}
                    settingId={settingId}
                    label={label}
                    control={
                      <SharedDisplayToggle
                        name={key}
                        fallback={
                          settings.data?.[key] ??
                          (key === 'showAvatarPendant'
                            ? true
                            : (settings.data?.showMsgDecoration ?? true))
                        }
                        disabled={!settings.data}
                        label={label}
                      />
                    }
                  />
                ))}
                <QqShowSettings />
              </Card>
              <Card title="文本与链接" icon={<ScrollText size={15} strokeWidth={1.8} />}>
                <Row
                  settingId="text-markdown"
                  label="纯文本消息自动渲染为 Markdown"
                  desc={
                    <>
                      把普通文本消息里的 # 标题、**加粗**、代码块等语法渲染成富文本。这是 WeQ
                      自己的功能，关闭后默认显示原文，仍可右键手动选择「显示
                      Markdown」。单条消息的手动选择优先，QQ 原生 Markdown 消息不受影响。
                    </>
                  }
                  control={
                    <Toggle
                      checked={textMarkdown}
                      disabled={settings.isLoading || setRenderTextMarkdown.isLoading}
                      onChange={(next) => void onSetTextMarkdown(next)}
                      label="纯文本消息自动渲染为 Markdown"
                    />
                  }
                />
                <Row
                  settingId="link-preview"
                  label="链接预览卡片"
                  desc={
                    <>
                      一条消息只有一个链接时，抓取网页标题、简介和封面渲染成卡片。会按链接访问
                      对应网页（结果本地缓存），关掉后链接仍标蓝可点，但完全不出网。
                    </>
                  }
                  control={
                    <Toggle
                      checked={linkCard}
                      disabled={settings.isLoading || setLinkPreview.isLoading}
                      onChange={(next) => void onSetLinkCard(next)}
                      label="链接预览卡片"
                    />
                  }
                />
                <Row
                  settingId="link-screenshot"
                  label="无封面时网页截图"
                  desc={
                    <>
                      网页没提供封面图时，在一个隔离的后台窗口里把它打开并截取首屏当封面。这会
                      真正运行对方页面的脚本（沙盒内、不落盘、退出即清），默认关闭。
                    </>
                  }
                  control={
                    <Toggle
                      checked={linkShot}
                      disabled={!linkCard || settings.isLoading || setLinkPreview.isLoading}
                      onChange={(next) => void onSetLinkShot(next)}
                      label="无封面时网页截图"
                    />
                  }
                />
              </Card>
              <Card title="语音消息" icon={<AudioLines size={15} strokeWidth={1.8} />}>
                <VoiceAutoTranscribeSetting />
              </Card>
              <ChatImageCacheSettings />
            </>
          )}
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
