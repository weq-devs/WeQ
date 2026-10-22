// @ts-nocheck
import {
  LayoutGrid,
  MessageCircle,
  Settings,
  Hash,
  Bookmark,
  Palette,
  Mail,
  Sparkles,
} from 'lucide-react';
import { SiQzone } from 'react-icons/si';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from './classNames';
import { Avatar } from './primitives';
import type { MainView, SettingsTab, User } from './types';
import { displayUserName } from './user';
import { useUpdateStore } from '../../state/update';
import '../../styles/rail-navigation.css';
import '../../styles/rail-utility-dock.css';
import { useWorkspaceActiveTitle } from '../../components/WorkspacePages';

export function AppRail({
  user,
  view,
  onViewChange,
  onOpenSettings,
  onOpenCollection,
  onOpenDressUp,
  onOpenProfile,
  onOpenAbout: _onOpenAbout,
  onOpenInvite,
  messageBadgeCount = 0,
  onMessageBadgeClick,
  contactBadgeCount = 0,
  mailBadgeCount = 0,
  showTools = true,
  footerContent,
  hideAvatar = false,
  activeRailItem,
}: {
  user: User;
  view: MainView;
  onViewChange: (view: MainView) => void;
  onOpenSettings: (tab?: SettingsTab) => void;
  onOpenCollection: () => void;
  onOpenDressUp: () => void;
  onOpenProfile: () => void;
  onOpenAbout: () => void;
  onOpenInvite: () => void;
  onOpenWonderfulTools: () => void;
  onOpenAntiRecall: () => void;
  /** 维护与诊断工具那一页的直达入口：打开同一个弹窗，但先落到「数据库修复」。 */
  onOpenDbRepair: () => void;
  onOpenQzoneAlbum: () => void;
  messageBadgeCount?: number;
  onMessageBadgeClick?: () => void;
  contactBadgeCount?: number;
  mailBadgeCount?: number;
  showTools?: boolean;
  footerContent?: ReactNode | ((settingsButton: ReactNode) => ReactNode);
  hideAvatar?: boolean;
  activeRailItem?: 'settings' | 'dressup';
}) {
  const [profileOpen, setProfileOpen] = useState(false);
  const railRef = useRef<HTMLElement | null>(null);
  const activeTitle = useWorkspaceActiveTitle();
  const activePage =
    activeTitle === '个性装扮' ? 'dressup' : activeTitle === '设置' ? 'settings' : undefined;
  const activeView = activePage ?? activeRailItem ?? view;
  const updateAvailable = useUpdateStore((s) => s.available);
  const settingsButton = (mobile = false) => (
    <button
      className={cn(
        railButtonClass(activeView === 'settings'),
        mobile
          ? 'rail-tab rail-tab-settings rail-mobile-settings'
          : 'weq-rail-control weq-rail-settings',
      )}
      aria-current={activeView === 'settings' ? 'page' : undefined}
      aria-label="设置"
      onClick={() => {
        setProfileOpen(false);
        onOpenSettings();
      }}
      title={updateAvailable ? '设置 · 有新版本可更新' : '设置'}
      type="button"
    >
      <Settings size={mobile ? 22 : 18} strokeWidth={mobile ? 1.5 : 2} aria-hidden />
      {mobile ? <span className="rail-label">设置</span> : null}
      {updateAvailable ? (
        <span className="rail-badge rail-badge-dot" aria-label="有新版本可更新" />
      ) : null}
    </button>
  );

  const contentItems = [
    { id: 'collection', label: '我的收藏', icon: Bookmark, onSelect: onOpenCollection },
    // 年度报告整页独占内容区（shell.view === 'annual'），与 QQ 空间 / 邮箱同一条
    // 「整页视图」路径，不另开弹窗。
    { id: 'annual', label: '年度报告', icon: Sparkles, onSelect: () => selectView('annual') },
    { id: 'dressup', label: '个性装扮', icon: Palette, onSelect: onOpenDressUp },
  ];

  useEffect(() => {
    if (!profileOpen) {
      return;
    }

    function closeFloating(event: globalThis.MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (!railRef.current?.contains(target)) {
        setProfileOpen(false);
      }
    }

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        setProfileOpen(false);
      }
    }

    document.addEventListener('mousedown', closeFloating);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeFloating);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [profileOpen]);

  function selectView(nextView: MainView) {
    setProfileOpen(false);
    // 导航与高亮一起提交，避免后台刷新反复抢占低优先级的页面切换。
    onViewChange(nextView);
  }

  return (
    <aside className={cn('app-rail', hideAvatar && 'hide-avatar')} ref={railRef}>
      {!hideAvatar && (
        <button
          className={cn('rail-avatar')}
          title={displayUserName(user)}
          onClick={() => {
            setProfileOpen((open) => !open);
          }}
        >
          <Avatar
            name={displayUserName(user)}
            avatarUrl={user.avatarUrl}
            seed={user.identityValue}
          />
          <span />
        </button>
      )}
      {profileOpen ? (
        <ProfilePopover
          user={user}
          onEditProfile={() => {
            setProfileOpen(false);
            onOpenProfile();
          }}
          onInvite={() => {
            setProfileOpen(false);
            onOpenInvite();
          }}
        />
      ) : null}
      <div className={cn('rail-groups')}>
        <nav
          className={cn('rail-nav rail-nav-primary')}
          aria-label="Primary"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="rail-message-entry">
            <button
              className={cn(
                railButtonClass(activeView === 'messages'),
                'rail-tab rail-tab-messages',
              )}
              onClick={() => selectView('messages')}
              title="消息"
              aria-current={activeView === 'messages' ? 'page' : undefined}
            >
              <span className={cn('rail-tab-icon')}>
                <MessageCircle size={22} strokeWidth={1.5} />
              </span>
              <span className={cn('rail-label')}>消息</span>
            </button>
            {messageBadgeCount > 0 ? (
              <button
                type="button"
                className={cn('rail-badge rail-message-badge')}
                title="定位首条未读会话"
                aria-label={`定位首条未读会话，共 ${messageBadgeCount} 条未读消息`}
                onClick={() => {
                  setProfileOpen(false);
                  if (onMessageBadgeClick) onMessageBadgeClick();
                  else selectView('messages');
                }}
              >
                {formatBadgeCount(messageBadgeCount)}
              </button>
            ) : null}
          </div>
          <button
            className={cn(railButtonClass(activeView === 'contacts'), 'rail-tab rail-tab-contacts')}
            onClick={() => selectView('contacts')}
            title="联系人"
            aria-current={activeView === 'contacts' ? 'page' : undefined}
          >
            <span className={cn('rail-tab-icon')}>
              <ContactRailIcon />
            </span>
            <span className={cn('rail-label')}>联系人</span>
            {contactBadgeCount > 0 ? (
              <span
                className={cn('rail-badge rail-badge-dot')}
                role="status"
                aria-label="有新的好友或群通知"
              />
            ) : null}
          </button>
          <button
            className={cn(railButtonClass(activeView === 'qzone'), 'rail-tab rail-tab-qzone')}
            onClick={() => selectView('qzone')}
            title="QQ 空间"
            aria-current={activeView === 'qzone' ? 'page' : undefined}
            type="button"
          >
            <span className={cn('rail-tab-icon')}>
              <SiQzone size={22} />
            </span>
            <span className={cn('rail-label')}>QQ空间</span>
          </button>
          <button
            className={cn(railButtonClass(activeView === 'channel'), 'rail-tab rail-tab-channel')}
            onClick={() => selectView('channel')}
            title="QQ 频道"
            aria-current={activeView === 'channel' ? 'page' : undefined}
            type="button"
          >
            <span className={cn('rail-tab-icon')}>
              <Hash size={22} strokeWidth={1.5} />
            </span>
            <span className={cn('rail-label')}>QQ频道</span>
          </button>
          <button
            type="button"
            className={cn(railButtonClass(activeView === 'mail'), 'rail-tab rail-tab-mail')}
            onClick={() => selectView('mail')}
            title="QQ 邮箱"
            aria-current={activeView === 'mail' ? 'page' : undefined}
          >
            <span className={cn('rail-tab-icon')}>
              <Mail size={22} strokeWidth={1.5} />
            </span>
            <span className={cn('rail-label')}>QQ邮箱</span>
            {mailBadgeCount > 0 ? (
              <span
                className="rail-badge rail-badge-mail"
                role="status"
                aria-label={`${mailBadgeCount} 封未读邮件`}
                title={`${mailBadgeCount} 封未读邮件`}
              >
                {formatBadgeCount(mailBadgeCount)}
              </span>
            ) : null}
          </button>
          {contentItems.map((item) => (
            <button
              key={item.id}
              className={cn(
                railButtonClass(
                  activeView === (item.id === 'collection' ? 'collections' : item.id),
                ),
                'rail-tab',
                `rail-tab-${item.id}`,
              )}
              aria-current={
                activeView === (item.id === 'collection' ? 'collections' : item.id)
                  ? 'page'
                  : undefined
              }
              onClick={() => {
                setProfileOpen(false);
                item.onSelect();
              }}
              title={item.label}
              type="button"
            >
              <span className={cn('rail-tab-icon')}>
                <item.icon size={22} strokeWidth={1.5} />
              </span>
              <span className={cn('rail-label')}>{item.label}</span>
            </button>
          ))}
          {settingsButton(true)}
          <button
            className={cn(
              railButtonClass(activeView === 'tools'),
              'rail-mobile-tool rail-tab rail-tab-tools',
              !showTools && 'rail-desktop-hidden',
            )}
            type="button"
            title="应用"
            aria-current={activeView === 'tools' ? 'page' : undefined}
            onClick={() => selectView('tools')}
          >
            <span className={cn('rail-tab-icon')}>
              <LayoutGrid size={22} strokeWidth={1.5} />
            </span>
            <span className={cn('rail-label')}>应用</span>
          </button>
        </nav>
      </div>
      <div className={cn('rail-footer')}>
        {typeof footerContent === 'function' ? (
          footerContent(settingsButton())
        ) : (
          <>
            {settingsButton()}
            {footerContent}
          </>
        )}
      </div>
    </aside>
  );
}

