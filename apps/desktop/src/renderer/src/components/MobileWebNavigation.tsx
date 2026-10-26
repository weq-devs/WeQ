import { useEffect, useState, type ReactNode } from 'react';
import {
  Bookmark,
  ChevronRight,
  ContactRound,
  Grid2X2,
  Hash,
  House,
  LayoutGrid,
  Mail,
  MessageCircle,
  Plus,
  Palette,
  Settings,
  Sparkles,
  Star,
  UserRoundPen,
  UserRoundPlus,
  UsersRound,
} from 'lucide-react';
import { Avatar } from '../im-template/template/primitives';
import type { MainView, User } from '../im-template/template/types';
import { displayUserName } from '../im-template/template/user';
import { TitleBarSearch } from './TitleBarSearch';
import '../styles/mobile-web.css';

export function MobileWebNavigation({
  user,
  view,
  hidden,
  query,
  onQueryChange,
  onSearchFocus,
  onSearchReturn,
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
  onLookupUser,
  onLookupGroup,
  onOpenFriendNotices,
  onOpenGroupNotices,
  accountControls,
}: {
  user: User;
  view: MainView;
  hidden: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onSearchFocus?: () => void;
  onSearchReturn?: () => boolean;
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
  onLookupUser?: () => void;
  onLookupGroup?: () => void;
  onOpenFriendNotices?: () => void;
  onOpenGroupNotices?: () => void;
  accountControls?: ReactNode;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  useEffect(() => {
    setMoreOpen(false);
    setActionsOpen(false);
  }, [view, hidden]);
  useEffect(() => {
    if (!actionsOpen && !moreOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActionsOpen(false);
        setMoreOpen(false);
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [actionsOpen, moreOpen]);
  const primary = view === 'messages' || view === 'contacts' || view === 'qzone';
  const active = moreOpen || !primary ? 'more' : view;
  const titles: Partial<Record<MainView, string>> = {
    messages: '消息',
    contacts: '联系人',
    qzone: 'QQ 空间',
    mail: 'QQ 邮箱',
    channel: 'QQ 频道',
    collections: '我的收藏',
    annual: '年度报告',
    home: '主页',
    tools: '应用',
  };
  const select = (next: MainView) => {
    setMoreOpen(false);
    setActionsOpen(false);
    onViewChange(next);
  };
  const entries = [
    ...(onOpenProfile
      ? [{ label: 'QQ 资料与状态', icon: UserRoundPen, action: onOpenProfile }]
      : []),
    { label: '主页', icon: House, action: () => select('home') },
    { label: 'QQ 邮箱', icon: Mail, badge: mailBadgeCount, action: () => select('mail') },
    { label: 'QQ 频道', icon: Hash, action: () => select('channel') },
    { label: '我的收藏', icon: Bookmark, action: onOpenCollection },
    { label: '年度报告', icon: Sparkles, action: () => select('annual') },
    { label: '个性装扮', icon: Palette, action: onOpenDressUp },
    { label: '应用', icon: LayoutGrid, action: () => select('tools') },
    { label: '设置', icon: Settings, action: onOpenSettings },
  ];
  const actions = [
    { label: 'QQ 号搜索', icon: UserRoundPlus, action: onLookupUser },
    { label: '群号搜索', icon: UsersRound, action: onLookupGroup },
    { label: '好友通知', icon: ContactRound, action: onOpenFriendNotices },
    { label: '群通知', icon: UsersRound, action: onOpenGroupNotices },
  ].filter((entry) => entry.action);
  const run = (action: () => void) => {
    setMoreOpen(false);
    setActionsOpen(false);
    action();
  };

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
        <strong>{moreOpen ? '更多' : (titles[view] ?? 'WeQ')}</strong>
        <TitleBarSearch
          query={query}
          onQueryChange={onQueryChange}
          onSearchFocus={onSearchFocus}
          onReturn={onSearchReturn}
          results={searchPanel}
        />
        {actions.length > 0 && (
          <button
            type="button"
            className="weq-mobile-actions-toggle"
            aria-label="联系人操作"
            title="联系人操作"
            aria-expanded={actionsOpen}
            aria-controls="weq-mobile-contact-actions"
            onClick={() => {
              setMoreOpen(false);
              setActionsOpen((open) => !open);
            }}
          >
            <Plus size={22} aria-hidden />
          </button>
        )}
      </header>
      {actionsOpen && (
        <>
          <button
            type="button"
            className="weq-mobile-actions-dismiss"
            aria-label="关闭联系人操作"
            onClick={() => setActionsOpen(false)}
          />
          <section
            id="weq-mobile-contact-actions"
            className="weq-mobile-contact-actions"
            aria-label="联系人操作列表"
          >
            {actions.map(({ label, icon: Icon, action }) => (
              <button key={label} type="button" onClick={() => run(action!)}>
                <Icon size={20} aria-hidden />
                <span>{label}</span>
              </button>
            ))}
          </section>
        </>
      )}
      {moreOpen && (
        <section className="weq-mobile-more" aria-label="更多功能">
          <div className="weq-mobile-more-account">
            <Avatar
              name={displayUserName(user)}
              avatarUrl={user.avatarUrl}
              seed={user.identityValue}
            />
            <div>
              <strong>{displayUserName(user)}</strong>
              <span>{user.identityValue}</span>
            </div>
          </div>
          {entries.map(({ label, icon: Icon, badge, action }) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                run(action);
              }}
            >
              <Icon size={22} aria-hidden />
              <span>{label}</span>
              {badge ? <MobileBadge count={badge} /> : null}
              <ChevronRight size={18} aria-hidden />
            </button>
          ))}
          {accountControls && (
            <div className="weq-mobile-more-utilities" aria-label="账号与快捷控制">
              {accountControls}
            </div>
          )}
        </section>
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
            aria-expanded={id === 'more' ? moreOpen : undefined}
            aria-label={badge > 0 ? `${label}，${badge} 条未读` : label}
            onClick={() => {
              if (id === 'messages' && active === 'messages' && onMessageBadgeClick) {
                onMessageBadgeClick();
              } else if (id === 'more') {
                setActionsOpen(false);
                setMoreOpen((open) => !open);
              } else select(id as 'messages' | 'contacts' | 'qzone');
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
