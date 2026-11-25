/**
 * 设置整页。
 *
 * 左侧按设置目录分组；旧页面与条目入口统一解析到规范位置。
 */

import { ReminderDot } from './ReminderBadge';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  ArrowLeft,
  Bell,
  BookOpen,
  Check,
  ChevronRight,
  CloudDownload,
  Code2,
  FileText,
  ImageIcon,
  Monitor,
  MessagesSquare,
  Moon,
  Palette,
  Radio,
  Smile,
  Sun,
  X,
} from 'lucide-react';
import { GlobalSettingsSection } from './settings/GlobalSettingsSection';
import { DataSaverSettings } from './settings/DataSaverSettings';
import { HelpSection } from './settings/HelpSection';
import { VersionSection } from './settings/VersionSection';
import { QzoneSettingsSection } from './settings/QzoneSettingsSection';
import { CallRecordingSection, CallUdpTraceSettings } from './settings/CallRecordingSection';
import { MailSettingsSection } from './settings/MailSettingsSection';
import { PrivacySection } from './settings/PrivacySection';
import { TypingStatusSettingsCard } from './settings/TypingStatusSettingsCard';
import { QqStatusReminderSettings } from './settings/QqStatusReminderSettings';
import { AccountBasicsSection } from './settings/AccountBasicsSection';
import { LongTermAuthorizationSection } from './settings/LongTermAuthorizationSection';
import { ComponentAppearance } from './settings/ComponentAppearance';
import { WindowAppearanceCard } from './settings/WindowAppearanceCard';
import { DesktopOnly } from '../lib/target';
import { SegmentedControl } from './SegmentedControl';
import { AgentLabSection } from './settings/AgentLabSection';
import { IntentSenseSection } from './settings/IntentSenseSection';
import { InteractionProfileSection } from './settings/InteractionProfileSection';
import { WeqAssistantSettingsSection } from '../views/agentlab/AssistantSettingsPanel';
import { ReplySuggestionsSection } from './settings/ReplySuggestionsSection';
import { TtsProvidersCard } from './settings/VoiceTranscribeSection';
import { RecognitionSettingsSection } from './settings/RecognitionSettingsSection';
import { EnhancementPacksSection } from './settings/EnhancementPacksSection';
import { McpServerSection } from './settings/McpServerSection';
import { OneBotSection } from './settings/OneBotSection';
import { RemoteSection } from './settings/RemoteSection';
import { BackupSection } from './settings/BackupSection';
import { ExternalRkeySection } from './settings/ExternalRkeySection';
import { SsePushSection } from './settings/SsePushSection';
import { AssistantSection } from './settings/AssistantSection';
import { StartupSection } from './settings/StartupSection';
import { HomeSettingsSection } from './settings/HomeSettingsSection';
import { DataMaintenanceSection, type MaintenanceTool } from './settings/DataMaintenanceSection';
import { DatabaseManagementSection } from './settings/DatabaseManagementSection';
import { ResourceManagementSection } from './settings/ResourceManagementSection';
import { MissingMessageSettings } from './settings/MissingMessageSettings';
import { ChatJumpSettings, ReadingPositionJumpSetting } from './settings/ChatJumpSettings';
import { SlashEmojiSettings } from './settings/SlashEmojiSettings';
import { VoiceAutoTranscribeSetting } from './settings/VoiceAutoTranscribeSetting';
import { MessageDisplayOptions } from './settings/MessageDisplayOptions';
import { Card, Row, SectionHeader, Toggle } from './settings/controls';
import { SettingsNavigateContext, SettingsScopeContext } from './settings/controls.shared';
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
import { RetainedTabs, TabActivity } from './RetainedTabs';
import { useTabActive } from './RetainedTabs.shared';
import { PageSnapshotsFallback } from './PageSnapshots';
import { usePageSnapshotKey, usePageSnapshotReset, usePageState } from './PageSnapshots.shared';
import { pageSnapshots } from '../lib/pageSnapshots';
import { DraftCloseContext, useDraftClose } from '../lib/draftClose';
import { useToastApi } from './Toast.shared';
import { SettingsNotificationSource } from '../lib/notificationNavigation';
import { Modal } from './Dialog';
import type { SettingsNavigation } from '../hooks/useSettingsNavigation';
import { z } from 'zod/v3';
import { RetainedSettingsPage } from './settings/RetainedSettingsPage';
import LogPerformanceSettings from './settings/LogPerformanceSettings';
import { useAppLock } from '../state/lock';
import {
  SETTINGS_GROUPS,
  SETTINGS_PAGE_LABELS,
  resolveSettingsTarget,
  settingsScopeFor,
  type SectionId,
  type SettingsPageId,
} from './settings/navigation';
export type { SectionId } from './settings/navigation';
import { useThemeStore, type ThemeBackground, type ThemePreference } from '../state/theme';
import { SharedDisplayToggle } from './settings/SharedDisplayToggle';
import { useEnhancementUpdateBadge } from '../lib/unreadMarkers';
import {
  BadgeSettingRow,
  ConversationListBadgeRows,
  UnreadBadgeSettings,
} from './settings/UnreadBadgeSettings';
import { flushSettingsSaves, hasPendingSettingsSaves } from '../lib/settingsSaveQueue';
import { ContactCardSettings } from './settings/ContactCardSettings';
import { useRemoteClient } from '../lib/remoteClient';
import { useMobileWebLayout } from '../hooks/useMobileWebViewport';
import { remoteSettingAvailable } from '../../../shared/remote_capabilities';
import { SettingsPageIcon } from './settings/pageIcons';

