import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeftRight, ChevronRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Avatar } from '../im-template/template/primitives';
import { AnnouncementEntry } from './AnnouncementCenter';
import { NavigationBadgeMark } from './ReminderBadge';
import {
  navigationBadge,
  summarizeNavigationBadges,
  type NavigationBadge,
} from '../lib/navigationBadges';
import { useWorkspaceEntryBadges } from '../hooks/useWorkspaceEntryBadges';
import { SelfProfileAvatar } from './SelfProfileAvatar';
import type { ProfileGroup } from '../lib/profileNavigation';
import type { MainView, User } from '../im-template/template/types';
import { displayUserName } from '../im-template/template/user';
import { TitleBarSearch } from './TitleBarSearch';
import { DataSaverMenu } from './DataSaverMenu';
import { RemoteShellMenuButton } from './RemoteShellMenus';
import { RemoteAccountSwitcher } from './RemoteAccountSwitcher';
import { OnlineStatus } from './OnlineStatus';
import { useWorkspaceMobilePage } from './WorkspacePages.shared';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import { useMobileWebLayout } from '../hooks/useMobileWebViewport';
import { useDevelopmentDressTools } from '../hooks/useDevelopmentDressTools';
import { preloadMobilePages } from '../lib/mobilePageLoading';
import { mobileMorePageLoaders, preloadWorkspace } from './lazyWorkspaces.shared';
import { useDataSaver } from '../lib/dataSaver';
import { registerMobileBack } from '../hooks/useMobileNavigation';
import { mobileRootTab } from '../lib/mobileRootTransition';
import { isSingleColumnLayout, subscribeResponsiveLayout } from '../lib/responsiveLayout';
import { accountGatewayPath, isAccountGateway } from '../lib/accountGateway';
import { useRemoteClient } from '../lib/remoteClient';
import { useWebConnection } from '../state/webConnection';
import {
  activateNavigation,
  navigationEntries,
  type AppNavigationTarget,
} from '../lib/appNavigation';
import '../styles/mobile-web.css';

const switchAccountPath = accountGatewayPath('/_weq/switch-account');

