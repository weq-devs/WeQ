// @ts-nocheck
import { occupationText } from '@weq/protocol/profile-values';
import {
  BellOff,
  Bot,
  Hash,
  PenLine,
  Pin,
  MailOpen,
  Mail,
  EyeOff,
  MessageSquare,
  Users,
  UserRound,
  Circle,
  Smile,
  Clock,
  Minus,
  Ban,
  MinusCircle,
  ChevronRight,
  Trash2,
  RefreshCw,
  Plus,
  MessagesSquare,
  Sparkles,
  BarChart3,
  CloudDownload,
  Download,
  FolderInput,
  CalendarDays,
} from 'lucide-react';
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import type { ContactMetricRows } from '@weq/service';
import { conversationPinned } from '@weq/service/conversation-order';
import { sortConversationRows, reconcileConversationRows } from '../../lib/conversationListOrder';
import { useEventContextValue } from '../../hooks/useEventContextValue';
import {
  groupFriends,
  groupExtendedGroups,
  directoryTimeSeeds,
  sortFriends,
  sortGroups,
  type FriendSort,
} from '../../lib/contactListOrder';
import {
  friendDirectoryTitle,
  friendSortDetail,
  groupDirectoryTitle,
  groupSortDetail,
} from '../../lib/contactDirectoryPresentation';
import { useContactDirectoryOrder, useFrozenDirectory } from '../../hooks/useContactDirectoryOrder';
import { ContactDirectoryOrder } from '../../components/ContactDirectoryOrder';
import { conversationListSearchText } from '../../lib/conversationListSearchText';
import { formatConversationTime } from '../../lib/conversationTime';
export { formatConversationTime } from '../../lib/conversationTime';
import { useConversationClickTarget } from '../../hooks/useConversationClickTarget';
import { useConversationHoverOrder } from '../../hooks/useConversationHoverOrder';
import { preferenceValue, useClientPreferences } from '../../lib/clientPreferences';
import { useViewState } from '../../state/view';
import {
  ConversationDirectoryContext,
  ContactDirectoryContext,
  virtualConversationRow,
} from '../../lib/conversationDirectory';
import { VirtualConversationAvatar } from '../../components/VirtualConversationAvatar';
import { groupRelationship, RelationshipDirectoryContext } from '../../lib/contactRelationship';
import { SourceGroup } from '../../components/qq-actions/FriendClue';
import { useContentMultiSelect, useRequestContentExport } from '../../state/contentSelection';
import {
  conversationAnalysisTarget,
  conversationRoamingTarget,
} from '../../lib/conversationActions';
import { ConversationActionsMenu } from '../../components/ConversationActionsMenu';
import { ConversationMenuTarget } from '../../components/ConversationMenuTarget';
import { sidebarConversationsWithoutAssistant } from '../../lib/groupAssistant';
import { DirectoryToolbar } from '../../components/DirectoryToolbar';
import { ConversationBatchToolbar } from '../../components/ConversationBatchToolbar';
import { useConversationBatchActions } from '../../components/useConversationBatchActions';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import { FriendConversationActionsMenu } from '../../components/FriendConversationActionsMenu';
import { useFriendDirectory } from '../../components/FriendDirectoryControls';
import { QQExactLookup, type QQExactLookupKind } from '../../components/QQExactLookup';
import {
  allSelectionIdsSelected,
  toggleAllSelectionIds,
  invertSelectionIds,
} from '../../lib/multiSelection';
import { WindowedList } from '../../components/WindowedList';
import { useThemeStore } from '../../state/theme';
import '../../styles/conversation-directory.css';
import { cn } from './classNames';
import { Avatar, EmptyState, ListSkeleton } from './primitives';
import { isBotConversation } from './conversationDisplay';
import { messageMentionsUser } from './mentions';
import { resourceUrl } from '../../lib/resourceUrl';
import { FaceEmoji } from '../../components/FaceEmoji';
import type { PreviewNode } from '../../lib/conversationPreview';
import type {
  Contact,
  ContactSection,
  Conversation,
  ConversationDrafts,
  ConversationPreferences,
  OnlineStatusInfo,
  User,
} from './types';
import { GROUP_NOTIFICATION_SECTIONS, groupNotificationMode } from '../../lib/groupNotifications';
import { displayGroupName, displayUserName } from './user';
import { intimateRelationOf } from '../../lib/profileRelations';
import '../../styles/contact-relations.css';

/**
 * Progressive rendering for large lists:
 * render only the first INITIAL_PROGRESSIVE_ROWS rows on the first frame,
 * then append the rest in small batches over following frames, so mounting
 * a list with thousands of rows never blocks the main thread for long.
 * Resets to the first batch whenever the total row count changes.
 */
const INITIAL_PROGRESSIVE_ROWS = 50;
const PROGRESSIVE_BATCH_ROWS = 80;
const PROGRESSIVE_BATCH_MS = 20;

