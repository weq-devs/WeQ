import { useEffect, useRef, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Avatar } from '../im-template/template/primitives';
import { ReminderCount } from './ReminderBadge';
import { SelfProfileAvatar } from './SelfProfileAvatar';
import type { ProfileGroup } from '../lib/profileNavigation';
import type { MainView, User } from '../im-template/template/types';
import { displayUserName } from '../im-template/template/user';
import { TitleBarSearch } from './TitleBarSearch';
import { DataSaverMenu } from './DataSaverMenu';
import { RemoteShellMenuButton } from './RemoteShellMenus';
import { OnlineStatus } from './OnlineStatus';
import { useWorkspaceMobilePage } from './WorkspacePages.shared';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import { useMobileWebLayout } from '../hooks/useMobileWebViewport';
import { useDevelopmentDressTools } from '../hooks/useDevelopmentDressTools';
import { preloadMobilePages } from '../lib/mobilePageLoading';
import {
  mobilePageLoaders,
  mobileMorePageLoaders,
  preloadWorkspace,
} from './lazyWorkspaces.shared';
import { useDataSaver } from '../lib/dataSaver';
import { registerMobileBack } from '../hooks/useMobileNavigation';
import { mobileRootTab } from '../lib/mobileRootTransition';
import { isSingleColumnLayout, subscribeResponsiveLayout } from '../lib/responsiveLayout';
import {
  activateNavigation,
  navigationEntries,
  type AppNavigationTarget,
} from '../lib/appNavigation';
import '../styles/mobile-web.css';

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
  onViewChange: (view: MainView) => void;
  onOpenSettings: () => void;
  onOpenDressUp: () => void;
  onOpenCollection: () => void;
}) {
  const mobilePage = useWorkspaceMobilePage();
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
  useEffect(() => {
    if (mobile && !dataSaver) return preloadMobilePages(mobilePageLoaders);
    return undefined;
  }, [mobile, dataSaver]);
  const openTool = useWorkspaceMenu((state) => state.openMobileTool);
  const moreOpen = view === 'more' && !mobilePage;
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
  const badgeFor = (id: string) =>
    id === 'messages'
      ? messageBadgeCount
      : id === 'contacts'
        ? contactBadgeCount
        : id === 'mail' || id === 'more'
          ? mailBadgeCount
          : 0;
  const moreContent = (
    <section className="weq-mobile-more" aria-label="更多功能">
      <div className="weq-mobile-more-account">
        <Avatar name={displayUserName(user)} avatarUrl={user.avatarUrl} seed={user.identityValue} />
        <div>
          <strong>{displayUserName(user)}</strong>
          <span>{user.identityValue}</span>
        </div>
      </div>
      {navigationEntries('mobile-more', developmentDressTools).map(
        ({ id, label, icon: Icon, target, workspace }) => (
          <button
            key={id}
            type="button"
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
            {badgeFor(id) > 0 ? (
              <ReminderCount count={badgeFor(id)} className="weq-mobile-badge" />
            ) : null}
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
      {mobile && (
        <div hidden inert aria-hidden="true" data-mobile-root-preview="more">
          {moreContent}
        </div>
      )}
      <nav className="weq-mobile-tabs" aria-label="主导航">
        {tabs.map(({ id, label, icon: Icon, target }) => {
          const badge = badgeFor(id);
          return (
            <button
              key={id}
              type="button"
              aria-current={active === id ? 'page' : undefined}
              data-mobile-tab={id}
              aria-expanded={id === 'more' ? moreOpen : undefined}
              aria-label={badge > 0 ? `${label}，${badge} 条未读` : label}
              onClick={() => {
                if (id === 'messages' && active === 'messages' && onMessageBadgeClick) {
                  onMessageBadgeClick();
                } else activate(target);
              }}
            >
              <span className="weq-mobile-tab-icon">
                <Icon size={24} aria-hidden />
                {badge > 0 ? (
                  <ReminderCount count={badge} overlay className="weq-mobile-badge" />
                ) : null}
              </span>
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