export function MobileWebNavigation({
  user,
  selfProfileGroup,
  view,
  hidden,
  query,
  onQueryChange,
  onSearchFocus,
  searchPanel,
  messageBadgeCount,
  onMessageBadgeClick,
  contactBadgeCount,
  mailBadgeCount = 0,
  mailBadgePending = false,
  onViewChange,
  onOpenSettings,
  onOpenDressUp,
  onOpenCollection,
}: {
  user: User;
  selfProfileGroup?: ProfileGroup;
  view: MainView;
  hidden: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onSearchFocus?: () => void;
  searchPanel?: ReactNode;
  messageBadgeCount: number;
  onMessageBadgeClick?: () => void;
  contactBadgeCount: number;
  mailBadgeCount?: number;
  mailBadgePending?: boolean;
  onViewChange: (view: MainView) => void;
  onOpenSettings: () => void;
  onOpenDressUp: () => void;
  onOpenCollection: () => void;
}) {
  const mobilePage = useWorkspaceMobilePage();
  const entryBadges = useWorkspaceEntryBadges();
  const mobile = useMobileWebLayout();
  const developmentDressTools = useDevelopmentDressTools();
  const dataSaver = useDataSaver((state) => state.enabled);
  const viewChange = useRef(onViewChange);
  viewChange.current = onViewChange;
  useEffect(() => {
    if (!mobile || mobileRootTab(view)) return;
    // 父级数据刷新会更换回调，不能因此重登记并重复触发进出动画。
    return registerMobileBack({
      id: 'mobile-more-page',
      priority: 5,
      retained: true,
      back: () => viewChange.current('more'),
      target: () => document.querySelector<HTMLElement>('.weq-web-shell .app-shell > .chat-main'),
    });
  }, [mobile, view]);
  const openTool = useWorkspaceMenu((state) => state.openMobileTool);
  const moreOpen = view === 'more' && !mobilePage;
  const remote = useRemoteClient();
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const recovery = useWebConnection((state) => state.recovery);
  const accountSwitch = useQuery({
    queryKey: ['remote-account-switch', recovery],
    queryFn: async ({ signal }) => {
      const response = await fetch(switchAccountPath, {
        method: 'HEAD',
        redirect: 'manual',
        signal,
      });
      return response.status === 204;
    },
    enabled: remote && isAccountGateway && mobile && moreOpen && !hidden,
    retry: false,
  });
  useEffect(() => {
    if (mobile && moreOpen && !dataSaver) return preloadMobilePages(mobileMorePageLoaders);
    return undefined;
  }, [mobile, moreOpen, dataSaver]);
  useEffect(() => {
    if (!moreOpen) return;
    const leaveMobile = () => {
      if (!isSingleColumnLayout()) onViewChange('messages');
    };
    return subscribeResponsiveLayout(leaveMobile);
  }, [moreOpen, onViewChange]);
  const tabs = navigationEntries('mobile-tabs');
  const primary = tabs.some((entry) => entry.id === view && entry.id !== 'more');
  const active = moreOpen || !primary ? 'more' : view;
  const locateUnread = active === 'messages' && !mobilePage ? onMessageBadgeClick : undefined;
  const select = (next: MainView) => {
    mobilePage?.close();
    if (next !== view) onViewChange(next);
  };
  const activate = (target: AppNavigationTarget) =>
    activateNavigation(target, {
      onViewChange: select,
      onOpenCollection,
      onOpenDressUp,
      onOpenSettings,
      onOpenTool: openTool,
      onOpenNotice: () => {},
    });
  const moreBadges: Partial<Record<string, NavigationBadge>> = {
    ...entryBadges,
    mail:
      navigationBadge('unread', mailBadgeCount, `${mailBadgeCount} 封未读邮件`) ??
      navigationBadge('notice', Number(mailBadgePending), '有新邮件'),
  };
  const moreEntries = navigationEntries('mobile-more', developmentDressTools).map((entry) => ({
    ...entry,
    badge: moreBadges[entry.id],
  }));
  const { badge: moreBadge, description: moreBadgeDescription } = summarizeNavigationBadges(
    moreEntries.map(({ badge }) => badge),
  );
  const moreContent = (
    <section className="weq-mobile-more" aria-label="更多功能">
      <div className="weq-mobile-more-account">
        <Avatar name={displayUserName(user)} avatarUrl={user.avatarUrl} seed={user.identityValue} />
        <div>
          <strong>{displayUserName(user)}</strong>
          <span>{user.identityValue}</span>
        </div>
        {remote && accountSwitch.data === true ? (
          <button
            type="button"
            className="weq-set-btn weq-mobile-more-account-switch"
            onClick={() => setSwitchingAccount(true)}
          >
            <ArrowLeftRight size={16} aria-hidden />
            切换账号
          </button>
        ) : null}
      </div>
      {moreEntries.map(({ id, label, icon: Icon, target, workspace, badge }) =>
        target.kind === 'announcements' ? (
          <AnnouncementEntry key={id} placement="mobile" unreadCount={badge?.count ?? 0} />
        ) : (
          <button
            key={id}
            type="button"
            aria-label={badge ? `${label}，${badge.description}` : undefined}
            onClick={() => activate(target)}
            onPointerEnter={() => {
              if (workspace) preloadWorkspace(workspace);
            }}
            onFocus={() => {
              if (workspace) preloadWorkspace(workspace);
            }}
            onPointerDown={() => {
              if (workspace) preloadWorkspace(workspace);
            }}
          >
            <Icon size={22} aria-hidden />
            <span>{label}</span>
            <NavigationBadgeMark badge={badge} className="weq-mobile-badge" />
            <ChevronRight size={18} aria-hidden />
          </button>
        ),
      )}
    </section>
  );

  return (
    <div className="weq-mobile-navigation" inert={hidden} aria-hidden={hidden}>
      <header className="weq-mobile-header">
        <div className="weq-mobile-self-identity">
          <SelfProfileAvatar user={user} group={selfProfileGroup} className="weq-mobile-account">
            <strong title={displayUserName(user)}>{displayUserName(user)}</strong>
          </SelfProfileAvatar>
          <div className="weq-mobile-identity">
            {user.uid && (
              <OnlineStatus
                key={user.uid}
                uid={user.uid}
                selfUin={user.identityValue}
                className="weq-mobile-online-status"
                refetchInterval={15_000}
                showBaseStatus
              />
            )}
          </div>
        </div>
        <TitleBarSearch
          query={query}
          onQueryChange={onQueryChange}
          onSearchFocus={onSearchFocus}
          results={searchPanel}
        />
        <DataSaverMenu />
        <RemoteShellMenuButton />
      </header>
      {moreOpen ? moreContent : null}
      {switchingAccount && (
        <RemoteAccountSwitcher
          listPath={switchAccountPath}
          onClose={() => setSwitchingAccount(false)}
        />
      )}
      {mobile && (
        <div hidden inert aria-hidden="true" data-mobile-root-preview="more">
          {moreContent}
        </div>
      )}
      <nav className="weq-mobile-tabs" aria-label="主导航">
        {tabs.map(({ id, label, icon: Icon, target }) => {
          const badge =
            id === 'more'
              ? moreBadge
              : id === 'messages'
                ? navigationBadge('unread', messageBadgeCount, `${messageBadgeCount} 条未读`)
                : id === 'contacts'
                  ? navigationBadge('notice', contactBadgeCount, '有新的好友或群通知')
                  : undefined;
          const description =
            id === 'more' ? moreBadgeDescription : badge ? `，${badge.description}` : '';
          return (
            <button
              key={id}
              type="button"
              aria-current={active === id ? 'page' : undefined}
              data-mobile-tab={id}
              aria-expanded={id === 'more' ? moreOpen : undefined}
              aria-label={`${label}${description}`}
              onClick={() => {
                if (id === 'messages' && locateUnread) locateUnread();
                else activate(target);
              }}
            >
              <span className="weq-mobile-tab-icon">
                <Icon size={24} aria-hidden />
                <NavigationBadgeMark badge={badge} className="weq-mobile-badge" overlay />
              </span>
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
