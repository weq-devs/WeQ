import { useEffect, type ReactNode } from 'react';
import {
  Bookmark,
  ChevronRight,
  ContactRound,
  Grid2X2,
  Hash,
  House,
  Mail,
  MessageCircle,
  Palette,
  Settings,
  Sparkles,
  Star,
  ListTodo,
  Bot,
  BarChart3,
  Download,
  FolderOpen,
  FileStack,
} from 'lucide-react';
import { Avatar } from '../im-template/template/primitives';
import type { MainView, User } from '../im-template/template/types';
import { displayUserName } from '../im-template/template/user';
import { TitleBarSearch } from './TitleBarSearch';
import { RemoteShellMenuButton } from './RemoteShellMenus';
import { OnlineStatus } from './OnlineStatus';
import { useWorkspaceMobilePage } from './WorkspacePages';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import { useMobileWebLayout } from '../hooks/useMobileWebViewport';
import { preloadMobilePages } from '../lib/mobilePageLoading';
import { mobilePageLoaders } from './lazyWorkspaces';
import '../styles/mobile-web.css';

export function MobileWebNavigation({
  user,
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
  onOpenProfile,
}: {
  user: User;
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
  onOpenProfile?: () => void;
}) {
  const mobilePage = useWorkspaceMobilePage();
  const mobile = useMobileWebLayout();
  useEffect(() => {
    if (mobile) return preloadMobilePages(mobilePageLoaders);
    return undefined;
  }, [mobile]);
  const openTool = useWorkspaceMenu((state) => state.openMobileTool);
  const moreOpen = view === 'more' && !mobilePage;
  useEffect(() => {
    if (!moreOpen) return;
    const mobile = window.matchMedia('(max-width: 760px)');
    const leaveMobile = (event: MediaQueryListEvent) => {
      if (!event.matches) onViewChange('messages');
    };
    mobile.addEventListener('change', leaveMobile);
    return () => mobile.removeEventListener('change', leaveMobile);
  }, [moreOpen, onViewChange]);
  const primary = view === 'messages' || view === 'contacts' || view === 'qzone';
  const active = moreOpen || !primary ? 'more' : view;
  const select = (next: MainView) => {
    mobilePage?.close();
    if (next !== view) onViewChange(next);
  };
  const entries = [
    { label: '主页', icon: House, action: () => select('home') },
    { label: 'QQ 邮箱', icon: Mail, badge: mailBadgeCount, action: () => select('mail') },
    { label: 'QQ 频道', icon: Hash, action: () => select('channel') },
    { label: '我的收藏', icon: Bookmark, action: onOpenCollection },
    { label: '年度报告', icon: Sparkles, action: () => select('annual') },
    { label: '个性装扮', icon: Palette, action: onOpenDressUp },
    { label: '任务', icon: ListTodo, action: () => openTool('tasks') },
    { label: 'WeQ 助手', icon: Bot, action: () => openTool('assistant') },
    { label: '分析与报告', icon: BarChart3, action: () => openTool('analysis') },
    { label: '导出', icon: Download, action: () => openTool('export') },
    { label: '导出查看器', icon: FolderOpen, action: () => openTool('viewer') },
    { label: '合成聊天记录', icon: FileStack, action: () => openTool('composition') },
    { label: '设置', icon: Settings, action: onOpenSettings },
  ];
  const moreContent = (
    <section className="weq-mobile-more" aria-label="更多功能">
      <div className="weq-mobile-more-account">
        <Avatar name={displayUserName(user)} avatarUrl={user.avatarUrl} seed={user.identityValue} />
        <div>
          <strong>{displayUserName(user)}</strong>
          <span>{user.identityValue}</span>
        </div>
      </div>
      {entries.map(({ label, icon: Icon, badge, action }) => (
        <button key={label} type="button" onClick={action}>
          <Icon size={22} aria-hidden />
          <span>{label}</span>
          {badge ? <MobileBadge count={badge} /> : null}
          <ChevronRight size={18} aria-hidden />
        </button>
      ))}
    </section>
  );

  return (
    <div className="weq-mobile-navigation" hidden={hidden}>
      <header className="weq-mobile-header">
        <button
          type="button"
          className="weq-mobile-account"
          aria-label={onOpenProfile ? '编辑 QQ 资料' : '打开设置'}
          title={onOpenProfile ? 'QQ 资料与状态' : '设置'}
          onClick={onOpenProfile ?? onOpenSettings}
        >
          <Avatar
            name={displayUserName(user)}
            avatarUrl={user.avatarUrl}
            seed={user.identityValue}
          />
        </button>
        <div className="weq-mobile-identity">
          <strong title={displayUserName(user)}>{displayUserName(user)}</strong>
          {user.uid && (
            <OnlineStatus
              key={user.uid}
              uid={user.uid}
              className="weq-mobile-online-status"
              refetchInterval={15_000}
              showBaseStatus
            />
          )}
        </div>
        <TitleBarSearch
          query={query}
          onQueryChange={onQueryChange}
          onSearchFocus={onSearchFocus}
          results={searchPanel}
        />
        <RemoteShellMenuButton />
      </header>
      {moreOpen ? moreContent : null}
      {mobile && (
        <div hidden inert aria-hidden="true" data-mobile-root-preview="more">
          {moreContent}
        </div>
      )}
      <nav className="weq-mobile-tabs" aria-label="主导航">
        {[
          { id: 'messages', label: '消息', icon: MessageCircle, badge: messageBadgeCount },
          { id: 'contacts', label: '联系人', icon: ContactRound, badge: contactBadgeCount },
          { id: 'qzone', label: '空间', icon: Star, badge: 0 },
          { id: 'more', label: '更多', icon: Grid2X2, badge: mailBadgeCount },
        ].map(({ id, label, icon: Icon, badge }) => (
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
              } else select(id as 'messages' | 'contacts' | 'qzone' | 'more');
            }}
          >
            <span className="weq-mobile-tab-icon">
              <Icon size={24} aria-hidden />
              {badge > 0 ? <MobileBadge count={badge} /> : null}
            </span>
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function MobileBadge({ count }: { count: number }) {
  return <span className="weq-mobile-badge">{count > 99 ? '99+' : count}</span>;
}
