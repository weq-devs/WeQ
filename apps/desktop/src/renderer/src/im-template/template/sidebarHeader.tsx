// @ts-nocheck
import { ChevronRight, Plus, Search, UserPlus, UsersRound, RefreshCw } from 'lucide-react';
import { useContext, useEffect, useState, type ReactNode } from 'react';
import { ContactDirectoryContext } from '../../lib/conversationDirectory';
import { useContentMultiSelect } from '../../state/contentSelection';
import { DirectoryToolbar } from '../../components/DirectoryToolbar';
import { allSelectionIdsSelected, toggleAllSelectionIds } from '../../lib/multiSelection';
import { cn } from './classNames';
import { Avatar } from './primitives';
import type { ContactTab, MainView, User } from './types';
import { displayUserName } from './user';
import '../../styles/contact-navigation.css';

export function SidebarHeader({
  user,
  view,
  query,
  onQueryChange,
  onQuickInvite,
  onCreateGroup,
  onOpenProfile,
  onOpenFriendNotices,
  onOpenGroupNotices,
  contactTab,
  onContactTabChange,
  onRefreshContacts,
  refreshingContacts = false,
  showSearch = true,
  activeNotice,
  searchPanel,
  onSearchFocus,
  friendNoticeCount = 0,
  groupNoticeCount = 0,
}: {
  user: User;
  view: MainView;
  query: string;
  onQueryChange: (query: string) => void;
  onQuickInvite: () => void;
  onCreateGroup: () => void;
  onOpenProfile: () => void;
  onOpenFriendNotices: () => void;
  onOpenGroupNotices: () => void;
  contactTab: ContactTab;
  onContactTabChange: (tab: ContactTab) => void;
  onRefreshContacts?: () => void;
  refreshingContacts?: boolean;
  showSearch?: boolean;
  activeNotice: 'friend' | 'group' | null;
  /**
   * 挂在搜索框正下方的浮层（统一搜索下拉 / 最近搜索）。
   *
   * 由 SidebarHeader 自己渲染，而不是塞进可滚动的 sidebar-body —— 挂在 body 里
   * 的话它会跟着列表一起被滚走，会话列表滚到中间时根本看不见。
   */
  searchPanel?: ReactNode;
  onSearchFocus?: () => void;
  friendNoticeCount?: number;
  groupNoticeCount?: number;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const directory = useContext(ContactDirectoryContext);
  const selection = useContentMultiSelect({ kind: 'contacts', container: contactTab });

  useEffect(() => {
    if (!addOpen) {
      return;
    }

    function closeOnOutside(event: MouseEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest('.sidebar-add-wrap')) {
        return;
      }
      if (target instanceof Node) {
        setAddOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setAddOpen(false);
      }
    }

    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [addOpen]);

  function handleQuickInvite() {
    setAddOpen(false);
    onQuickInvite();
  }

  function handleCreateGroup() {
    setAddOpen(false);
    onCreateGroup();
  }

  function renderAddMenu() {
    return (
      <div className={cn('sidebar-add-wrap')}>
        <button
          className={cn('sidebar-add', addOpen && 'active')}
          title="添加"
          onClick={() => setAddOpen((open) => !open)}
        >
          <Plus size={24} />
        </button>
        {addOpen ? (
          <div className={cn('sidebar-add-menu')}>
            <button type="button" onClick={handleCreateGroup}>
              <UsersRound size={18} />
              <span>创建群聊</span>
            </button>
            <button type="button" onClick={handleQuickInvite}>
              <UserPlus size={18} />
              <span className="desktop-add-friend-label">添加好友/群聊</span>
              <span className="mobile-add-friend-label">加好友/群</span>
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const title =
    view === 'contacts'
      ? '联系人'
      : view === 'agentlab'
        ? 'AgentLab'
        : view === 'tools'
          ? '应用'
          : displayUserName(user);

  return (
    <div
      className={cn(
        'sidebar-header',
        !showSearch && 'sidebar-header-no-search',
        view === 'contacts' && 'sidebar-header-contacts',
      )}
    >
      <div className={cn('mobile-sidebar-top')}>
        <button className={cn('mobile-sidebar-avatar')} type="button" onClick={onOpenProfile}>
          <Avatar
            name={displayUserName(user)}
            avatarUrl={user.avatarUrl}
            seed={user.identityValue}
          />
        </button>
        <div className={cn('mobile-sidebar-title')}>
          <strong>{title}</strong>
          {view === 'messages' ? (
            <span>
              <i />
              在线
            </span>
          ) : null}
        </div>
        <div className={cn('mobile-sidebar-actions')}>{renderAddMenu()}</div>
      </div>
      {showSearch ? (
        <div className={cn('search-row')}>
          <label className={cn('search-box')}>
            <Search size={22} />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onFocus={() => onSearchFocus?.()}
              placeholder="搜索"
            />
          </label>
          <div className={cn('desktop-sidebar-add')}>{renderAddMenu()}</div>
          {searchPanel ? <div className={cn('search-panel-slot')}>{searchPanel}</div> : null}
        </div>
      ) : null}
      {view === 'contacts' ? (
        <div className={cn('contact-tools')}>
          <DirectoryToolbar
            noun="联系人"
            query={directory?.query ?? ''}
            onQuery={(value) => directory?.onQuery(value)}
            selecting={selection.selectionMode}
            onSelecting={selection.setSelectionMode}
            count={selection.selectedIds.size}
            allSelected={allSelectionIdsSelected(directory?.ids ?? [], selection.selectedIds)}
            onSelectAll={() =>
              selection.setSelectedIds(
                toggleAllSelectionIds(directory?.ids ?? [], selection.selectedIds),
              )
            }
          >
            {onRefreshContacts ? (
              <button
                type="button"
                onClick={onRefreshContacts}
                disabled={refreshingContacts}
                aria-label={refreshingContacts ? '正在刷新联系人' : '刷新联系人列表'}
                title={refreshingContacts ? '正在刷新联系人' : '刷新联系人列表'}
                aria-busy={refreshingContacts}
              >
                <RefreshCw size={15} className={refreshingContacts ? 'spin' : undefined} />
              </button>
            ) : null}
          </DirectoryToolbar>
          <button
            type="button"
            className={cn(contactToolButtonClass(activeNotice === 'friend'))}
            aria-current={activeNotice === 'friend' ? 'page' : undefined}
            onClick={onOpenFriendNotices}
          >
            <span className={cn('notice-entry-label')}>
              <UserPlus size={17} aria-hidden />
              <span className={cn('desktop-notice-label')}>好友通知</span>
              <span className={cn('mobile-notice-label')}>新朋友</span>
              {friendNoticeCount > 0 && (
                <span className="notice-entry-dot" role="status" aria-label="有新的好友通知" />
              )}
            </span>
            <ChevronRight size={20} />
          </button>
          <button
            type="button"
            className={cn(contactToolButtonClass(activeNotice === 'group'))}
            aria-current={activeNotice === 'group' ? 'page' : undefined}
            onClick={onOpenGroupNotices}
          >
            <span className={cn('notice-entry-label')}>
              <UsersRound size={17} aria-hidden />
              群通知
              {groupNoticeCount > 0 && (
                <span className="notice-entry-dot" role="status" aria-label="有新的群通知" />
              )}
            </span>
            <ChevronRight size={20} />
          </button>
          <div className="contact-list-controls">
            <div className={cn('contact-tab-switch')} role="tablist" aria-label="联系人类型">
              <button
                type="button"
                className={cn(contactTabButtonClass(contactTab === 'friends'))}
                onClick={() => onContactTabChange('friends')}
              >
                好友
              </button>
              <button
                type="button"
                className={cn(contactTabButtonClass(contactTab === 'groups'))}
                onClick={() => onContactTabChange('groups')}
              >
                群聊
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function contactToolButtonClass(active: boolean) {
  return cn('weq-contact-notice-entry', active && 'active');
}

function contactTabButtonClass(active: boolean) {
  return cn(active && 'active');
}