function useProgressiveRowCount(total: number): number {
  const [count, setCount] = useState(() => Math.min(total, INITIAL_PROGRESSIVE_ROWS));

  useEffect(() => {
    setCount(Math.min(total, INITIAL_PROGRESSIVE_ROWS));
    if (total <= INITIAL_PROGRESSIVE_ROWS) return undefined;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let next = INITIAL_PROGRESSIVE_ROWS;

    const tick = (): void => {
      if (cancelled) return;
      next = Math.min(next + PROGRESSIVE_BATCH_ROWS, total);
      setCount(next);
      if (next < total) {
        timer = window.setTimeout(tick, PROGRESSIVE_BATCH_MS);
      }
    };

    timer = window.setTimeout(tick, PROGRESSIVE_BATCH_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [total]);

  return count;
}

/**
 * 会话列表底部的「加载更多」哨兵：滚到可见区域自动拉下一页，同时给出手动按钮兜底。
 */
function ConversationListLoadMore({
  loading,
  onLoadMore,
}: {
  loading?: boolean;
  onLoadMore?: () => void;
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !onLoadMore) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries.some((entry) => entry.isIntersecting);
        if (hit && !loading) onLoadMore();
      },
      { rootMargin: '240px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [onLoadMore, loading]);

  return <div ref={sentinelRef} className="conversation-list-load-more" aria-hidden="true" />;
}

export function ConversationList({
  conversations,
  activeConversationId,
  preferences,
  drafts,
  user,
  onSelect,
  loading,
  onLoadMore,
  hasMore,
  loadingMore,
}: {
  conversations: Conversation[];
  activeConversationId: string | null;
  preferences: ConversationPreferences;
  drafts: ConversationDrafts;
  user?: User;
  onSelect: (conversationId: string, event?: React.MouseEvent) => void;
  loading?: boolean;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
}) {
  const directory = useContext(ConversationDirectoryContext);
  const requestExport = useRequestContentExport();
  const batch = useConversationBatchActions(conversations);
  const [actionMenu, setActionMenu] = useState<{
    conversation: Conversation;
    ids: string[];
    x: number;
    y: number;
  } | null>(null);
  const [keyword, setKeyword] = useState('');
  const [localScope, setLocalScope] = useState<ConversationScope>('all');
  const scope = directory?.scope ?? localScope;
  const setScope = directory?.onScopeChange ?? setLocalScope;
  const [scopeOpen, setScopeOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [lookupOpen, setLookupOpen] = useState<QQExactLookupKind | null>(null);
  const [selectingAll, setSelectingAll] = useState(false);
  const invertFrom = useRef<Set<string> | null>(null);
  const createMenuRef = useRef<HTMLDivElement>(null);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const { selectionMode, selectedIds, setSelectedIds, setSelectionMode, anchorRef } =
    useContentMultiSelect({
      kind: 'conversations',
      container: 'main-list',
    });
  const viewportRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(600);
  const [rowHeight, setRowHeight] = useState(62);
  const density = useThemeStore((state) => state.density);
  const componentStyle = useThemeStore((state) => state.componentStyle);
  const menuRef = useRef<HTMLDivElement>(null);
  useClientPreferences((state) => state.tick);
  const keepPosition = preferenceValue('keepConversationPositionOnHover');
  const account = useViewState((state) => state.openedUin);
  const [pointerInside, setPointerInside] = useState(false);
  useEffect(() => {
    const clear = () => setPointerInside(false);
    window.addEventListener('blur', clear);
    return () => window.removeEventListener('blur', clear);
  }, []);
  useEffect(() => setActionMenu(null), [account, scope, keyword]);
  const sorted = useMemo(() => {
    // 置顶会话排最前；其余按「最后一条消息时间」和真实会话混排。
    // 虚拟会话（克隆体 / 克隆群）以前是直接追加到末尾，看起来像永远不活跃的
    // 死会话 —— 现在按最近聊天时间插回正确位置。
    const needle = keyword.trim().toLocaleLowerCase();
    const real = needle ? (directory?.real ?? conversations) : conversations;
    // 显示范围按「来源」分：真实 / 虚拟（克隆）/ 频道私聊。频道私聊是合并入口，
    // 混在真实会话里会让人以为它是一条普通私聊，所以单独一档。
    const isGuild = (row: Conversation) =>
      row.type === 'merged' && row.mergedKind === 'guildDirect';
    const realRows = real.filter((row) => !isGuild(row));
    const guildRows = scope === 'guild' ? (directory?.guild ?? []) : real.filter(isGuild);
    const virtualRows = (directory?.virtual ?? []).map(virtualConversationRow);
    const rows = [
      ...(scope === 'all' || scope === 'real' ? realRows : []),
      ...(scope === 'all' || scope === 'guild' ? guildRows : []),
      ...(scope === 'all' || scope === 'virtual' ? virtualRows : []),
    ].filter((row) => !needle || conversationListSearchText(row).includes(needle));
    // 完整目录可用于查找操作目标，但不能绕过主列表的群助手归属。
    const visible = directory?.groupAssistantIds
      ? sidebarConversationsWithoutAssistant(rows, directory.groupAssistantIds)
      : rows;
    const ordered = sortConversationRows(visible, preferences);
    return { rows: ordered, ids: ordered.map((row) => row.id) };
  }, [
    conversations,
    preferences,
    directory?.virtual,
    directory?.real,
    directory?.groupAssistantIds,
    directory?.guild,
    keyword,
    scope,
  ]);
  const orderedRows = useConversationHoverOrder(
    sorted.rows,
    keepPosition && (pointerInside || Boolean(actionMenu)),
    `${account}:${scope}:${keyword}`,
  );
  const filtered = useMemo(
    () => ({ rows: orderedRows, ids: orderedRows.map((row) => row.id) }),
    [orderedRows],
  );
  useEffect(() => {
    if (actionMenu && !sorted.ids.includes(actionMenu.conversation.id)) setActionMenu(null);
  }, [actionMenu, sorted.ids]);
  const contextTargetIds = useMemo(
    () => new Set(actionMenu ? [actionMenu.conversation.id, ...actionMenu.ids] : []),
    [actionMenu],
  );
  const groupAssistantMenu =
    actionMenu?.conversation.type === 'merged' &&
    actionMenu.conversation.mergedKind === 'groupAssistant';
  const selectConversation = (id: string, event: React.MouseEvent) => {
    if (!filtered.ids.includes(id)) return;
    const virtual = directory?.virtual.find((item) => item.id === id);
    if (virtual) directory.onVirtual(virtual);
    else onSelect(id, event);
  };
  const clickTargetProps = useConversationClickTarget({
    rows: filtered.rows,
    enabled: !selectionMode,
    resetKey: `${scope}:${keyword}`,
    onSelect: selectConversation,
  });
  const assistantIds = useMemo(
    () =>
      (directory?.real ?? conversations)
        .filter((row) => row.type === 'group' && directory?.groupAssistantIds?.has(row.id))
        .map((row) => row.id),
    [directory?.real, conversations, directory?.groupAssistantIds],
  );
  const expandIds = useCallback(
    (ids: Iterable<string>) =>
      new Set([...ids].flatMap((id) => (id === 'merged:group-assistant' ? assistantIds : [id]))),
    [assistantIds],
  );
  const filteredIds = useMemo(() => [...expandIds(filtered.ids)], [expandIds, filtered]);
  const assistantSelected =
    assistantIds.length > 0 && assistantIds.every((id) => selectedIds.has(id));
  const rowSelectedIds = new Set(selectedIds);
  if (assistantSelected) rowSelectedIds.add('merged:group-assistant');
  const menuIds = (conversation: Conversation) =>
    // 群助手入口的菜单不继承内部群的选区；只有显式多选才展开内部会话。
    conversation.type === 'merged' && conversation.mergedKind === 'groupAssistant'
      ? [conversation.id]
      : selectionMode && rowSelectedIds.has(conversation.id)
        ? [...selectedIds]
        : [conversation.id];
  const allSelected = allSelectionIdsSelected(filteredIds, selectedIds);
  const toggleAll = () => {
    invertFrom.current = null;
    if (selectingAll) {
      setSelectingAll(false);
      return;
    }
    if (hasMore || loading) {
      setSelectionMode(true);
      setSelectingAll(true);
      onLoadMore?.();
      return;
    }
    setSelectedIds(toggleAllSelectionIds(filteredIds, selectedIds));
  };
  useEffect(() => {
    if (!selectingAll) return;
    if (!selectionMode || directory?.loadingError) {
      invertFrom.current = null;
      setSelectingAll(false);
      return;
    }
    if (!hasMore && !loadingMore && !loading) {
      const original = invertFrom.current;
      setSelectedIds((current) =>
        original
          ? invertSelectionIds(filteredIds, original)
          : new Set([...current, ...filteredIds]),
      );
      invertFrom.current = null;
      setSelectingAll(false);
    } else if (hasMore && !loadingMore) onLoadMore?.();
  }, [
    selectingAll,
    selectionMode,
    hasMore,
    loadingMore,
    loading,
    directory?.loadingError,
    filteredIds,
    onLoadMore,
    setSelectedIds,
  ]);
  const multi = useMultiSelection({
    anchorRef,
    ids: filtered.ids,
    selected: rowSelectedIds,
    onChange: (ids) => {
      invertFrom.current = null;
      if ((hasMore || loading) && filtered.ids.every((id) => ids.has(id))) {
        setSelectingAll(true);
        onLoadMore?.();
        return;
      }
      setSelectingAll(false);
      const next = expandIds(ids);
      if (assistantSelected && !ids.has('merged:group-assistant')) {
        for (const id of assistantIds) next.delete(id);
      }
      setSelectedIds(next);
    },
    enabled: selectionMode,
    onStart: () => setSelectionMode(true),
    onExit: () => setSelectionMode(false),
  });

  const locateId = directory?.locate?.id;
  const locateRevision = directory?.locate?.revision;
  const [locateHighlight, setLocateHighlight] = useState<{
    id: string;
    revision: number | undefined;
  } | null>(null);
  const locateAvailable =
    Boolean(locateId) && scope === 'all' && !keyword && filtered.ids.includes(locateId);
  useEffect(() => {
    if (!locateId || !locateAvailable) {
      setLocateHighlight(null);
      return;
    }
    setLocateHighlight({ id: locateId, revision: locateRevision });
    const timer = window.setTimeout(() => setLocateHighlight(null), 1500);
    return () => window.clearTimeout(timer);
  }, [locateId, locateRevision, locateAvailable]);
  useEffect(() => {
    if (!locateId) return;
    setKeyword('');
    setScope('all');
  }, [locateId, locateRevision, setScope]);
  useLayoutEffect(() => {
    const measure = () => {
      if (!viewportRef.current) return;
      setListHeight(Math.max(1, viewportRef.current.clientHeight));
      const configured = Number.parseFloat(
        getComputedStyle(viewportRef.current).getPropertyValue('--weq-conversation-row-height'),
      );
      setRowHeight(Number.isFinite(configured) && configured > 0 ? configured : 62);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (viewportRef.current) observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [density, componentStyle]);
  useEffect(() => {
    if (keyword && hasMore && !loadingMore) onLoadMore?.();
  }, [keyword, hasMore, loadingMore, onLoadMore]);
  useEffect(() => {
    if (!scopeOpen) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target))
        setScopeOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setScopeOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [scopeOpen]);
  useEffect(() => {
    if (!createOpen) return;
    createMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !createMenuRef.current?.contains(event.target))
        setCreateOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setCreateOpen(false);
      createTriggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [createOpen]);

  return (
    <div
      className="list-stack weq-conversation-directory"
      {...multi.rootProps}
      onPointerOverCapture={(event) => {
        if (event.pointerType === 'mouse')
          setPointerInside(event.currentTarget.contains(event.target));
      }}
      onPointerOutCapture={(event) => {
        if (event.pointerType === 'mouse' && !event.currentTarget.contains(event.relatedTarget))
          setPointerInside(false);
      }}
    >
      <DirectoryToolbar
        noun="会话"
        searchActions={
          directory?.onCalendar ? (
            <button
              type="button"
              title="会话日历"
              aria-label="会话日历"
              onClick={() => directory.onCalendar(keyword)}
            >
              <CalendarDays size={16} />
            </button>
          ) : null
        }
        query={keyword}
        onQuery={setKeyword}
        selecting={selectionMode}
        onSelecting={setSelectionMode}
        count={selectedIds.size}
        allSelected={allSelected}
        onSelectAll={toggleAll}
        selectingAll={selectingAll}
        onInvert={() => {
          if (hasMore || loading) {
            invertFrom.current = new Set(selectedIds);
            setSelectingAll(true);
            onLoadMore?.();
          } else setSelectedIds(invertSelectionIds(filteredIds, selectedIds));
        }}
        endAction={(searching, closeSearch) => (
          <div className="weq-directory-scope" ref={createMenuRef}>
            <button
              ref={createTriggerRef}
              type="button"
              title={searching ? '退出搜索会话' : '添加会话'}
              aria-label={searching ? '退出搜索会话' : '添加会话'}
              aria-haspopup={searching ? undefined : 'menu'}
              aria-expanded={searching ? undefined : createOpen}
              disabled={!searching && !directory}
              onClick={() => {
                if (searching) {
                  setCreateOpen(false);
                  closeSearch();
                  return;
                }
                setScopeOpen(false);
                setCreateOpen(!createOpen);
              }}
              onKeyDown={(event) => {
                if (searching || event.key !== 'ArrowDown') return;
                event.preventDefault();
                setScopeOpen(false);
                setCreateOpen(true);
              }}
            >
              <Plus size={16} className="weq-directory-add-icon" />
            </button>
            {createOpen && !searching ? (
              <div role="menu" className="weq-directory-scope-menu" aria-label="添加会话菜单">
                <button
                  type="button"
                  role="menuitem"
                  onKeyDown={(event) => {
                    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
                      event.preventDefault();
                    if (event.key === 'Tab') setCreateOpen(false);
                  }}
                  onClick={() => {
                    setCreateOpen(false);
                    directory?.onCreate();
                  }}
                >
                  <Bot size={16} />
                  新建好友克隆
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onKeyDown={(event) => {
                    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
                      event.preventDefault();
                    if (event.key === 'Tab') setCreateOpen(false);
                  }}
                  onClick={() => {
                    setCreateOpen(false);
                    if (directory?.onCreateGroup) directory.onCreateGroup();
                  }}
                  disabled={!directory?.onCreateGroup}
                >
                  <Users size={16} />
                  新建克隆体群聊
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCreateOpen(false);
                    setLookupOpen('user');
                  }}
                >
                  <UserRound size={16} />
                  QQ 号搜索
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCreateOpen(false);
                    setLookupOpen('group');
                  }}
                >
                  <Users size={16} />
                  群号搜索
                </button>
              </div>
            ) : null}
          </div>
        )}
      >
        <div className="weq-directory-scope" ref={menuRef}>
          <button
            type="button"
            title={`显示范围：${SCOPE_LABELS[scope]}`}
            aria-label="显示范围"
            aria-haspopup="menu"
            aria-expanded={scopeOpen}
            onClick={() => {
              setCreateOpen(false);
              setScopeOpen(!scopeOpen);
            }}
          >
            {scope === 'all' ? (
              <MessagesSquare size={16} />
            ) : scope === 'real' ? (
              <UserRound size={16} />
            ) : scope === 'guild' ? (
              <Hash size={16} />
            ) : (
              <Bot size={16} />
            )}
          </button>
          {scopeOpen ? (
            <div role="menu" className="weq-directory-scope-menu" aria-label="会话显示范围">
              {SCOPE_OPTIONS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={scope === item.id}
                  onClick={() => {
                    setScope(item.id);
                    setScopeOpen(false);
                  }}
                >
                  <item.icon size={16} />
                  {item.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {directory?.onCalendar ? (
          <button
            type="button"
            title="会话日历"
            aria-label="会话日历"
            onClick={() => directory.onCalendar(keyword)}
          >
            <CalendarDays size={16} />
          </button>
        ) : null}
      </DirectoryToolbar>
      {lookupOpen && (
        <QQExactLookup key={lookupOpen} kind={lookupOpen} onClose={() => setLookupOpen(null)} />
      )}
      {loading && !filtered.rows.length ? <ListSkeleton rows={9} /> : null}
      {directory?.loadingError ? (
        <div role="alert">
          会话读取失败：{directory.loadingError}
          <button type="button" onClick={onLoadMore}>
            重试
          </button>
        </div>
      ) : null}
      {!loading && !filtered.rows.length ? (
        <EmptyState title="暂无会话" body="" icon={<MessageSquare />} />
      ) : null}
      <div className="weq-conversation-viewport" ref={viewportRef} {...clickTargetProps}>
        <WindowedList
          bufferScreens={1}
          items={filtered.rows}
          onVisibleItems={selectionMode ? undefined : directory?.onVisibleConversations}
          rowHeight={rowHeight}
          height={listHeight}
          resetKey={`${scope}:${keyword}`}
          itemKey={(item) => item.id}
          scrollToKey={
            multi.focusRequest && multi.focusRequest.revision > (locateRevision ?? 0)
              ? multi.focusRequest.id
              : scope === 'all' && !keyword
                ? locateId
                : null
          }
          scrollRevision={Math.max(multi.focusRequest?.revision ?? 0, locateRevision ?? 0)}
          onNearEnd={hasMore && !loadingMore ? onLoadMore : undefined}
          className="weq-conversation-window"
          renderItem={(conversation) => {
            const active = conversation.id === activeConversationId;
            const unreadCount = conversation.unreadCount ?? 0;
            const hasDraft = !active && Boolean(drafts[conversation.id]?.trim());
            const preview = conversationLastMessage(conversation, user);
            // 提醒高亮：来自 48902 的权威标记（特别关心 / @我 …）。
            const highlightKinds = new Set((conversation.highlights ?? []).map((h) => h.kind));
            // @我：优先用 48902 权威标记，回退到本地对消息正文的启发式解析。
            const showMentionAlert =
              unreadCount > 0 && (highlightKinds.has('atMe') || preview.mentionsMe);
            // @全体成员：同属「找你」红色告警类。
            const showAtAll = unreadCount > 0 && highlightKinds.has('atAll');
            // 回复我：同属「找你」红色告警类。
            const showReplyMe = unreadCount > 0 && highlightKinds.has('replyMe');
            // 特别关心：会话存在特别关心好友未读时，行首挂红色标记。
            const showSpecialCare = unreadCount > 0 && highlightKinds.has('specialCare');
            // 新文件：内容类提示（非「找你」告警），行首挂蓝色标记。
            const showNewFile = unreadCount > 0 && highlightKinds.has('newFile');
            // QQ红包：内容类提示，行首挂金色标记。
            const showRedPacket = unreadCount > 0 && highlightKinds.has('redPacket');
            // 群公告：内容类提示（群内广播），行首挂蓝色标记。
            const showGroupAnnouncement =
              unreadCount > 0 && highlightKinds.has('groupAnnouncement');
            // 群提醒词：命中用户设置的关注词，与「找你」同类，行首挂红色标记。
            const showGroupKeyword = unreadCount > 0 && highlightKinds.has('groupKeyword');
            // 命中的关键词（可能多个）；让「[群提醒词]」能区分是哪个词命中的。
            const groupKeywordWords =
              unreadCount > 0
                ? [
                    ...new Set(
                      (conversation.highlights ?? [])
                        .filter((h) => h.kind === 'groupKeyword' && h.text)
                        .map((h) => h.text as string),
                    ),
                  ]
                : [];
            // 免打扰：会话自带的 DB 值（41220）打底，本地手动偏好覆盖 ——
            // 与 shellController.countVisibleUnreadConversations 的 merge 顺序保持一致。
            const muted = Boolean(
              {
                ...conversation.preference,
                ...preferences[conversation.id],
              }.muted,
            );
            const pinned = isPinned(conversation, preferences);
            const virtualRow = directory?.virtual.find((item) => item.id === conversation.id);

            return (
              <button
                key={conversation.id}
                data-conversation-id={conversation.id}
                className={cn(
                  listRowClass(
                    !selectionMode && (active || contextTargetIds.has(conversation.id)),
                    'conversation-row',
                  ),
                  pinned && 'pinned',
                  locateHighlight?.id === conversation.id && 'is-locate-target',
                  selectionMode && rowSelectedIds.has(conversation.id) && 'is-multiselected',
                  contextTargetIds.has(conversation.id) && 'is-context-target',
                )}
                aria-pressed={selectionMode ? rowSelectedIds.has(conversation.id) : undefined}
                {...multi.itemProps(conversation.id)}
                onPointerEnter={() => {
                  if (!selectionMode) directory?.onConversationIntent?.(conversation);
                }}
                onFocus={() => {
                  if (!selectionMode) directory?.onConversationIntent?.(conversation);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setActionMenu({
                    conversation,
                    ids: menuIds(conversation),
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
                    return;
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  setActionMenu({
                    conversation,
                    ids: menuIds(conversation),
                    x: rect.left + 20,
                    y: rect.top + 20,
                  });
                }}
                onClick={(e) => selectConversation(conversation.id, e)}
              >
                {locateHighlight?.id === conversation.id ? (
                  <span
                    key={locateHighlight.revision}
                    className="weq-conversation-locate-highlight"
                    aria-hidden="true"
                  />
                ) : null}
                {conversation.type === 'merged' ? (
                  <span className={cn('avatar', 'has-default', 'merged-avatar')}>
                    {conversation.mergedKind === 'hidden' ? (
                      <EyeOff size={20} strokeWidth={2} />
                    ) : conversation.mergedKind === 'deleted' ? (
                      <Trash2 size={20} strokeWidth={2} />
                    ) : conversation.mergedKind === 'guildDirect' ? (
                      <Hash size={20} strokeWidth={2} />
                    ) : conversation.mergedKind === 'service' ||
                      conversation.mergedKind === 'groupAssistant' ? (
                      <Users size={20} strokeWidth={2} />
                    ) : (
                      <UserRound size={20} strokeWidth={2} />
                    )}
                  </span>
                ) : virtualRow ? (
                  <VirtualConversationAvatar item={virtualRow} />
                ) : (
                  <Avatar
                    resolution="small"
                    name={conversationTitle(conversation)}
                    avatarUrl={conversationAvatarUrl(conversation)}
                    seed={conversationSeed(conversation)}
                  />
                )}
                <span className={cn('row-main')}>
                  <strong>
                    <span className={cn('row-title-text')}>{conversationTitle(conversation)}</span>
                    {virtualRow ? (
                      <small
                        className={cn(
                          'weq-conversation-virtual',
                          virtualRow.kind === 'group' ? 'is-group' : 'is-persona',
                        )}
                        title={virtualRow.kind === 'group' ? '克隆群聊' : '克隆体'}
                        aria-label="虚拟会话"
                      >
                        {virtualRow.kind === 'group' ? (
                          <MessagesSquare size={11} />
                        ) : (
                          <Sparkles size={11} />
                        )}
                      </small>
                    ) : null}
                    {isBotConversation(conversation) ? (
                      <small className={cn('bot-badge')} aria-label="机器人" title="机器人">
                        <Bot size={12} strokeWidth={2.4} />
                      </small>
                    ) : null}
                  </strong>
                  <span className={cn('row-preview-line')}>
                    {hasDraft ? (
                      <span className={cn('row-draft')}>
                        <PenLine size={15} />
                        <span className={cn('row-draft-text')}>
                          {formatDraftPreview(drafts[conversation.id])}
                        </span>
                      </span>
                    ) : (
                      <span className={cn('row-message-preview')}>
                        {showSpecialCare ? (
                          <span className={cn('row-specialcare-alert')}>[特别关心]</span>
                        ) : null}
                        {showMentionAlert ? (
                          <span className={cn('row-mention-alert')}>[有人@我]</span>
                        ) : null}
                        {showAtAll ? (
                          <span className={cn('row-mention-alert')}>[@全体]</span>
                        ) : null}
                        {showReplyMe ? (
                          <span className={cn('row-mention-alert')}>[有人回复我]</span>
                        ) : null}
                        {showGroupKeyword ? (
                          <span className={cn('row-mention-alert')}>
                            {groupKeywordWords.length > 0
                              ? `[群提醒词·${groupKeywordWords.join('、')}]`
                              : '[群提醒词]'}
                          </span>
                        ) : null}
                        {showNewFile ? (
                          <span className={cn('row-newfile-alert')}>[新文件]</span>
                        ) : null}
                        {showGroupAnnouncement ? (
                          <span className={cn('row-newfile-alert')}>[群公告]</span>
                        ) : null}
                        {showRedPacket ? (
                          <span className={cn('row-redpacket-alert')}>[红包]</span>
                        ) : null}
                        {preview.nodes.length ? <PreviewNodes nodes={preview.nodes} /> : null}
                      </span>
                    )}
                    {!unreadCount && muted ? (
                      <BellOff className={cn('row-muted')} size={15} />
                    ) : null}
                  </span>
                </span>
                <span className={cn('row-meta')}>
                  <span className={cn('row-time-line')}>
                    {pinned ? (
                      <Pin
                        className={cn('row-pinned')}
                        size={12}
                        aria-label="置顶"
                        title="置顶会话"
                      />
                    ) : null}
                    {conversation.hidden ? (
                      <EyeOff
                        className={cn('row-hidden')}
                        size={12}
                        aria-label="隐藏会话"
                        title="隐藏会话"
                      />
                    ) : null}
                    {formatConversationTime(conversation.updatedAt)}
                  </span>
                  {unreadCount &&
                  (conversation.mergedKind !== 'groupAssistant' ||
                    directory?.showGroupAssistantMessageCount) ? (
                    <span className={cn(unreadClass(muted))}>{formatBadgeCount(unreadCount)}</span>
                  ) : null}
                </span>
              </button>
            );
          }}
        />
      </div>
      {hasMore ? <ConversationListLoadMore loading={loadingMore} onLoadMore={onLoadMore} /> : null}
      {selectionMode ? (
        <ConversationBatchToolbar
          conversations={conversations}
          ids={[...selectedIds]}
          busy={selectingAll}
        />
      ) : null}
      {actionMenu ? (
        <FriendConversationActionsMenu
          friendUid={
            actionMenu.ids.length === 1 &&
            actionMenu.conversation.type === 'direct' &&
            actionMenu.conversation.otherUser.kind !== 'bot'
              ? actionMenu.conversation.otherUser.id
              : undefined
          }
          x={actionMenu.x}
          y={actionMenu.y}
          label={
            actionMenu.ids.length > 1
              ? `已选 ${actionMenu.ids.length} 个会话的操作`
              : `${conversationTitle(actionMenu.conversation)}的会话操作`
          }
          target={
            <ConversationMenuTarget
              name={conversationTitle(actionMenu.conversation)}
              avatarUrl={conversationAvatarUrl(actionMenu.conversation)}
              identity={conversationSeed(actionMenu.conversation)}
              kind={actionMenu.conversation.type}
              count={actionMenu.ids.length}
              containedCount={
                groupAssistantMenu
                  ? (directory?.groupAssistantIds?.size ?? assistantIds.length)
                  : undefined
              }
            />
          }
          onClose={() => setActionMenu(null)}
          actions={(() => {
            return [
              ...(directory?.onReadState && !groupAssistantMenu
                ? [
                    ...[false, true].map((unread) => ({
                      label: unread ? '标为未读' : '标为已读',
                      icon: unread ? <Mail size={16} /> : <MailOpen size={16} />,
                      disabled: directory.readStateBusy || actionMenu.ids.length > 4096,
                      action: () => batch.runReadState(actionMenu.ids, unread),
                    })),
                  ]
                : []),
              ...(directory?.onPin &&
              (actionMenu.ids.length === 1 || actionMenu.conversation.type === 'merged')
                ? [
                    {
                      label: isPinned(actionMenu.conversation, preferences) ? '取消置顶' : '置顶',
                      icon: <Pin size={16} />,
                      action: () =>
                        directory.onPin(
                          actionMenu.conversation,
                          !isPinned(actionMenu.conversation, preferences),
                        ),
                    },
                  ]
                : []),
              ...(directory?.onAnalyze &&
              actionMenu.ids.length === 1 &&
              conversationAnalysisTarget(actionMenu.conversation)
                ? [
                    {
                      label: '分析',
                      icon: <BarChart3 size={16} />,
                      action: () => directory.onAnalyze(actionMenu.conversation),
                    },
                  ]
                : []),
              ...(directory?.onEditRemark &&
              actionMenu.ids.length === 1 &&
              conversationRoamingTarget(actionMenu.conversation)
                ? [
                    {
                      label:
                        actionMenu.conversation.type === 'group' ? '修改群备注' : '修改好友备注',
                      icon: <PenLine size={16} />,
                      action: () => directory.onEditRemark(actionMenu.conversation),
                    },
                  ]
                : []),
              ...(requestExport && !groupAssistantMenu
                ? [
                    {
                      label: actionMenu.ids.length > 1 ? '导出所选会话' : '导出',
                      icon: <Download size={16} />,
                      action: () => batch.runExport(actionMenu.ids),
                    },
                  ]
                : []),
              ...(requestExport &&
              actionMenu.ids.length === 1 &&
              actionMenu.conversation.type === 'group' &&
              conversationRoamingTarget(actionMenu.conversation)
                ? [
                    {
                      label: '导出群成员名单',
                      icon: <Users size={16} />,
                      action: () =>
                        requestExport({
                          owner: {
                            kind: 'contacts',
                            container: `group:${actionMenu.conversation.group.id}`,
                          },
                          scope: { type: 'all' },
                        }),
                    },
                  ]
                : []),
              ...(directory?.onRoaming && !groupAssistantMenu
                ? [
                    {
                      label: actionMenu.ids.length > 1 ? '拉取所选会话漫游消息' : '拉取漫游消息',
                      icon: <CloudDownload size={16} />,
                      action: () => batch.runRoaming(actionMenu.ids),
                    },
                  ]
                : []),
            ];
          })()}
        />
      ) : null}
      {batch.confirmation}
    </div>
  );
}

export function GroupList({
  conversations,
  activeConversationId,
  onSelect,
  loading,
}: {
  conversations: Conversation[];
  activeConversationId: string | null;
  onSelect: (conversationId: string, event?: React.MouseEvent) => void;
  loading?: boolean;
}) {
  const relationships = useContext(RelationshipDirectoryContext);
  const directory = useContext(ContactDirectoryContext);
  const conversationDirectory = useContext(ConversationDirectoryContext);
  const batch = useConversationBatchActions(conversations);
  const [actionMenu, setActionMenu] = useState<{
    conversation: Conversation;
    ids: string[];
    x: number;
    y: number;
  } | null>(null);
  const needle = directory?.query.trim().toLocaleLowerCase() ?? '';
  const searchable = useMemo(
    () =>
      conversations.filter(
        (item) =>
          !needle ||
          `${conversationTitle(item)} ${conversationSeed(item)} ${item.type === 'group' ? item.group.name : ''}`
            .toLocaleLowerCase()
            .includes(needle),
      ),
    [conversations, needle],
  );
  const groupSelection = useContentMultiSelect({ kind: 'contacts', container: 'groups' });
  const metricEntities = useMemo(
    () => conversations.filter((row) => row.type === 'group').map((row) => [`group:${row.id}`]),
    [conversations],
  );
  const timeSeeds = useCallback(
    () => directoryTimeSeeds(conversations, relationships?.selfUid),
    [conversations, relationships?.selfUid],
  );
  const order = useContactDirectoryOrder(
    'groups',
    groupSelection.selectionMode,
    metricEntities,
    timeSeeds,
  );
  const basis = order.preferences.grouping;
  const computedCategories = useMemo(() => {
    if (basis === 'none')
      return [
        {
          mode: 'none',
          label: '',
          items: sortGroups(
            searchable.filter((row) => row.type === 'group'),
            order.preferences.sort,
            order.preferences.descending,
            order.rows,
            order.rawGroupNames,
          ),
        },
      ];
    const groups = sortGroups(
      searchable.filter(
        (conversation) =>
          conversation.type === 'group' &&
          groupRelationship(conversation.group, relationships) === 'member',
      ),
      order.preferences.sort,
      order.preferences.descending,
      order.rows,
      order.rawGroupNames,
    );
    if (basis === 'identity')
      return [
        {
          mode: 'pinned',
          label: '置顶群聊',
          items: groups.filter((group) => group.preference?.pinned),
        },
        {
          mode: 'unnamed',
          label: '未命名的群聊',
          items: groups.filter((group) => group.group.unnamed),
        },
        {
          mode: 'owner',
          label: '我创建的群聊',
          items: groups.filter((group) => group.group.roleKnown && group.group.role === 'owner'),
        },
        {
          mode: 'admin',
          label: '我管理的群聊',
          items: groups.filter((group) => group.group.roleKnown && group.group.role === 'admin'),
        },
        {
          mode: 'member',
          label: '我加入的群聊',
          items: groups.filter((group) => group.group.roleKnown && group.group.role === 'member'),
        },
        ...(groups.some((group) => !group.group.roleKnown)
          ? [
              {
                mode: 'role-unknown',
                label: '身份未读取',
                items: groups.filter((group) => !group.group.roleKnown),
              },
            ]
          : []),
      ];
    if (basis === 'capacity') {
      const capacities = [
        ...new Set(groups.map((row) => row.group.maxMemberCount).filter((value) => value > 0)),
      ].sort((a, b) => a - b);
      return [
        ...capacities.map((capacity) => ({
          mode: `capacity:${capacity}`,
          label: `${capacity} 人群`,
          items: groups.filter((row) => row.group.maxMemberCount === capacity),
        })),
        ...(groups.some((group) => !(group.group.maxMemberCount > 0))
          ? [
              {
                mode: 'capacity-unknown',
                label: '群容量未知',
                items: groups.filter((group) => !(group.group.maxMemberCount > 0)),
              },
            ]
          : []),
      ];
    }
    if (basis === 'freezeState' || basis === 'grade')
      return groupExtendedGroups(groups, basis, order.rows);
    return GROUP_NOTIFICATION_SECTIONS.map((section) => ({
      ...section,
      items: groups.filter(
        (conversation) => groupNotificationMode(conversation.notifyLevel) === section.mode,
      ),
    }));
  }, [
    searchable,
    basis,
    relationships,
    order.preferences.sort,
    order.preferences.descending,
    order.rows,
    order.rawGroupNames,
  ]);
  const categories = useFrozenDirectory(
    computedCategories,
    groupSelection.selectionMode,
    `${order.scopeKey}:${JSON.stringify(order.preferences)}:${needle}`,
  );
  const historicalCategory = useMemo(
    () => ({
      mode: 'historical',
      label: '历史群聊',
      items: sortGroups(
        searchable.filter(
          (conversation) =>
            conversation.type === 'group' &&
            groupRelationship(conversation.group, relationships) === 'nonmember',
        ),
        order.preferences.sort,
        order.preferences.descending,
        order.rows,
        order.rawGroupNames,
      ),
    }),
    [
      searchable,
      relationships,
      order.preferences.sort,
      order.preferences.descending,
      order.rows,
      order.rawGroupNames,
    ],
  );
  const unknownCategory = useMemo(
    () => ({
      mode: 'membership-unknown',
      label: '其他群聊',
      items: sortGroups(
        searchable.filter(
          (conversation) =>
            conversation.type === 'group' &&
            groupRelationship(conversation.group, relationships) === 'unknown',
        ),
        order.preferences.sort,
        order.preferences.descending,
        order.rows,
        order.rawGroupNames,
      ),
    }),
    [
      searchable,
      relationships,
      order.preferences.sort,
      order.preferences.descending,
      order.rows,
      order.rawGroupNames,
    ],
  );
  const multi = useMultiSelection({
    ids: [
      ...new Set(
        [...categories, ...(basis === 'none' ? [] : [historicalCategory, unknownCategory])].flatMap(
          (category) => category.items.map((row) => row.id),
        ),
      ),
    ],
    selected: groupSelection.selectedIds,
    onChange: groupSelection.setSelectedIds,
    anchorRef: groupSelection.anchorRef,
    enabled: groupSelection.selectionMode,
    onStart: () => groupSelection.setSelectionMode(true),
    onExit: () => groupSelection.setSelectionMode(false),
  });

  if (loading) return <ListSkeleton rows={9} />;
  if (
    !categories.some((category) => category.items.length) &&
    !historicalCategory.items.length &&
    !unknownCategory.items.length
  )
    return <EmptyState title="暂无群聊" body="" icon={<Users />} />;
  return (
    <div className="weq-contact-directory" {...multi.rootProps}>
      <ContactDirectoryOrder order={order} />
      <div className={cn('list-stack', 'contact-cat-list', 'weq-contact-directory-scroll')}>
        {categories.map((category) => (
          <GroupNotificationSection
            key={category.mode}
            category={category}
            activeConversationId={activeConversationId}
            onSelect={onSelect}
            selection={groupSelection}
            multi={multi}
            onMenu={setActionMenu}
            order={order}
          />
        ))}
        <GroupNotificationSection
          category={basis === 'none' ? { ...historicalCategory, items: [] } : historicalCategory}
          activeConversationId={activeConversationId}
          onSelect={onSelect}
          selection={groupSelection}
          multi={multi}
          onMenu={setActionMenu}
          order={order}
        />
        <GroupNotificationSection
          category={basis === 'none' ? { ...unknownCategory, items: [] } : unknownCategory}
          activeConversationId={activeConversationId}
          onSelect={onSelect}
          selection={groupSelection}
          multi={multi}
          onMenu={setActionMenu}
          order={order}
        />
      </div>
      {groupSelection.selectionMode ? (
        <ConversationBatchToolbar
          conversations={conversations}
          ids={[...groupSelection.selectedIds]}
        />
      ) : null}
      {actionMenu ? (
        <ConversationActionsMenu
          x={actionMenu.x}
          y={actionMenu.y}
          onClose={() => setActionMenu(null)}
          actions={[
            ...(conversationDirectory?.onReadState
              ? [false, true].map((unread) => ({
                  label: unread ? '标为未读' : '标为已读',
                  icon: unread ? <Mail size={16} /> : <MailOpen size={16} />,
                  disabled: conversationDirectory.readStateBusy || actionMenu.ids.length > 4096,
                  action: () => batch.runReadState(actionMenu.ids, unread),
                }))
              : []),
            ...(actionMenu.ids.length === 1 && conversationDirectory?.onAnalyze
              ? [
                  {
                    label: '分析',
                    icon: <BarChart3 size={16} />,
                    action: () => conversationDirectory.onAnalyze(actionMenu.conversation),
                  },
                ]
              : []),
            ...(actionMenu.ids.length === 1 && conversationDirectory?.onEditRemark
              ? [
                  {
                    label: '修改群备注',
                    icon: <PenLine size={16} />,
                    action: () => conversationDirectory.onEditRemark(actionMenu.conversation),
                  },
                ]
              : []),
            {
              label: '拉取漫游消息',
              icon: <CloudDownload size={16} />,
              disabled: !batch.roamingAvailable,
              action: () => batch.runRoaming(actionMenu.ids),
            },
            {
              label: '导出',
              icon: <Download size={16} />,
              disabled: !batch.exportAvailable,
              action: () => batch.runExport(actionMenu.ids),
            },
            {
              label: '导出群成员名单',
              icon: <Users size={16} />,
              disabled: !batch.exportAvailable || !batch.rosterIds(actionMenu.ids).length,
              action: () => batch.runRoster(actionMenu.ids),
            },
          ]}
        />
      ) : null}
      {batch.confirmation}
    </div>
  );
}

function GroupNotificationSection({
  category,
  activeConversationId,
  onSelect,
  selection,
  multi,
  onMenu,
  order,
}) {
  const directory = useContext(ContactDirectoryContext);
  const conversationDirectory = useContext(ConversationDirectoryContext);
  const containsActive = category.items.some(
    (conversation) => conversation.id === activeConversationId,
  );
  const [open, setOpen] = useState(containsActive);
  useEffect(() => {
    if (containsActive) setOpen(true);
  }, [containsActive]);
  const expanded =
    category.mode === 'none' || open || Boolean(directory?.query) || selection.selectionMode;
  const visibleCount = useProgressiveRowCount(expanded ? category.items.length : 0);
  if (category.items.length === 0) return null;
  return (
    <div className="contact-cat">
      <button
        type="button"
        className="contact-cat-header"
        hidden={category.mode === 'none'}
        aria-expanded={expanded}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRight className={cn('contact-cat-caret', open && 'is-open')} size={15} />
        <span className="contact-cat-name">{category.label}</span>
        <span className="contact-cat-count">{category.items.length}</span>
      </button>
      {expanded
        ? category.items.slice(0, visibleCount).map((conversation) => {
            const title = groupDirectoryTitle(
              conversation.group,
              order.preferences.sort,
              order.rawGroupNames,
            );
            const detail = groupSortDetail(conversation.group, order.preferences.sort, order.rows);
            return (
              <button
                type="button"
                key={conversation.id}
                className={cn(
                  listRowClass(
                    !selection.selectionMode && conversation.id === activeConversationId,
                    'contact-row',
                  ),
                  'contact-cat-row',
                  selection.selectionMode &&
                    selection.selectedIds.has(conversation.id) &&
                    'is-multiselected',
                )}
                aria-pressed={
                  selection.selectionMode ? selection.selectedIds.has(conversation.id) : undefined
                }
                {...multi.itemProps(conversation.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onMenu({
                    conversation,
                    ids:
                      selection.selectionMode && selection.selectedIds.has(conversation.id)
                        ? [...selection.selectedIds]
                        : [conversation.id],
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
                    return;
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  onMenu({
                    conversation,
                    ids:
                      selection.selectionMode && selection.selectedIds.has(conversation.id)
                        ? [...selection.selectedIds]
                        : [conversation.id],
                    x: rect.left + 20,
                    y: rect.top + 20,
                  });
                }}
                onClick={(event) => onSelect(conversation.id, event)}
              >
                <Avatar
                  resolution="small"
                  name={displayGroupName(conversation.group)}
                  avatarUrl={conversation.group.avatarUrl}
                  seed={conversation.id}
                />
                <span className="row-main">
                  <strong>
                    <span className="row-title-text" title={title}>
                      {title}
                    </span>
                  </strong>
                  <span
                    className={detail ? 'weq-directory-sort-detail' : undefined}
                    title={detail?.title ? `${detail.text}\n${detail.title}` : detail?.text}
                  >
                    {detail
                      ? detail.text
                      : conversation.group.memberCount > 0
                        ? `${conversation.group.memberCount} 位成员`
                        : '人数未读取'}
                  </span>
                </span>
                {conversationDirectory?.showContactUnreadCount &&
                (conversation.unreadCount ?? 0) > 0 ? (
                  <span
                    className={unreadClass(
                      Boolean(
                        conversationDirectory?.preferences?.[conversation.id]?.muted ??
                          conversation.preference?.muted,
                      ),
                    )}
                  >
                    {formatBadgeCount(conversation.unreadCount)}
                  </span>
                ) : null}
              </button>
            );
          })
        : null}
    </div>
  );
}

const EMPTY_CONTACT_OPTIONS = [] as const;

type ContactRowEvents = {
  selection: ReturnType<typeof useMultiSelection<string>>['itemProps'];
  select: (contact: Contact) => void;
  dragStart: (contact: Contact, event: DragEvent<HTMLButtonElement>) => void;
  dragEnd: () => void;
  menu: (contact: Contact, event: MouseEvent<HTMLButtonElement>) => void;
  keyDown: (contact: Contact, event: KeyboardEvent<HTMLButtonElement>) => void;
};

const ContactDirectoryRow = memo(function ContactDirectoryRow({
  contact,
  categoryId,
  active,
  selectionMode,
  selected,
  draggable,
  unreadCount,
  muted,
  sort,
  identityMetrics,
  uidMetrics,
  events,
}: {
  contact: Contact;
  categoryId: string | number;
  active: boolean;
  selectionMode: boolean;
  selected: boolean;
  draggable: boolean;
  unreadCount: number;
  muted: boolean;
  sort: FriendSort;
  identityMetrics: ContactMetricRows[string] | undefined;
  uidMetrics: ContactMetricRows[string] | undefined;
  events: ContactRowEvents;
}) {
  const relation = intimateRelationOf(contact);
  const title = friendDirectoryTitle(contact, sort);
  const detail = friendSortDetail(contact, sort, {
    [`friend:${contact.identityValue}`]: identityMetrics ?? {},
    [`friend:${contact.id}`]: uidMetrics ?? {},
  });
  // 未重画行的捕获事件也按调用时获取最新范围、选择模式和锚点。
  const selectionId = JSON.stringify([categoryId, contact.id]);
  const sourceGroup = identityMetrics?.sourceGroup?.value || uidMetrics?.sourceGroup?.value;
  return (
    <>
      <button
        className={cn(
          listRowClass(active, 'contact-row'),
          'contact-cat-row',
          selected && 'is-multiselected',
        )}
        aria-pressed={selectionMode ? selected : undefined}
        {...events.selection(selectionId)}
        onPointerDownCapture={(event) => events.selection(selectionId).onPointerDownCapture(event)}
        onClickCapture={(event) => events.selection(selectionId).onClickCapture(event)}
        onContextMenuCapture={(event) => events.selection(selectionId).onContextMenuCapture(event)}
        draggable={draggable}
        onDragStart={(event) => events.dragStart(contact, event)}
        onDragEnd={events.dragEnd}
        onContextMenu={(event) => events.menu(contact, event)}
        onKeyDown={(event) => events.keyDown(contact, event)}
        onClick={() => events.select(contact)}
      >
        <span className="contact-relation-avatar">
          <Avatar
            resolution="small"
            name={displayUserName(contact)}
            avatarUrl={contact.avatarUrl}
            seed={contact.identityValue}
          />
          {relation ? (
            <span
              className="contact-relation-mark"
              role="img"
              aria-label={`亲密关系：${relation.label}`}
              title={relation.label}
            >
              <relation.Icon size={13} aria-hidden="true" />
            </span>
          ) : null}
        </span>
        <span className={cn('row-main', 'contact-card-main')}>
          <span className={cn('contact-card-nickname')}>
            <span className="row-title-text" title={title}>
              {title}
            </span>
            {contact.kind === 'bot' ? (
              <small className={cn('bot-badge')} aria-label="机器人" title="机器人">
                <Bot size={12} strokeWidth={2.4} />
              </small>
            ) : null}
          </span>
          <span className={cn('contact-card-bottom')}>
            {detail ? (
              <span
                className="contact-card-signature weq-directory-sort-detail"
                title={detail.title ? `${detail.text}\n${detail.title}` : detail.text}
              >
                {detail.text}
              </span>
            ) : (
              <>
                {contact.onlineStatusObj && contact.onlineStatusObj.typeName !== '未知' ? (
                  <span className={cn('contact-card-status')}>
                    <ContactOnlineStatusIcon status={contact.onlineStatusObj} />
                    <span>[{contact.onlineStatusObj.displayStatus}]</span>
                  </span>
                ) : null}
                {contact.kind !== 'bot' &&
                contact.identityLabel !== '设备' &&
                categoryId !== 'special:devices' &&
                categoryId !== 'special:bots' ? (
                  <span className={cn('contact-card-signature')}>
                    {contact.signature || '这个人很懒，什么都没留下'}
                  </span>
                ) : null}
              </>
            )}
          </span>
        </span>
        {unreadCount > 0 ? (
          <span className={unreadClass(muted)}>{formatBadgeCount(unreadCount)}</span>
        ) : null}
      </button>
      {String(categoryId).startsWith('derived:source:') &&
      typeof sourceGroup === 'string' &&
      /^[1-9]\d*$/.test(sourceGroup) &&
      !selectionMode ? (
        <SourceGroup code={sourceGroup} source={null} directoryLink />
      ) : null}
    </>
  );
});

/** 群消息只更新群目录，不唤醒未变化的整组好友行。 */
export function ContactList(props: ComponentProps<typeof ContactListContent>) {
  const directory = useContext(ConversationDirectoryContext);
  const previous = useRef<Conversation[]>([]);
  const real = useMemo(
    () =>
      reconcileConversationRows(
        previous.current,
        (directory?.real ?? []).filter((row) => row.type === 'direct'),
      ),
    [directory?.real],
  );
  useLayoutEffect(() => {
    previous.current = real;
  }, [real]);
  const value = useEventContextValue({ ...directory, real });
  return (
    <ConversationDirectoryContext.Provider value={directory ? value : null}>
      <ContactListContent {...props} />
    </ConversationDirectoryContext.Provider>
  );
}

const ContactListContent = memo(function ContactListContent({
  contacts,
  categoryDefinitions = EMPTY_CONTACT_OPTIONS,
  specialSections = EMPTY_CONTACT_OPTIONS,
  trailingSections = EMPTY_CONTACT_OPTIONS,
  activeContactId,
  onSelect,
  loading,
}: {
  contacts: Contact[];
  categoryDefinitions?: readonly {
    id: number;
    name: string;
    buddyCount: number;
    sortOrder?: number;
  }[];
  specialSections?: readonly ContactSection[];
  trailingSections?: readonly ContactSection[];
  activeContactId: string | null;
  onSelect: (contact: Contact) => void;
  loading?: boolean;
}) {
  const directory = useContext(ContactDirectoryContext);
  const contactIds = useMemo(() => new Set(contacts.map((contact) => contact.id)), [contacts]);
  const relationships = useContext(RelationshipDirectoryContext);
  const conversationDirectory = useContext(ConversationDirectoryContext);
  const friendDirectory = useFriendDirectory();
  const requestExport = useRequestContentExport();
  const [actionMenu, setActionMenu] = useState<{
    x: number;
    y: number;
    contact: Contact;
    ids: string[];
  } | null>(null);
  const [categoryMenu, setCategoryMenu] = useState<{ x: number; y: number; id: number } | null>(
    null,
  );
  const [dragTarget, setDragTarget] = useState<{
    id: number;
    position: 'before' | 'after' | 'inside';
  } | null>(null);
  const dragging = useRef<{ category?: number; uids?: string[] } | null>(null);
  const conversationRows = useMemo(() => {
    const byUserId = new Map(
      (conversationDirectory?.real ?? [])
        .filter((row) => row.type === 'direct')
        .map((row) => [row.otherUser.id, row]),
    );
    return [
      ...contacts,
      ...specialSections.flatMap((section) => section.items),
      ...trailingSections.flatMap((section) => section.items),
    ].map(
      (contact): Conversation =>
        byUserId.get(contact.id) ?? {
          id: contact.id,
          type: 'direct',
          otherUser: contact,
          group: null,
          members: [],
          updatedAt: '',
          lastMessage: null,
        },
    );
  }, [contacts, specialSections, trailingSections, conversationDirectory?.real]);
  const conversationByContact = useMemo(
    () =>
      new Map(
        conversationRows
          .filter((row) => row.type === 'direct')
          .map((row) => [row.otherUser.id, row]),
      ),
    [conversationRows],
  );
  const batch = useConversationBatchActions(conversationRows);
  const selection = useContentMultiSelect({ kind: 'contacts', container: 'friends' });
  const allContacts = useMemo(
    () => [
      ...new Map(
        [
          ...contacts,
          ...specialSections.flatMap((section) => section.items),
          ...trailingSections.flatMap((section) => section.items),
        ].map((contact) => [contact.id, contact]),
      ).values(),
    ],
    [contacts, specialSections, trailingSections],
  );
  const metricEntities = useMemo(
    () => allContacts.map((contact) => [`friend:${contact.identityValue}`, `friend:${contact.id}`]),
    [allContacts],
  );
  const timeSeeds = useCallback(
    () => directoryTimeSeeds(conversationRows, relationships?.selfUid),
    [conversationRows, relationships?.selfUid],
  );
  const order = useContactDirectoryOrder(
    'friends',
    selection.selectionMode,
    metricEntities,
    timeSeeds,
  );
  const needle = directory?.query.trim().toLocaleLowerCase() ?? '';
  const matches = useCallback(
    (contact: Contact) =>
      !needle ||
      `${displayUserName(contact)} ${contact.nick ?? ''} ${contact.identityValue} ${occupationText(contact.extInfo?.occupation) ?? ''}`
        .toLocaleLowerCase()
        .includes(needle),
    [needle],
  );
  const filtered = useMemo(() => contacts.filter(matches), [contacts, matches]);

  // 派生分组使用字符串 ID，不能触发 QQ 分组的编辑与拖拽。
  const computedCategories = useMemo(() => {
    if (['type', 'source', 'school'].includes(order.preferences.grouping))
      return groupFriends(
        allContacts.filter(matches),
        order.preferences.grouping,
        order.rows,
        order.regions,
        relationships,
      ).map((section) => ({
        ...section,
        items: sortFriends(
          section.items,
          order.preferences.sort,
          order.preferences.descending,
          order.rows,
        ),
      }));
    if (order.preferences.grouping === 'none') {
      const all = [
        ...new Map(
          [
            ...filtered,
            ...specialSections
              .filter((section) => !['special:care', 'special:intimate'].includes(section.id))
              .flatMap((section) => section.items.filter(matches)),
            ...trailingSections.flatMap((section) => section.items.filter(matches)),
          ].map((contact) => [contact.id, contact]),
        ).values(),
      ];
      return [
        {
          id: 'derived:none',
          name: '',
          items: sortFriends(all, order.preferences.sort, order.preferences.descending, order.rows),
        },
      ];
    }
    const map = new Map<number, { id: number; name: string; items: Contact[]; order: number }>();
    (friendDirectory?.categories ?? categoryDefinitions).forEach((category, index) => {
      map.set(category.id, {
        id: category.id,
        name: category.name || (category.id === 0 ? '我的好友' : '未命名分组'),
        items: [],
        order: category.sortOrder ?? index,
      });
    });
    for (const contact of filtered) {
      const id = friendDirectory?.assignments.get(contact.id) ?? contact.categoryId ?? 0;
      if (!map.has(id))
        map.set(id, {
          id,
          name: contact.categoryName || (id === 0 ? '我的好友' : '未归属联系人'),
          items: [],
          order: Infinity,
        });
      map.get(id)!.items.push(contact);
    }
    const ordinary =
      order.preferences.grouping === 'qq'
        ? [...map.values()].sort((first, second) => first.order - second.order)
        : groupFriends(filtered, order.preferences.grouping, order.rows, order.regions);
    return [
      ...specialSections
        .filter(
          (section) =>
            section.id !== 'special:intimate' &&
            (section.id !== 'special:care' ||
              ['qq', 'relation'].includes(order.preferences.grouping)),
        )
        .map((section) => ({ ...section, items: section.items.filter(matches) })),
      ...ordinary,
      ...trailingSections.map((section) => ({ ...section, items: section.items.filter(matches) })),
    ].map((section) => ({
      ...section,
      items: sortFriends(
        section.items,
        order.preferences.sort,
        order.preferences.descending,
        order.rows,
      ),
    }));
  }, [
    filtered,
    allContacts,
    relationships,
    categoryDefinitions,
    specialSections,
    trailingSections,
    matches,
    friendDirectory?.categories,
    friendDirectory?.assignments,
    order.preferences,
    order.rows,
    order.regions,
  ]);
  const categories = useFrozenDirectory(
    computedCategories,
    selection.selectionMode,
    `${order.scopeKey}:${JSON.stringify(order.preferences)}:${needle}`,
  );
  // 同一好友在特别关心、亲密关系及普通分组中各有独立的范围位置。
  const selectionRows = useMemo(
    () =>
      new Map(
        categories.flatMap((category) =>
          category.items.map((item) => [JSON.stringify([category.id, item.id]), item.id]),
        ),
      ),
    [categories],
  );
  const selectionIds = useMemo(() => [...selectionRows.keys()], [selectionRows]);
  const getSelectionId = useCallback((id: string) => selectionRows.get(id)!, [selectionRows]);

  // 默认全部折叠。
  const [expanded, setExpanded] = useState<Record<string | number, boolean>>({});
  const multi = useMultiSelection({
    ids: selectionIds,
    getSelectionId,
    selected: selection.selectedIds,
    onChange: selection.setSelectedIds,
    anchorRef: selection.anchorRef,
    enabled: selection.selectionMode,
    onStart: () => selection.setSelectionMode(true),
    onExit: () => selection.setSelectionMode(false),
  });
  const rowEvents = useEventContextValue<ContactRowEvents>({
    selection: multi.itemProps,
    select: (contact) => {
      if (!selection.selectionMode) onSelect(contact);
    },
    dragStart: (contact, event) => {
      const ids =
        selection.selectionMode && selection.selectedIds.has(contact.id)
          ? [...selection.selectedIds]
          : [contact.id];
      const uids = ids.filter((id) => contactIds.has(id));
      if (uids.length !== ids.length || !uids.length) {
        event.preventDefault();
        return;
      }
      dragging.current = { uids };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', uids.join(','));
    },
    dragEnd: () => {
      dragging.current = null;
      setDragTarget(null);
    },
    menu: (contact, event) => {
      event.preventDefault();
      setCategoryMenu(null);
      setActionMenu({
        x: event.clientX,
        y: event.clientY,
        contact,
        ids:
          selection.selectionMode && selection.selectedIds.has(contact.id)
            ? [...selection.selectedIds]
            : [contact.id],
      });
    },
    keyDown: (contact, event) => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      setActionMenu({ x: rect.left, y: rect.bottom, contact, ids: [contact.id] });
    },
  });

  if (loading) {
    return <ListSkeleton rows={9} />;
  }

  if (categories.length === 0 && !friendDirectory?.error) {
    return (
      <EmptyState
        title="暂无联系人"
        body="通过 ID 搜索或邀请链接添加联系人。"
        icon={<UserRound />}
      />
    );
  }

  return (
    <div className="weq-contact-directory" {...multi.rootProps}>
      <ContactDirectoryOrder order={order} />
      <div className={cn('list-stack', 'contact-cat-list', 'weq-contact-directory-scroll')}>
        {friendDirectory?.error && (
          <div className="contact-cat-description" role="alert">
            <small>好友分组读取失败：{friendDirectory.error}</small>
            <button
              type="button"
              title="重新读取好友分组"
              aria-label="重新读取好友分组"
              onClick={friendDirectory.retry}
            >
              <RefreshCw size={14} />
            </button>
          </div>
        )}
        {categories.map((category) => {
          const open =
            order.preferences.grouping === 'none' ||
            Boolean(expanded[category.id]) ||
            Boolean(needle);
          return (
            <div
              className={cn(
                'contact-cat',
                dragTarget?.id === category.id &&
                  dragTarget.position === 'inside' &&
                  'is-contact-drop-target',
              )}
              key={category.id}
              data-drop-position={
                dragTarget?.id === category.id && dragTarget.position !== 'inside'
                  ? dragTarget.position
                  : undefined
              }
              onDragOver={(event) => {
                const source = dragging.current;
                if (
                  typeof category.id !== 'number' ||
                  !source ||
                  !friendDirectory?.available ||
                  friendDirectory.busy ||
                  source.category === category.id
                ) {
                  setDragTarget(null);
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                const rect = event.currentTarget.getBoundingClientRect();
                setDragTarget({
                  id: category.id,
                  position:
                    source.category === undefined
                      ? 'inside'
                      : event.clientY < rect.top + rect.height / 2
                        ? 'before'
                        : 'after',
                });
              }}
              onDragLeave={(event) => {
                if (
                  event.relatedTarget instanceof Node &&
                  event.currentTarget.contains(event.relatedTarget)
                )
                  return;
                setDragTarget(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDragTarget(null);
                const source = dragging.current;
                dragging.current = null;
                if (
                  typeof category.id !== 'number' ||
                  !source ||
                  !friendDirectory?.available ||
                  friendDirectory.busy
                )
                  return;
                if (source.category !== undefined && source.category !== category.id) {
                  const rect = event.currentTarget.getBoundingClientRect();
                  friendDirectory.sort(
                    source.category,
                    category.id,
                    event.clientY < rect.top + rect.height / 2 ? 'before' : 'after',
                  );
                } else if (source.uids?.length) friendDirectory.move(source.uids, category.id);
              }}
            >
              <button
                type="button"
                className={cn('contact-cat-header')}
                hidden={order.preferences.grouping === 'none'}
                draggable={
                  typeof category.id === 'number' &&
                  friendDirectory?.available &&
                  !friendDirectory.busy
                }
                onDragStart={(event) => {
                  if (typeof category.id !== 'number') return;
                  dragging.current = { category: category.id };
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', String(category.id));
                }}
                onDragEnd={() => {
                  dragging.current = null;
                  setDragTarget(null);
                }}
                onContextMenu={(event) => {
                  if (typeof category.id !== 'number') return;
                  event.preventDefault();
                  setActionMenu(null);
                  setCategoryMenu({ x: event.clientX, y: event.clientY, id: category.id });
                }}
                onKeyDown={(event) => {
                  if (
                    typeof category.id !== 'number' ||
                    (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
                  )
                    return;
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  setActionMenu(null);
                  setCategoryMenu({ x: rect.left, y: rect.bottom, id: category.id });
                }}
                aria-expanded={open}
                onClick={() =>
                  setExpanded((current) => ({
                    ...current,
                    [category.id]: !current[category.id],
                  }))
                }
              >
                <ChevronRight className={cn('contact-cat-caret', open && 'is-open')} size={15} />
                <span
                  className={cn('contact-cat-name')}
                  data-privacy-sensitive={
                    (typeof category.id === 'number' && category.id !== 0) || undefined
                  }
                >
                  {category.name}
                </span>
                <span className={cn('contact-cat-count')}>
                  {category.count === null ? '-' : (category.count ?? category.items.length)}
                </span>
              </button>
              {open && category.description ? (
                <div className={cn('contact-cat-description')} role="status">
                  <small>{category.description}</small>
                  {category.onRetry ? (
                    <button
                      type="button"
                      onClick={category.onRetry}
                      title="重新读取特别关心"
                      aria-label="重新读取特别关心"
                    >
                      <RefreshCw size={12} />
                    </button>
                  ) : null}
                </div>
              ) : null}
              {open
                ? category.items.map((contact) => {
                    const conversation = conversationByContact.get(contact.id);
                    return (
                      <ContactDirectoryRow
                        key={contact.id}
                        contact={contact}
                        categoryId={category.id}
                        active={!selection.selectionMode && contact.id === activeContactId}
                        selectionMode={selection.selectionMode}
                        selected={selection.selectionMode && selection.selectedIds.has(contact.id)}
                        draggable={Boolean(
                          contactIds.has(contact.id) &&
                            order.preferences.grouping === 'qq' &&
                            friendDirectory?.available &&
                            !friendDirectory.busy,
                        )}
                        unreadCount={
                          conversationDirectory?.showContactUnreadCount
                            ? (conversation?.unreadCount ?? 0)
                            : 0
                        }
                        muted={Boolean(
                          conversationDirectory?.preferences?.[conversation?.id]?.muted ??
                            conversation?.preference?.muted,
                        )}
                        sort={order.preferences.sort}
                        identityMetrics={order.rows[`friend:${contact.identityValue}`]}
                        uidMetrics={order.rows[`friend:${contact.id}`]}
                        events={rowEvents}
                      />
                    );
                  })
                : null}
            </div>
          );
        })}
      </div>
      {selection.selectionMode ? (
        <ConversationBatchToolbar
          conversations={conversationRows}
          ids={[...selection.selectedIds]}
        />
      ) : null}
      {actionMenu && (
        <FriendConversationActionsMenu
          x={actionMenu.x}
          y={actionMenu.y}
          onClose={() => setActionMenu(null)}
          label="联系人操作"
          friendUid={
            actionMenu.ids.length === 1 && contacts.some((row) => row.id === actionMenu.contact.id)
              ? actionMenu.contact.id
              : undefined
          }
          actions={[
            ...(conversationDirectory?.onReadState
              ? [false, true].map((unread) => ({
                  label: unread ? '标为未读' : '标为已读',
                  icon: unread ? <Mail size={16} /> : <MailOpen size={16} />,
                  disabled: conversationDirectory.readStateBusy || actionMenu.ids.length > 4096,
                  action: () => batch.runReadState(actionMenu.ids, unread),
                }))
              : []),
            ...(actionMenu.ids.length === 1 &&
            conversationDirectory?.onAnalyze &&
            conversationAnalysisTarget(
              conversationRows.find((row) => row.id === actionMenu.contact.id),
            )
              ? [
                  {
                    label: '分析',
                    icon: <BarChart3 size={16} />,
                    action: () =>
                      conversationDirectory.onAnalyze(
                        conversationRows.find((row) => row.id === actionMenu.contact.id),
                      ),
                  },
                ]
              : []),
            ...(actionMenu.ids.length === 1 &&
            conversationDirectory?.onEditRemark &&
            contacts.some((row) => row.id === actionMenu.contact.id)
              ? [
                  {
                    label: '修改好友备注',
                    icon: <PenLine size={16} />,
                    action: () =>
                      conversationDirectory.onEditRemark(
                        conversationRows.find((row) => row.id === actionMenu.contact.id),
                      ),
                  },
                ]
              : []),
            ...(actionMenu.ids.every((id) => contacts.some((contact) => contact.id === id))
              ? [
                  {
                    label: '移动分组',
                    icon: <FolderInput size={16} />,
                    disabled:
                      order.preferences.grouping !== 'qq' ||
                      !friendDirectory?.available ||
                      friendDirectory.busy,
                    reason: friendDirectory?.error,
                    action: () => friendDirectory?.move(actionMenu.ids),
                  },
                ]
              : []),
            ...(requestExport
              ? [
                  {
                    label: actionMenu.ids.length > 1 ? '导出所选会话' : '导出',
                    icon: <Download size={16} />,
                    action: () => batch.runExport(actionMenu.ids),
                  },
                ]
              : []),
            ...(conversationDirectory?.onRoaming
              ? [
                  {
                    label: actionMenu.ids.length > 1 ? '拉取所选会话漫游消息' : '拉取漫游消息',
                    icon: <CloudDownload size={16} />,
                    action: () => batch.runRoaming(actionMenu.ids),
                  },
                ]
              : []),
          ]}
        />
      )}
      {categoryMenu && (
        <ConversationActionsMenu
          x={categoryMenu.x}
          y={categoryMenu.y}
          onClose={() => setCategoryMenu(null)}
          label="分组操作"
          actions={[
            {
              label: '重命名',
              icon: <PenLine size={16} />,
              disabled: !friendDirectory?.available || friendDirectory.busy,
              action: () => friendDirectory?.edit('rename', categoryMenu.id),
            },
            {
              label: '删除分组',
              icon: <Trash2 size={16} />,
              disabled: !categoryMenu.id || !friendDirectory?.available || friendDirectory.busy,
              action: () => friendDirectory?.edit('delete', categoryMenu.id),
            },
            {
              label: '移到最前',
              icon: <ChevronRight size={16} />,
              disabled: !friendDirectory?.available || friendDirectory.busy,
              action: () => friendDirectory?.sort(categoryMenu.id, 'first'),
            },
            {
              label: '移到最后',
              icon: <ChevronRight size={16} />,
              disabled: !friendDirectory?.available || friendDirectory.busy,
              action: () => friendDirectory?.sort(categoryMenu.id, 'last'),
            },
          ]}
        />
      )}
      {batch.confirmation}
    </div>
  );
});

const SUB_ICONS: Record<number, string> = {
  1028: 'music@2x.png',
  1030: 'weather_3x.png',
  2003: 'chuqulang2.png',
  2015: 'gototravel.png',
  2014: 'tkong.png',
  1051: 'relationship_3x.png',
  1071: 'jinli@2x.png',
  1201: 'luck@2x.png',
  1056: 'happytofly@3x.png',
  1058: 'fullofyuanqi@3x.png',
  1063: 'hardtosay@3x.png',
  2001: 'nandehutu.png',
  1401: 'emonew@2x.png',
  1062: 'toohard@3x.png',
  2013: 'woxiangkaile.png',
  1052: 'imfine_3x.png',
  1061: 'bequiet@3x.png',
  1059: 'youzaizai@3x.png',
  1011: 'signal_3x.png',
  1016: 'sleeping_3x.png',
  2012: 'ganzuoye.png',
  1018: 'study_3x.png',
  2023: 'banzhuan.png',
  1300: 'fish@2x.png',
  1060: 'boring@3x.png',
  1027: 'timi_3x.png',
  2025: 'yiqiyuanmeng.png',
  2026: 'qiuxingdazi.png',
  1032: 'stayup_3x.png',
  1021: 'tv_3x.png',
  2019: 'crush.png',
  2006: 'aiziji@2x.png',
};

const TYPE_ICONS: Record<number, () => JSX.Element> = {
  10: () => <Circle size={10} fill="#52c41a" stroke="#52c41a" />,
  60: () => <Smile size={12} stroke="#faad14" />,
  30: () => <Clock size={12} stroke="#8c8c8c" />,
  50: () => <Minus size={12} stroke="#faad14" />,
  70: () => <Ban size={12} stroke="#ff4d4f" />,
  40: () => <MinusCircle size={12} stroke="#8c8c8c" />,
};

function ContactOnlineStatusIcon({ status }: { status: OnlineStatusInfo | undefined }) {
  if (!status) return null;
  const filename = status.type === 10 && SUB_ICONS[status.subType];
  if (filename) {
    return (
      <img src={resourceUrl('onlinestatus', filename)} alt="" style={{ width: 14, height: 14 }} />
    );
  }
  const TypeIcon = TYPE_ICONS[status.type];
  return TypeIcon ? <TypeIcon /> : null;
}

function conversationTitle(conversation: Conversation) {
  if (conversation.type === 'merged') return conversation.title;
  return conversation.type === 'group'
    ? displayGroupName(conversation.group)
    : displayUserName(conversation.otherUser);
}

function conversationAvatarUrl(conversation: Conversation) {
  if (conversation.type === 'merged') return conversation.avatarUrl;
  return conversation.type === 'group'
    ? conversation.group.avatarUrl
    : conversation.otherUser.avatarUrl;
}

function conversationSeed(conversation: Conversation) {
  if (conversation.type === 'merged') return conversation.id;
  return conversation.type === 'group' ? conversation.id : conversation.otherUser.identityValue;
}

function conversationLastMessage(conversation: Conversation, user?: User) {
  // When the last message has no text body (e.g. element-only messages like
  // pure image / sticker / file with no preview text), keep the row's
  // preview line empty rather than printing a placeholder — the timestamp
  // and unread-count next to it already convey "there is activity".
  if (!conversation.lastMessage?.body) {
    return {
      nodes: [],
      text: '',
      mentionsMe: false,
    };
  }

  const mentionsMe =
    conversation.type === 'group' &&
    conversation.lastMessage.senderId !== user?.id &&
    messageMentionsUser(conversation.lastMessage.body, user);

  // 富节点（文本 + 表情）优先；没有就把纯文本包成单个文本节点，渲染路径统一。
  const body: PreviewNode[] = conversation.lastMessage.previewNodes?.length
    ? conversation.lastMessage.previewNodes
    : [{ t: 'text', text: conversation.lastMessage.body }];

  // 群聊前缀「昵称：」只用于普通成员消息；系统灰条（入群 / 退群 / 禁言 / 戳一戳
  // …）只显示内容本身，前面不加发送者昵称。
  const prefix =
    conversation.type === 'group' &&
    conversation.lastMessage.senderDisplayName &&
    !conversation.lastMessage.kind?.startsWith('grayTip')
      ? `${conversation.lastMessage.senderDisplayName}：`
      : '';

  return {
    nodes: prefix ? [{ t: 'text', text: prefix } as PreviewNode, ...body] : body,
    text: `${prefix}${conversation.lastMessage.body}`,
    mentionsMe,
  };
}

/** 预览节点 → React：文本原样输出，表情画成图（与聊天区同一个 FaceEmoji）。 */
function PreviewNodes({ nodes }: { nodes: PreviewNode[] }) {
  return nodes.map((node, index) =>
    node.t === 'face' ? (
      <FaceEmoji
        // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
        key={index}
        element={{ faceId: node.faceId, faceText: node.label }}
        size="1.15em"
        className={cn('row-preview-face')}
      />
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
      <span key={index}>{node.text}</span>
    ),
  );
}

function formatDraftPreview(value: string | undefined) {
  if (!value) {
    return '';
  }

  return value
    .replace(/\[\[chat:(?:emoji|face|mface|fav|gif):[^\]]+\]\]/g, '[表情]')
    .replace(/\[[^\]\n]{1,32}\]/g, '[表情]')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatBadgeCount(value: number) {
  return value > 99 ? '99+' : String(value);
}

function isPinned(conversation: Conversation, preferences: ConversationPreferences): boolean {
  return conversationPinned(conversation, preferences);
}

/** 会话列表的显示范围：真实 / 虚拟（克隆）/ 频道私聊，或全都显示。 */
type ConversationScope = 'all' | 'real' | 'virtual' | 'guild';

const SCOPE_OPTIONS: Array<{ id: ConversationScope; name: string; icon: typeof MessagesSquare }> = [
  { id: 'all', name: '全部会话', icon: MessagesSquare },
  { id: 'real', name: '仅真实会话', icon: UserRound },
  { id: 'virtual', name: '仅克隆会话', icon: Bot },
  { id: 'guild', name: '仅频道私聊', icon: Hash },
];
const SCOPE_LABELS: Record<ConversationScope, string> = {
  all: '全部会话',
  real: '仅真实会话',
  virtual: '仅克隆会话',
  guild: '仅频道私聊',
};

function listRowClass(active: boolean, semanticClass: 'conversation-row' | 'contact-row') {
  return cn(semanticClass, active && 'active');
}

function unreadClass(muted: boolean) {
  return cn('row-unread', muted && 'muted');
}