const SETTINGS_PAGE_RENDERERS: Record<
  SettingsPageId,
  (onOpenMaintenance: (tool: MaintenanceTool) => void) => ReactNode
> = {
  startup: () => <StartupSection />,
  appearance: () => <AppearanceSection page="appearance" />,
  home: () => <HomeSettingsSection />,
  global: () => <GlobalSettingsSection />,
  'notification-badges': () => <UnreadBadgeSettings />,
  privacy: () => <PrivacySection />,
  'chat-messages': () => <AppearanceSection page="chat-messages" />,
  'message-display': () => <AppearanceSection page="message-display" />,
  'message-content': () => <AppearanceSection page="message-content" />,
  'chat-interaction': () => <AppearanceSection page="chat-interaction" />,
  'anti-recall': () => (
    <div className="weq-set">
      <SectionHeader title={SETTINGS_PAGE_LABELS['anti-recall']} page="anti-recall" />
    </div>
  ),
  'contact-card': () => <ContactCardSettings />,
  'call-recording': () => <CallRecordingSection />,
  qzone: () => <QzoneSettingsSection />,
  mail: () => <MailSettingsSection />,
  'enhancement-packs': () => <EnhancementPacksSection />,
  recognition: () => <RecognitionSettingsSection />,
  'weq-assistant': () => <WeqAssistantSettingsSection />,
  'reply-suggestions': () => <ReplySuggestionsSection />,
  'intent-sense': () => <IntentSenseSection />,
  'interaction-profile': () => <InteractionProfileSection />,
  agentlab: () => (
    <>
      <AgentLabSection />
      <div className="weq-set">
        <TtsProvidersCard />
      </div>
    </>
  ),
  'model-usage': () => <ModelUsageSection />,
  account: () => <AccountBasicsSection />,
  'qq-proxy': () => <AccountBasicsSection page="qq-proxy" />,
  'qq-status-reminders': () => <QqStatusReminderSettings />,
  'long-term-authorization': () => (
    <div className="weq-set">
      <SectionHeader
        page="long-term-authorization"
        title={SETTINGS_PAGE_LABELS['long-term-authorization']}
      />
      <LongTermAuthorizationSection />
    </div>
  ),
  credentials: (onOpen) => (
    <AccountBasicsSection
      page="credentials"
      databaseKeyTools={
        <DataMaintenanceSection
          title={null}
          onOpen={onOpen}
          tools={['key-scan', 'other-device-key']}
        />
      }
    />
  ),
  'qq-accounts': () => (
    <div className="weq-set">
      <SectionHeader title={SETTINGS_PAGE_LABELS['qq-accounts']} page="qq-accounts" />
      <div data-setting-id="qq-accounts">
        <LoginAccountPanel />
      </div>
    </div>
  ),
  accounts: () => <GlobalSettingsSection section="accounts" />,
  remote: () => <RemoteSection />,
  mcp: () => <McpServerSection />,
  onebot: () => <OneBotSection />,
  sse: () => <SsePushSection />,
  assistant: () => <AssistantSection />,
  'resource-loading': () => (
    <>
      <GlobalSettingsSection section="network" />
      <AccountBasicsSection page="media" heading={false} />
      <ExternalRkeySection />
    </>
  ),
  'data-saver': () => (
    <div className="weq-set">
      <SectionHeader title={SETTINGS_PAGE_LABELS['data-saver']} page="data-saver" />
      <DataSaverSettings />
    </div>
  ),
  'qq-storage': () => <ResourceManagementSection />,
  'weq-storage': () => (
    <>
      <div className="weq-set">
        <SectionHeader title="WeQ 存储管理" page="weq-storage" />
      </div>
      <GlobalSettingsSection section="storage" heading={false} />
    </>
  ),
  'database-management': (onOpen) => <DatabaseManagementSection onOpen={onOpen} />,
  backup: () => <BackupSection />,
  diagnostics: (onOpen) => <DiagnosticsSettingsSection onOpen={onOpen} />,
  logs: () => <LogPerformanceSettings />,
  version: () => <VersionSection />,
  faq: () => <HelpSection page="faq" />,
  feedback: () => <HelpSection page="feedback" />,
};