function formatBadgeCount(value: number) {
  return value > 99 ? '99+' : String(value);
}

function railButtonClass(active: boolean) {
  return cn(active && 'active');
}

function ContactRailIcon() {
  return (
    <svg className="rail-contact-icon" viewBox="0 0 28 28" aria-hidden="true">
      <circle className="rail-contact-head" cx="14" cy="7.8" r="4.5" />
      <path className="rail-contact-body-fill" d="M4.5 24.5a9.5 7.5 0 0 1 19 0H4.5Z" />
      <path className="rail-contact-collar" d="M11.2 17.5h5.6L14 21Z" />
      <path className="rail-contact-body-line" d="M4.5 24.5a9.5 7.5 0 0 1 19 0" />
    </svg>
  );
}

function ProfilePopover({
  user,
  onEditProfile,
  onInvite,
}: {
  user: User;
  onEditProfile: () => void;
  onInvite: () => void;
}) {
  return (
    <section className={cn('profile-popover')}>
      <div className={cn('profile-popover-head')}>
        <Avatar name={displayUserName(user)} avatarUrl={user.avatarUrl} seed={user.identityValue} />
        <div>
          <strong>{displayUserName(user)}</strong>
          <span className={cn('copyable-text')}>
            {user.identityLabel} {user.identityValue}
          </span>
          <em>
            <span />
            在线
          </em>
        </div>
      </div>
      <div className={cn('profile-popover-row')}>
        <span>用户名</span>
        <strong>{user.username}</strong>
      </div>
      <div className={cn('profile-popover-actions')}>
        <button className={cn('secondary-button')} onClick={onEditProfile}>
          编辑资料
        </button>
        <button className={cn('primary-button')} onClick={onInvite}>
          添加联系人
        </button>
      </div>
    </section>
  );
}
