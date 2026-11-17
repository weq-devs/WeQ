// @ts-nocheck
import { Fragment, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from './classNames';
import { Avatar } from './primitives';
import type { MainView, SettingsTab, User } from './types';
import { displayUserName } from './user';
import { useUpdateStore } from '../../state/update';
import '../../styles/rail-navigation.css';
import { useWorkspaceActiveTitle } from '../../components/WorkspacePages.shared';
import { preloadWorkspace } from '../../components/lazyWorkspaces.shared';
import { ReminderCount, ReminderDot } from '../../components/ReminderBadge';
import { APP_NAVIGATION, activateNavigation, navigationEntries } from '../../lib/appNavigation';

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
  const Settings = APP_NAVIGATION.settings.icon;
  const activePage =
    activeTitle === APP_NAVIGATION.dressup.label
      ? 'dressup'
      : activeTitle === APP_NAVIGATION.settings.label
        ? 'settings'
        : undefined;
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
      aria-label={APP_NAVIGATION.settings.label}
      onPointerEnter={() => preloadWorkspace(APP_NAVIGATION.settings.workspace)}
      onFocus={() => preloadWorkspace(APP_NAVIGATION.settings.workspace)}
      onClick={() => {
        setProfileOpen(false);
        onOpenSettings();
      }}
      title={
        updateAvailable
          ? `${APP_NAVIGATION.settings.label} · 有新版本可更新`
          : APP_NAVIGATION.settings.label
      }
      type="button"
    >
      <Settings size={22} strokeWidth={1.75} aria-hidden />
      {mobile ? <span className="rail-label">{APP_NAVIGATION.settings.label}</span> : null}
      {updateAvailable ? (
        <ReminderDot overlay className="rail-badge rail-badge-dot" aria-label="有新版本可更新" />
      ) : null}
    </button>
  );

  useEffect(() => {
    if (!profileOpen) {
      return;
    }

    function closeFloating(event: globalThis.PointerEvent) {
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

    document.addEventListener('pointerdown', closeFloating, true);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeFloating, true);
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
          aria-label="主导航"
          onMouseDown={(event) => event.stopPropagation()}
        >
          {navigationEntries('rail').map(({ id, label, icon: Icon, target, workspace }) => {
            if (id === 'settings') return <Fragment key={id}>{settingsButton(true)}</Fragment>;
            const button = (
              <button
                key={id}
                type="button"
                className={cn(
                  railButtonClass(activeView === id),
                  'rail-tab',
                  `rail-tab-${id === 'collections' ? 'collection' : id}`,
                  id === 'tools' && 'rail-mobile-tool',
                  id === 'tools' && !showTools && 'rail-desktop-hidden',
                )}
                title={label}
                aria-current={activeView === id ? 'page' : undefined}
                onPointerEnter={() => {
                  if (workspace) preloadWorkspace(workspace);
                }}
                onFocus={() => {
                  if (workspace) preloadWorkspace(workspace);
                }}
                onClick={() => {
                  setProfileOpen(false);
                  if (id === 'messages' && activeView === 'messages' && onMessageBadgeClick)
                    onMessageBadgeClick();
                  else
                    activateNavigation(target, {
                      onViewChange: selectView,
                      onOpenCollection,
                      onOpenDressUp,
                      onOpenSettings,
                      onOpenTool: () => {},
                      onOpenNotice: () => {},
                    });
                }}
              >
                <span className="rail-tab-icon">
                  <Icon size={22} strokeWidth={1.5} aria-hidden />
                </span>
                <span className="rail-label">{label}</span>
                {id === 'contacts' && contactBadgeCount > 0 && (
                  <ReminderDot
                    overlay
                    className="rail-badge rail-badge-dot"
                    role="status"
                    aria-label="有新的好友或群通知"
                  />
                )}
                {id === 'mail' && mailBadgeCount > 0 && (
                  <ReminderCount
                    count={mailBadgeCount}
                    overlay
                    className="rail-badge rail-badge-mail"
                    role="status"
                    aria-label={`${mailBadgeCount} 封未读邮件`}
                    title={`${mailBadgeCount} 封未读邮件`}
                  />
                )}
              </button>
            );
            return id === 'messages' ? (
              <div key={id} className="rail-message-entry">
                {button}
                {messageBadgeCount > 0 && (
                  <ReminderCount
                    as="button"
                    count={messageBadgeCount}
                    overlay
                    className="rail-badge rail-message-badge"
                    title="定位首条未读会话"
                    aria-label={`定位首条未读会话，共 ${messageBadgeCount} 条未读消息`}
                    onClick={() => {
                      setProfileOpen(false);
                      if (onMessageBadgeClick) onMessageBadgeClick();
                      else selectView('messages');
                    }}
                  />
                )}
              </div>
            ) : (
              <Fragment key={id}>{button}</Fragment>
            );
          })}
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

function railButtonClass(active: boolean) {
  return cn('weq-rail-button', active && 'active');
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