const DEFAULT_SETTINGS_PAGE = SETTINGS_GROUPS[0]!.sections[0]!;

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
  const notificationToast = useToastApi();
  const remote = useRemoteClient();
  const target = useMemo(
    () =>
      resolveSettingsTarget(searchTarget ?? { section: initialSection ?? DEFAULT_SETTINGS_PAGE }),
    [initialSection, searchTarget],
  );
  const [linkedTarget, setLinkedTarget] = useState<SettingsSearchTarget | null>(null);
  useEffect(() => setLinkedTarget(null), [initialSection, searchTarget]);
  const [activeId, setActiveId] = usePageState<SettingsPageId>(
    'settings:active',
    () => target.section,
    z.custom<SettingsPageId>(
      (value) => typeof value === 'string' && Object.hasOwn(SETTINGS_PAGE_RENDERERS, value),
    ),
  );
  const packUpdate = useEnhancementUpdateBadge();
  const locked = useAppLock((state) => state.locked);
  const singleColumn = useMobileWebLayout();
  const [nav, setNav] = useState<HTMLElement | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(Boolean(initialSection || searchTarget));
  const activePage = remote && !remoteSettingAvailable(activeId) ? DEFAULT_SETTINGS_PAGE : activeId;
  const snapshots = usePageSnapshotReset('workspace:main:设置');
  const activeKey = usePageSnapshotKey('settings:active');
  useEffect(() => {
    if (!open || !activeKey) return;
    try {
      pageSnapshots.write(activeKey, activeId);
    } catch {
      notificationToast.push({ tone: 'error', title: '设置页面位置保存失败' });
    }
  }, [open, activeKey, activeId, notificationToast]);
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
      if (remote && !remoteSettingAvailable(section)) section = DEFAULT_SETTINGS_PAGE;
      if (section === activeId) {
        setMobileDetailOpen(true);
        return;
      }
      requestNavigation(() => {
        setActiveId(section);
        setMobileDetailOpen(true);
      });
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
    Boolean(nav) && open && !closing && singleColumn && mobileDetailOpen,
    () => requestNavigation(() => setMobileDetailOpen(false)),
    30,
    () => nav?.parentElement ?? null,
  );
  useEffect(() => {
    if (!closing) return;
    // 子页先卸载并写回滚动快照，再统一清除，避免关闭后旧位置重新写入。
    try {
      snapshots.reset();
    } catch {
      notificationToast.push({
        tone: 'error',
        title: '设置页面状态清除失败',
        detail: '请检查本机存储后重试。',
      });
      setClosing(false);
      return;
    }
    setActiveId(DEFAULT_SETTINGS_PAGE);
    setMobileDetailOpen(false);
    onClose();
    setClosing(false);
  }, [closing, snapshots, setActiveId, onClose, notificationToast]);
  useEffect(() => {
    guard.drafts.add(snapshotDraft);
    return () => {
      guard.drafts.delete(snapshotDraft);
    };
  }, [guard.drafts, snapshotDraft]);

  useEffect(() => {
    if (!open) return;
    if (initialSection || searchTarget) switchSectionRef.current(target.section);
    else setMobileDetailOpen(false);
  }, [open, initialSection, searchTarget, target]);

  useEffect(() => {
    // 多栏始终显示当前详情，回到单栏时继续显示同一页。
    if (open && !closing && !singleColumn && !mobileDetailOpen) setMobileDetailOpen(true);
  }, [open, closing, singleColumn, mobileDetailOpen]);

  useEffect(() => {
    if (open && (!singleColumn || !mobileDetailOpen)) {
      nav
        ?.querySelector<HTMLElement>('.weq-settings-nav-item.is-active')
        ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  }, [nav, open, activePage, mobileDetailOpen, singleColumn]);

  if (!open || closing) return null;

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
          data-mobile-detail={mobileDetailOpen || undefined}
          role="region"
          aria-label="设置"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <header className="weq-mobile-settings-header">
            <button
              type="button"
              aria-label={mobileDetailOpen ? '返回设置' : '返回'}
              title={mobileDetailOpen ? '返回设置' : '返回'}
              onClick={() =>
                mobileDetailOpen
                  ? requestNavigation(() => setMobileDetailOpen(false))
                  : mobileBack() || requestNavigation(onClose)
              }
            >
              <ArrowLeft size={22} />
            </button>
            <strong>设置</strong>
          </header>
          <nav ref={setNav} className="weq-settings-nav" aria-label="设置页面">
            <h2 className="weq-settings-nav-title">设置</h2>
            <div className="weq-settings-nav-groups">
              {SETTINGS_GROUPS.map(({ id, label, sections }) => {
                const pages = remote
                  ? sections.filter((page) => remoteSettingAvailable(page))
                  : sections;
                if (!pages.length) return null;
                return (
                  <div className="weq-settings-nav-group" key={id}>
                    <h3 className="weq-settings-nav-group-title">{label}</h3>
                    <ul aria-label={label}>
                      {pages.map((page) => (
                        <li key={page}>
                          <button
                            type="button"
                            className={`weq-settings-nav-item${page === activePage ? ' is-active' : ''}`}
                            aria-current={page === activePage ? 'page' : undefined}
                            onClick={() => switchSection(page)}
                          >
                            <span className="weq-settings-nav-icon" aria-hidden="true">
                              <SettingsPageIcon page={page} />
                            </span>
                            <span className="weq-settings-nav-label">
                              {SETTINGS_PAGE_LABELS[page]}
                              {packUpdate && page === 'enhancement-packs' ? (
                                <ReminderDot
                                  className="weq-settings-update-mark"
                                  aria-label="有增强包更新"
                                />
                              ) : null}
                            </span>
                            <ChevronRight
                              className="weq-mobile-settings-chevron"
                              size={18}
                              aria-hidden
                            />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </nav>
          <div className="weq-settings-pages">
            <TabActivity active={!locked}>
              <PageSnapshotsFallback scope="bootstrap-settings">
                <RetainedTabs snapshotKey="settings" activeKey={activePage}>
                  <RetainedSettingsPage
                    pageId={activePage}
                    target={linkedTarget ? resolveSettingsTarget(linkedTarget) : target}
                    revision={linkedTarget?.revision ?? searchTarget?.revision}
                    recordId={linkedTarget?.recordId ?? searchTarget?.recordId}
                  >
                    <SettingsNotificationSource section={activePage}>
                      <SettingsScopeContext.Provider value={settingsScopeFor(activePage)}>
                        <SettingsNavigateContext.Provider
                          value={(section, settingId) => {
                            const next = resolveSettingsTarget({
                              section: section as SectionId,
                              settingId,
                            });
                            requestNavigation(() => {
                              setLinkedTarget({ ...next, revision: Date.now() });
                              setActiveId(next.section);
                              setMobileDetailOpen(true);
                            });
                          }}
                        >
                          {activePage === 'anti-recall' ? (
                            <>
                              {SETTINGS_PAGE_RENDERERS[activePage](onOpenMaintenance)}
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
                          ) : activePage === 'global' ? (
                            <GlobalSettingsSection
                              notificationTarget={linkedTarget ?? searchTarget}
                              recallNotifications={
                                <AntiRecallDialog
                                  embedded
                                  section="notifications"
                                  onClose={() => {}}
                                  onOpenRecalls={onOpenRecalls}
                                  isCurrentSource={isCurrentSource}
                                  notificationConversation={searchTarget?.conversation}
                                  notificationRevision={searchTarget?.revision}
                                />
                              }
                            />
                          ) : (
                            SETTINGS_PAGE_RENDERERS[activePage](onOpenMaintenance)
                          )}
                        </SettingsNavigateContext.Provider>
                      </SettingsScopeContext.Provider>
                    </SettingsNotificationSource>
                  </RetainedSettingsPage>
                </RetainedTabs>
              </PageSnapshotsFallback>
            </TabActivity>
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
                  const body = nav?.parentElement?.querySelector('.weq-settings-body');
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

function DiagnosticsSettingsSection({
  onOpen,
}: {
  onOpen: (tool: MaintenanceTool) => void;
}): ReactElement {
  const remote = useRemoteClient();
  return (
    <div className="weq-set">
      <SectionHeader title="QQ 高级工具" page="diagnostics" pageReset={!remote} />
      <Card
        title="QQNT 抓包"
        icon={<Radio size={15} />}
        action={
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft"
            data-setting-id="qqnt-capture"
            onClick={() => onOpen('capture')}
          >
            打开抓包
            <ArrowUpRight size={14} aria-hidden />
          </button>
        }
      />
      <CallUdpTraceSettings />
      <SignerStatusCard />
      <Card
        title="Protobuf / JCE 逆向"
        icon={<Code2 size={15} strokeWidth={1.8} />}
        settingId="reverse-tool"
      >
        <ReverseTool />
      </Card>
    </div>
  );
}

function ModelUsageSection(): ReactElement {
  return (
    <div className="weq-set weq-settings-model-usage">
      <SectionHeader title="API 用量" page="model-usage" />
      <UsagePanel />
    </div>
  );
}

function AppearanceSection({
  page,
}: {
  page: 'appearance' | 'chat-messages' | 'message-display' | 'message-content' | 'chat-interaction';
}): ReactElement {
  const active = useTabActive();
  const preference = useThemeStore((state) => state.preference);
  const accent = useThemeStore((state) => state.accent);
  const nativeAccentSettings = useThemeStore((state) => state.nativeAccentSettings);
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
  const setReadFromFirstUnread = trpc.bootstrap.setReadFromFirstUnread.useMutation();
  const setPreserveUnreadUntilRead = trpc.bootstrap.setPreserveUnreadUntilRead.useMutation();
  const setAutoFollowLatestMessages = trpc.bootstrap.setAutoFollowLatestMessages.useMutation();
  const setJumpToLatestAfterSend = trpc.bootstrap.setJumpToLatestAfterSend.useMutation();
  const setShowScrollToBottomButton = trpc.bootstrap.setShowScrollToBottomButton.useMutation();
  const utils = trpc.useUtils();
  const [readingError, setReadingError] = useState<string | null>(null);
  const [textMarkdown, setTextMarkdown] = useState(false);
  const [linkPreview, setLinkPreviewDraft] = useState(
    () => settings.data?.linkPreview ?? { enabled: true, autoFetch: false, screenshot: false },
  );

  useEffect(() => {
    const enabled = settings.data?.renderTextMarkdown;
    if (typeof enabled === 'boolean') setTextMarkdown(enabled);
  }, [settings.data?.renderTextMarkdown]);

  useEffect(() => {
    const cfg = settings.data?.linkPreview;
    if (cfg) setLinkPreviewDraft(cfg);
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

  async function onSetLinkPreview(patch: Partial<typeof linkPreview>): Promise<void> {
    const prev = linkPreview;
    setLinkPreviewDraft({ ...prev, ...patch });
    try {
      await setLinkPreview.mutateAsync(patch);
    } catch {
      setLinkPreviewDraft(prev);
    }
    await settings.refetch();
  }

  const automaticReadingPosition = Boolean(settings.data?.readFromFirstUnread);

  function readingToggle(
    key:
      | 'readFromFirstUnread'
      | 'preserveUnreadUntilRead'
      | 'autoFollowLatestMessages'
      | 'jumpToLatestAfterSend'
      | 'showScrollToBottomButton',
    settingId: string,
    label: string,
    mutation: typeof setReadFromFirstUnread,
    options: { desc?: string; indent?: boolean; fallbackTarget?: string } = {},
  ) {
    return (
      <Row
        settingId={settingId}
        label={label}
        desc={options.desc}
        indent={options.indent}
        control={
          <span data-setting-fallback={options.fallbackTarget}>
            <Toggle
              checked={settings.data?.[key] ?? key !== 'readFromFirstUnread'}
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
          </span>
        }
      />
    );
  }

  return (
    <section className="weq-settings-section">
      <SectionHeader page={page} title={SETTINGS_PAGE_LABELS[page]} />

      {page === 'appearance' && (
        <>
          <DesktopOnly>
            <WindowAppearanceCard />
          </DesktopOnly>

          <Card
            desc="控制浅色、深色与跟随系统"
            icon={<Sun size={15} strokeWidth={1.8} />}
            resetId="theme-mode"
          >
            <ThemeModeSwitcher value={preference} onChange={setPreference} />
          </Card>

          <Card
            title="主题色"
            desc={
              nativeAccentSettings
                ? undefined
                : '色相决定颜色，明度决定深浅；界面主色、描边与按钮都会跟随'
            }
            icon={<Palette size={15} strokeWidth={1.8} />}
            resetId={nativeAccentSettings ? undefined : 'theme-accent'}
          >
            {nativeAccentSettings ? (
              <button
                type="button"
                className="weq-set-btn"
                onClick={() => window.weqRemoteShell?.openMenu()}
              >
                Remote 主题色设置
              </button>
            ) : (
              <ColorPicker value={accent} onChange={setAccent} />
            )}
          </Card>

          <Card
            title="界面背景"
            desc="给聊天、联系人与导出页切换不同画布质感"
            icon={<ImageIcon size={15} strokeWidth={1.8} />}
            resetId="theme-background"
          >
            <ThemeBackgroundRow value={background} onChange={setBackground} />
          </Card>

          <ComponentAppearance />
        </>
      )}
      {page !== 'appearance' && (
        <>
          {page === 'chat-messages' && (
            <Card
              title="会话预览"
              icon={<MessagesSquare size={15} />}
              resetId="conversation-preview"
            >
              <Row
                settingId="show-conversation-preview"
                control={
                  <SharedDisplayToggle
                    name="showConversationPreview"
                    label="显示会话预览"
                    fallback={true}
                  />
                }
              />
              <BadgeSettingRow
                name="showImportantMessageMarkers"
                settingId="important-message-markers"
                label="重要消息标记"
                fallback={true}
              />
            </Card>
          )}
          {page === 'chat-messages' && (
            <Card title="列表行为" icon={<MessagesSquare size={15} />} resetId="conversation-order">
              <Row
                settingId="keep-conversation-position-on-hover"
                desc="鼠标位于会话列表内时，新消息仍正常更新，但不调整会话顺序；移出并关闭菜单后恢复排序。"
                control={
                  <SharedDisplayToggle
                    name="keepConversationPositionOnHover"
                    label="鼠标停留时保持会话位置"
                    fallback={false}
                  />
                }
              />
              <Row
                settingId="close-conversation-outside-view"
                control={
                  <SharedDisplayToggle
                    name="closeConversationOutsideView"
                    label="切换视图时关闭不在新视图中的会话"
                    fallback={false}
                  />
                }
              />
            </Card>
          )}
          {page === 'chat-messages' && (
            <Card title="常规视图未读角标" icon={<Bell size={15} />} resetId="conversation-markers">
              <ConversationListBadgeRows />
            </Card>
          )}
          {page === 'chat-messages' && (
            <Card
              title="全部会话视图"
              icon={<MessagesSquare size={15} />}
              resetId="conversation-scope"
            >
              <Row
                settingId="all-conversations-include-hidden"
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
          {page === 'message-display' && (
            <>
              <Card resetId="reading" icon={<BookOpen size={15} strokeWidth={1.8} />}>
                {readingToggle(
                  'readFromFirstUnread',
                  'read-first-unread',
                  '打开会话时继续上次阅读',
                  setReadFromFirstUnread,
                  {
                    desc: '没有上次阅读位置时，显示最新消息。',
                    fallbackTarget: automaticReadingPosition
                      ? 'show-reading-position-button'
                      : 'preserve-unread-until-read',
                  },
                )}
                {automaticReadingPosition ? (
                  readingToggle(
                    'preserveUnreadUntilRead',
                    'preserve-unread-until-read',
                    '按阅读进度更新未读数',
                    setPreserveUnreadUntilRead,
                    {
                      desc: '跳过的消息仍保留为未读。',
                      indent: true,
                    },
                  )
                ) : (
                  <ReadingPositionJumpSetting />
                )}
              </Card>
              <Card
                resetId="unread-jumps"
                icon={<Bell size={15} />}
                desc="仅首次提示：切回会话时不再提示原来的目标，新目标仍会提示。"
              >
                <Row
                  settingId="unread-divider"
                  desc="在聊天时间线标出「以下为未读消息」。"
                  control={<SharedDisplayToggle name="showUnreadDivider" label="显示未读分界线" />}
                />
                <ChatJumpSettings />
              </Card>
              <Card resetId="message-browsing" icon={<MessagesSquare size={15} />}>
                {readingToggle(
                  'autoFollowLatestMessages',
                  'auto-follow-latest-messages',
                  '在底部时跟随新消息',
                  setAutoFollowLatestMessages,
                )}
                {readingToggle(
                  'jumpToLatestAfterSend',
                  'jump-latest-after-send',
                  '发送后回到最新消息',
                  setJumpToLatestAfterSend,
                )}
                {readingToggle(
                  'showScrollToBottomButton',
                  'scroll-to-bottom-button',
                  '向下浏览时显示「回到最新」按钮',
                  setShowScrollToBottomButton,
                  {
                    desc: '关闭不影响新消息提醒。',
                  },
                )}
              </Card>
              {readingError ? <p role="alert">{readingError}</p> : null}
              <Card resetId="missing-messages" icon={<CloudDownload size={15} />}>
                <MissingMessageSettings />
              </Card>
            </>
          )}
          {page === 'chat-interaction' && (
            <Card title="表情输入" icon={<Smile size={15} />} resetId="emoji-shortcuts">
              <SlashEmojiSettings />
            </Card>
          )}
          {page === 'chat-interaction' && <TypingStatusSettingsCard />}
          {page === 'chat-interaction' && (
            <Card resetId="quote-replies" icon={<MessagesSquare size={15} />}>
              <Row
                settingId="swipe-to-quote"
                desc="在触屏上向左滑动消息，松手后引用该消息并聚焦输入框。"
                control={<SharedDisplayToggle name="swipeToQuote" label="左滑引用消息" />}
              />
              <Row
                settingId="quote-auto-mention"
                control={
                  <SharedDisplayToggle
                    name="autoMentionOnQuote"
                    label="群聊引用时自动 @ 对方"
                    fallback={false}
                  />
                }
              />
              <Row
                settingId="quote-backspace-remove"
                control={
                  <SharedDisplayToggle
                    name="backspaceRemovesQuote"
                    label="按退格键移除引用"
                    fallback={true}
                  />
                }
              />
            </Card>
          )}
          {page === 'message-content' && (
            <>
              <MessageDisplayOptions />
              <Card title="正文与预览" icon={<FileText size={15} />}>
                <VoiceAutoTranscribeSetting />
                <Row
                  settingId="text-markdown"
                  label="文本消息自动渲染为 Markdown"
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
                      label="文本消息自动渲染为 Markdown"
                    />
                  }
                />
                <Row
                  settingId="link-preview"
                  desc="一条消息只有一个链接时，显示 QQ 已提供或本地已缓存的预览。关闭后，链接仍可点击。"
                  control={
                    <span
                      data-setting-fallback={
                        !linkPreview.enabled ? 'link-preview-auto-fetch link-screenshot' : undefined
                      }
                    >
                      <Toggle
                        checked={linkPreview.enabled}
                        disabled={settings.isLoading || setLinkPreview.isLoading}
                        onChange={(enabled) => void onSetLinkPreview({ enabled })}
                        label="链接预览卡片"
                      />
                    </span>
                  }
                />
                {linkPreview.enabled ? (
                  <Row
                    settingId="link-preview-auto-fetch"
                    indent
                    desc="允许在浏览消息时访问链接或封面地址，补齐本地缺失的标题、简介和图片。"
                    control={
                      <span
                        data-setting-fallback={
                          !linkPreview.autoFetch ? 'link-screenshot' : undefined
                        }
                      >
                        <Toggle
                          checked={linkPreview.autoFetch}
                          disabled={settings.isLoading || setLinkPreview.isLoading}
                          onChange={(autoFetch) => void onSetLinkPreview({ autoFetch })}
                          label="自动联网补全链接预览"
                        />
                      </span>
                    }
                  />
                ) : null}
                {linkPreview.enabled && linkPreview.autoFetch ? (
                  <Row
                    settingId="link-screenshot"
                    indent
                    desc="联网补全时，如果网页没有封面图，可在隔离窗口中打开网页并截取首屏。"
                    control={
                      <Toggle
                        checked={linkPreview.screenshot}
                        disabled={settings.isLoading || setLinkPreview.isLoading}
                        onChange={(screenshot) => void onSetLinkPreview({ screenshot })}
                        label="无封面时网页截图"
                      />
                    }
                  />
                ) : null}
              </Card>
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
  const options: Array<{ value: ThemePreference; label: ReactNode; title: string }> = [
    {
      value: 'light',
      label: (
        <span className="weq-set-seg-label">
          <Sun size={14} aria-hidden />
          浅色
        </span>
      ),
      title: '浅色',
    },
    {
      value: 'dark',
      label: (
        <span className="weq-set-seg-label">
          <Moon size={14} aria-hidden />
          深色
        </span>
      ),
      title: '深色',
    },
    {
      value: 'system',
      label: (
        <span className="weq-set-seg-label">
          <Monitor size={14} aria-hidden />
          跟随系统
        </span>
      ),
      title: '跟随系统',
    },
  ];

  return (
    <SegmentedControl<ThemePreference>
      label="主题模式"
      value={value}
      options={options}
      onChange={onChange}
    />
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

      <div className="weq-cp-bar-row">
        <span className="weq-cp-bar-label">色相</span>
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
        <span className="weq-cp-bar-value">
          {<span className="weq-number weq-number-inherit">{Math.round(hsl.h)}</span>}°
        </span>
      </div>

      <div className="weq-cp-bar-row">
        <span className="weq-cp-bar-label">明度</span>
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
        <span className="weq-cp-bar-value">
          {<span className="weq-number weq-number-inherit">{Math.round(hsl.l * 100)}</span>}%
        </span>
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
