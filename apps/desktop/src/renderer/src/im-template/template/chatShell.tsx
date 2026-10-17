// @ts-nocheck
import type { CSSProperties, ReactNode } from 'react';
import { TitleBarSearch } from '../../components/TitleBarSearch';
import { cn } from './classNames';
import { AppRail } from './rail';
import { SidebarHeader, SidebarResizeHandle } from './sidebar';
import { TitleBar } from './TitleBar';
import { IS_MAC } from '../../lib/target';
import type { ContactNoticeView, ContactTab, MainView, SettingsTab, User } from './types';

export function ChatShell({
  user,
  view,
  query,
  contactTab,
  activeNotice,
  sidebarWidth,
  mainOpen,
  messageBadgeCount,
  contactBadgeCount,
  mailBadgeCount,
  showTools = true,
  railFooterContent,
  friendNoticeCount,
  groupNoticeCount,
  searchPanel,
  onSearchFocus,
  sidebarContent,
  mainContent,
  children,
  onViewChange,
  onOpenSettings,
  onOpenCollection,
  onOpenMarketBrowser,
  onOpenDressUp,
  onOpenProfile,
  onOpenAbout,
  onOpenInvite,
  onOpenWonderfulTools,
  onOpenAntiRecall,
  onOpenDbRepair,
  onOpenQzoneAlbum,
  onQueryChange,
  onQuickInvite,
  onCreateGroup,
  onOpenFriendNotices,
  onOpenGroupNotices,
  onContactTabChange,
  onRefreshContacts,
  refreshingContacts,
  onSidebarWidthChange,
  onGoHome,
}: {
  user: User;
  view: MainView;
  query: string;
  contactTab: ContactTab;
  activeNotice: ContactNoticeView | null;
  sidebarWidth: number;
  mainOpen: boolean;
  messageBadgeCount: number;
  contactBadgeCount: number;
  mailBadgeCount?: number;
  showTools?: boolean;
  railFooterContent?: ReactNode;
  friendNoticeCount: number;
  groupNoticeCount: number;
  /** 搜索框下方的浮层（统一搜索下拉 / 最近搜索）。 */
  searchPanel?: ReactNode;
  onSearchFocus?: () => void;
  sidebarContent: ReactNode;
  mainContent: ReactNode;
  children?: ReactNode;
  onViewChange: (view: MainView) => void;
  onOpenSettings: (tab?: SettingsTab) => void;
  onOpenCollection: () => void;
  onOpenMarketBrowser: () => void;
  onOpenDressUp: () => void;
  onOpenProfile: () => void;
  onOpenAbout: () => void;
  onOpenInvite: () => void;
  onOpenWonderfulTools: () => void;
  onOpenAntiRecall: () => void;
  onOpenDbRepair: () => void;
  onOpenQzoneAlbum: () => void;
  onQueryChange: (query: string) => void;
  onQuickInvite: () => void;
  onCreateGroup: () => void;
  onOpenFriendNotices: () => void;
  onOpenGroupNotices: () => void;
  onContactTabChange: (tab: ContactTab) => void;
  onRefreshContacts?: () => void;
  refreshingContacts?: boolean;
  onSidebarWidthChange: (width: number) => void;
  onGoHome?: () => void;
}) {
  const shellStyle = {
    '--sidebar-width': `${sidebarWidth}px`,
  } as CSSProperties;

  return (
    <div className={cn('app-shell-root', IS_MAC && 'is-mac')}>
      <TitleBar
        user={user}
        homeActive={view === 'home'}
        onGoHome={onGoHome}
        search={
          <TitleBarSearch
            query={query}
            onQueryChange={onQueryChange}
            onSearchFocus={onSearchFocus}
            results={searchPanel}
          />
        }
      />
      <div className={cn('app-shell', view === 'tools' && 'app-shell-tools')} style={shellStyle}>
        <AppRail
          user={user}
          view={view}
          onViewChange={onViewChange}
          onOpenSettings={onOpenSettings}
          onOpenCollection={onOpenCollection}
          onOpenMarketBrowser={onOpenMarketBrowser}
          onOpenDressUp={onOpenDressUp}
          onOpenProfile={onOpenProfile}
          onOpenAbout={onOpenAbout}
          onOpenInvite={onOpenInvite}
          onOpenWonderfulTools={onOpenWonderfulTools}
          onOpenAntiRecall={onOpenAntiRecall}
          onOpenDbRepair={onOpenDbRepair}
          onOpenQzoneAlbum={onOpenQzoneAlbum}
          messageBadgeCount={messageBadgeCount}
          contactBadgeCount={contactBadgeCount}
          mailBadgeCount={mailBadgeCount}
          showTools={showTools}
          footerContent={railFooterContent}
          hideAvatar={true}
        />
        <aside
          className={cn(
            'sidebar',
            view === 'home' && 'is-home-view',
            view === 'agentlab' && 'is-agentlab-view',
            view === 'cache' && 'is-cache-view',
            view === 'qzone' && 'is-qzone-view',
            view === 'mail' && 'is-mail-view',
            view === 'channel' && 'is-channel-view',
          )}
        >
          <SidebarHeader
            user={user}
            showSearch={false}
            view={view}
            query={query}
            onQueryChange={onQueryChange}
            onQuickInvite={onQuickInvite}
            onCreateGroup={onCreateGroup}
            onOpenProfile={onOpenProfile}
            onOpenFriendNotices={onOpenFriendNotices}
            onOpenGroupNotices={onOpenGroupNotices}
            contactTab={contactTab}
            onContactTabChange={onContactTabChange}
            onRefreshContacts={onRefreshContacts}
            refreshingContacts={refreshingContacts}
            activeNotice={activeNotice}
            searchPanel={searchPanel}
            onSearchFocus={onSearchFocus}
            friendNoticeCount={friendNoticeCount}
            groupNoticeCount={groupNoticeCount}
          />
          <div className={cn('sidebar-body', view === 'agentlab' && 'is-agentlab-sidebar')}>
            {sidebarContent}
          </div>
        </aside>
        <SidebarResizeHandle width={sidebarWidth} onWidthChange={onSidebarWidthChange} />
        <main className={cn('chat-main', mainOpen && 'chat-main-open')}>{mainContent}</main>
      </div>
      {children}
    </div>
  );
}
