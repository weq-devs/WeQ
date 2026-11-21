// @ts-nocheck
import { ProfileChatShortcutContext } from '../../lib/chatNavigation';
import { activateProfile } from '../../lib/profileClick';
import { NumericText } from '../../components/NumericText';
import { TimeLabel } from '../../components/TimeLabel';
import { ReminderCount, ReminderDot } from '../../components/ReminderBadge';
import { ConversationRowContent } from '../../components/sidebar/ConversationRowContent';
import { useUnreadMarkers } from '../../lib/unreadMarkers';
import { occupationText } from '@weqbot/protocol/profile-values';
import {
  Bell,
  BellOff,
  Bot,
  PenLine,
  Pin,
  Mail,
  Eye,
  EyeOff,
  List,
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
  Sparkles,
  BarChart3,
  CloudDownload,
  Download,
  FolderInput,
  CalendarDays,
  ArrowLeft,
  Newspaper,
  LogOut,
  UserMinus,
  UserRoundX,
} from 'lucide-react';
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
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
import { SegmentedControl } from '../../components/SegmentedControl';
import { useContactOnlineStatuses } from '../../hooks/useContactOnlineStatuses';
import { conversationListSearchText } from '../../lib/conversationListSearchText';
import { formatConversationTime } from '../../lib/conversationTime';
import { useConversationClickTarget } from '../../hooks/useConversationClickTarget';
import { useConversationHoverOrder } from '../../hooks/useConversationHoverOrder';
import { useMobileBack } from '../../hooks/useMobileNavigation';
import { useMobileWebLayout } from '../../hooks/useMobileWebViewport';
import { preferenceValue, useClientPreferences } from '../../lib/clientPreferences';
import { useViewState } from '../../state/view';
import {
  ConversationDirectoryContext,
  ContactDirectoryContext,
} from '../../lib/conversationDirectory';
import { VirtualConversationAvatar } from '../../components/VirtualConversationAvatar';
import {
  groupRelationship,
  personRelationship,
  RelationshipDirectoryContext,
} from '../../lib/contactRelationship';
import { OnlineStatus } from '../../components/OnlineStatus';
import { SourceGroup } from '../../components/qq-actions/FriendClue';
import { useQQAction } from '../../components/qq-actions/shared.shared';
import {
  useDeleteFriend,
  useGroupExitActions,
} from '../../components/qq-actions/relationshipActions.shared';
import {
  useContentMultiSelect,
  useRequestContentExport,
} from '../../state/contentSelection.shared';
import {
  conversationAnalysisTarget,
  conversationRoamingTarget,
} from '../../lib/conversationActions';
import { ConversationActionsMenu } from '../../components/ConversationActionsMenu';
import { ConversationMenuTarget } from '../../components/ConversationMenuTarget';
import {
  CONVERSATION_VIEWS,
  CONVERSATION_VIEW_LABELS,
  aggregateView,
  conversationSupportsAction,
  conversationViewActions,
  type ConversationView,
} from '../../lib/conversationViews';
import { DirectoryToolbar } from '../../components/DirectoryToolbar';
import { ConversationBatchToolbar } from '../../components/ConversationBatchToolbar';
import { useConversationBatchActions } from '../../components/useConversationBatchActions';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import { FriendConversationActionsMenu } from '../../components/FriendConversationActionsMenu';
import { useFriendDirectory } from '../../components/FriendDirectoryControls.shared';
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
import { FEATURE_ICONS } from '../../lib/featureIcons.shared';
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

const VIEW_ICONS = {
  regular: FEATURE_ICONS.messages,
  all: List,
  groupAssistant: Users,
  official: Newspaper,
  service: Mail,
  guild: FEATURE_ICONS.guildDirect,
  hidden: EyeOff,
  deleted: Trash2,
  clone: FEATURE_ICONS.clone,
  assistant: FEATURE_ICONS.assistant,
};
const VIEW_OPTIONS = CONVERSATION_VIEWS.map((id) => ({ id, Icon: VIEW_ICONS[id] }));

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
  active = true,
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
  active?: boolean;
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
  const markers = useUnreadMarkers();
  const directoryRef = useRef<HTMLDivElement>(null);
  const mobile = useMobileWebLayout();
  useMobileBack(
    mobile && active && Boolean(directory?.returnToRegular),
    () => directory?.onReturnToRegular?.(),
    5,
    () => directoryRef.current,
  );
  const requestExport = useRequestContentExport();
  const batch = useConversationBatchActions(conversations);
  const [actionMenu, setActionMenu] = useState<{
    conversation: Conversation;
    ids: string[];
    x: number;
    y: number;
  } | null>(null);
  const [localView, setLocalView] = useState<ConversationView>('regular');
  const view = directory?.view ?? localView;
  const createAssistantDirectly = view === 'assistant';
  const createLabel = createAssistantDirectly ? '新建 WeQ 助手会话' : '添加会话';
  const ViewIcon = VIEW_ICONS[view];
  const searchReturnView = directory?.searchReturnView;
  const backView = searchReturnView ?? (directory?.returnToRegular ? 'regular' : undefined);
  const backLabel = backView ? `返回${CONVERSATION_VIEW_LABELS[backView]}` : undefined;
  const onBack = searchReturnView ? directory?.onReturnToSearchView : directory?.onReturnToRegular;
  const setView = directory?.onViewChange ?? setLocalView;
  const [queries, setQueries] = useState<Partial<Record<ConversationView, string>>>({});
  const keyword = queries[view] ?? '';
  const setKeyword = useCallback(
    (value: string) => setQueries((current) => ({ ...current, [view]: value })),
    [view],
  );
  const scrollPositions = useRef(new Map<string, number>());
  const [scopeOpen, setScopeOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [lookupOpen, setLookupOpen] = useState<QQExactLookupKind | null>(null);
  const [selectingAll, setSelectingAll] = useState(false);
  const invertFrom = useRef<Set<string> | null>(null);
  const createMenuRef = useRef<HTMLDivElement>(null);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const {
    selectionMode,
    selectedIds,
    setSelectedIds,
    setSelectionMode,
    removeSelectedIds,
    anchorRef,
  } = useContentMultiSelect({ kind: 'conversations', container: 'main-list' });
  const viewportRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(600);
  const [rowHeight, setRowHeight] = useState(62);
  const density = useThemeStore((state) => state.density);
  const componentStyle = useThemeStore((state) => state.componentStyle);
  const menuRef = useRef<HTMLDivElement>(null);
  useClientPreferences((state) => state.tick);
  const keepPosition = preferenceValue('keepConversationPositionOnHover');
  const showPreview = preferenceValue('showConversationPreview');
  const account = useViewState((state) => state.openedUin);
  const listKey = `${account}:${view}:${keyword}`;
  useImperativeHandle(
    directory?.captureListPosition,
    () => () => {
      const top = scrollPositions.current.get(listKey) ?? 0;
      return () => {
        scrollPositions.current.set(listKey, top);
        setKeyword(keyword);
      };
    },
    [listKey, keyword, setKeyword],
  );
  const [pointerInside, setPointerInside] = useState(false);
  useEffect(() => {
    const clear = () => setPointerInside(false);
    window.addEventListener('blur', clear);
    return () => window.removeEventListener('blur', clear);
  }, []);
  useEffect(() => setActionMenu(null), [account, view, keyword]);
  useEffect(() => {
    setCreateOpen(false);
    setSelectedIds(new Set());
    setSelectionMode(false);
    setSelectingAll(false);
    anchorRef.current = null;
  }, [view, account, setSelectedIds, setSelectionMode, anchorRef]);
  // 克隆和助手列表不分页；用完整列表核对删除结果，搜索过滤不改变选区。
  const generatedRows = view === 'clone' || view === 'assistant' ? directory?.rows : undefined;
  useEffect(() => {
    if (!generatedRows || loading || !selectedIds.size) return;
    const availableIds = new Set(generatedRows.map((row) => row.id));
    const removed = [...selectedIds].filter((id) => !availableIds.has(id));
    if (removed.length === selectedIds.size) setSelectionMode(false);
    else if (removed.length) removeSelectedIds(removed);
  }, [generatedRows, loading, selectedIds, removeSelectedIds, setSelectionMode]);
  const sorted = useMemo(() => {
    const needle = keyword.trim().toLocaleLowerCase();
    const rows = directory?.rows ?? conversations;
    const visible = rows.filter(
      (row) => !needle || conversationListSearchText(row).includes(needle),
    );
    const ordered = sortConversationRows(visible, preferences);
    return { rows: ordered, ids: ordered.map((row) => row.id) };
  }, [conversations, preferences, directory?.rows, keyword]);
  const orderedRows = useConversationHoverOrder(
    sorted.rows,
    keepPosition && (pointerInside || Boolean(actionMenu)),
    listKey,
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
  const aggregateMenu = actionMenu?.conversation.type === 'merged';
  const singleMenuConversation =
    actionMenu?.ids.length === 1 && actionMenu.conversation.type !== 'merged'
      ? actionMenu.conversation
      : null;
  const selectConversation = (id: string, event: React.MouseEvent) => {
    if (!filtered.ids.includes(id)) return;
    const row = filtered.rows.find((item) => item.id === id);
    if (row?.type === 'merged') {
      setView(aggregateView(row.mergedKind), true);
      return;
    }
    if (row?.generated?.kind === 'assistant') {
      directory?.onAssistant?.(row.generated.sessionId);
      return;
    }
    const virtual = directory?.virtual.find((item) => item.id === id);
    if (virtual) directory.onVirtual(virtual);
    else onSelect(id, event);
  };
  const clickTargetProps = useConversationClickTarget({
    rows: filtered.rows,
    enabled: !selectionMode,
    resetKey: `${view}:${keyword}`,
    onSelect: selectConversation,
  });
  const filteredIds = useMemo(
    () => filtered.rows.filter((row) => row.type !== 'merged').map((row) => row.id),
    [filtered.rows],
  );
  const rowSelectedIds = new Set(selectedIds);
  const menuIds = (conversation: Conversation) =>
    conversation.type === 'merged'
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
    ids: filteredIds,
    selected: rowSelectedIds,
    onChange: (ids) => {
      invertFrom.current = null;
      if ((hasMore || loading) && filteredIds.length && filteredIds.every((id) => ids.has(id))) {
        setSelectingAll(true);
        onLoadMore?.();
        return;
      }
      setSelectingAll(false);
      setSelectedIds(new Set([...ids].filter((id) => filteredIds.includes(id))));
    },
    enabled: selectionMode,
    onStart: () => setSelectionMode(true),
    onExit: () => setSelectionMode(false),
  });

  const locateId = directory?.locate?.id;
  const locateRevision = directory?.locate?.revision;
  const focusRequest = multi.focusRequest;
  const scrollToFocus = focusRequest && focusRequest.revision > (locateRevision ?? 0);
  const handledLocate = useRef('');
  const [locateHighlight, setLocateHighlight] = useState<{
    id: string;
    revision: number | undefined;
  } | null>(null);
  const locateAvailable = Boolean(locateId) && !keyword && filtered.ids.includes(locateId);
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
    const request = `${locateId}:${locateRevision}`;
    if (!locateId || handledLocate.current === request) return;
    handledLocate.current = request;
    setKeyword('');
  }, [locateId, locateRevision, setKeyword]);
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

  const interruptUnreadCycle = (event: React.SyntheticEvent<HTMLElement>) => {
    // 排除从菜单、弹窗等 Portal 冒泡的交互；程序滚动不会产生此处监听的输入事件。
    if (event.currentTarget.contains(event.target as Node)) directory?.onListInteraction?.();
  };
  return (
    <div
      className="list-stack weq-conversation-directory"
      {...multi.rootProps}
      ref={(element) => {
        directoryRef.current = element;
        multi.rootProps.ref(element);
      }}
      onPointerDownCapture={(event) => {
        multi.rootProps.onPointerDownCapture();
        if (event.pointerType === 'mouse') interruptUnreadCycle(event);
      }}
      onClickCapture={interruptUnreadCycle}
      onContextMenuCapture={interruptUnreadCycle}
      onWheelCapture={interruptUnreadCycle}
      onTouchMoveCapture={interruptUnreadCycle}
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
        key={view}
        noun="会话"
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
              title={searching ? '退出搜索会话' : createLabel}
              aria-label={searching ? '退出搜索会话' : createLabel}
              aria-haspopup={searching || createAssistantDirectly ? undefined : 'menu'}
              aria-expanded={searching || createAssistantDirectly ? undefined : createOpen}
              disabled={
                !searching && (createAssistantDirectly ? !directory?.onCreateAssistant : !directory)
              }
              onClick={() => {
                if (searching) {
                  setCreateOpen(false);
                  closeSearch();
                  return;
                }
                setScopeOpen(false);
                if (createAssistantDirectly) directory?.onCreateAssistant?.();
                else setCreateOpen(!createOpen);
              }}
              onKeyDown={(event) => {
                if (searching || createAssistantDirectly || event.key !== 'ArrowDown') return;
                event.preventDefault();
                setScopeOpen(false);
                setCreateOpen(true);
              }}
            >
              <Plus size={16} className="weq-directory-add-icon" />
            </button>
            {createOpen && !searching && !createAssistantDirectly ? (
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
                {view !== 'clone' && (
                  <>
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
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setCreateOpen(false);
                        directory?.onCreateAssistant?.();
                      }}
                      disabled={!directory?.onCreateAssistant}
                    >
                      <Sparkles size={16} />
                      新建 WeQ 助手会话
                    </button>
                  </>
                )}
              </div>
            ) : null}
          </div>
        )}
      >
        <div className="weq-directory-scope" ref={menuRef}>
          <button
            type="button"
            title={backLabel ?? `会话视图：${CONVERSATION_VIEW_LABELS[view]}`}
            aria-label={backLabel ?? '会话视图'}
            aria-haspopup={backLabel ? undefined : 'menu'}
            aria-expanded={backLabel ? undefined : scopeOpen}
            onClick={() => {
              setCreateOpen(false);
              if (backLabel) {
                setScopeOpen(false);
                onBack?.();
                return;
              }
              setScopeOpen(!scopeOpen);
            }}
          >
            {backLabel ? <ArrowLeft size={16} /> : <ViewIcon size={16} />}
          </button>
          {scopeOpen && !backLabel ? (
            <div role="menu" className="weq-directory-scope-menu" aria-label="会话视图">
              {VIEW_OPTIONS.map(({ id: item, Icon: ItemIcon }) => (
                <button
                  key={item}
                  type="button"
                  role="menuitemradio"
                  aria-checked={view === item}
                  onClick={() => {
                    setView(item, false);
                    setScopeOpen(false);
                  }}
                >
                  <ItemIcon size={16} />
                  {CONVERSATION_VIEW_LABELS[item]}
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
          <button
            type="button"
            onClick={directory.onRetry ?? onLoadMore}
            className="weq-retry-button"
          >
            <RefreshCw size={14} aria-hidden />
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
          resetKey={listKey}
          restoreScrollTop={scrollPositions.current.get(listKey) ?? 0}
          onScrollTopChange={(top) => scrollPositions.current.set(listKey, top)}
          itemKey={(item) => item.id}
          scrollToKey={scrollToFocus ? focusRequest.id : !keyword ? locateId : null}
          scrollRevision={Math.max(focusRequest?.revision ?? 0, locateRevision ?? 0)}
          scrollAlign={scrollToFocus ? undefined : directory?.locate?.align}
          onNearEnd={hasMore && !loadingMore ? onLoadMore : undefined}
          className="weq-conversation-window"
          renderItem={(conversation) => {
            const active = conversation.id === activeConversationId;
            const updatedAt = conversation.updatedAt;
            const unreadCount = conversation.unreadCount ?? 0;
            const showUnreadCount =
              unreadCount > 0 &&
              (conversation.type !== 'merged' || markers.aggregates[conversation.mergedKind]);
            const draft = drafts[conversation.id] ?? conversation.draftPreview;
            const hasDraft = showPreview && !active && Boolean(draft?.trim());
            const lastMessage = conversation.lastMessage;
            const preview = showPreview && !hasDraft ? conversationPreviewNodes(conversation) : [];
            // 提醒高亮：来自 48902 的权威标记（特别关心 / @我 …）。
            const highlightKinds = new Set(
              (markers.important ? (conversation.highlights ?? []) : []).map((h) => h.kind),
            );
            // @我：优先用 48902 权威标记，回退到本地对消息正文的启发式解析。
            const showMentionAlert =
              markers.important &&
              unreadCount > 0 &&
              (highlightKinds.has('atMe') ||
                (conversation.type === 'group' &&
                  lastMessage?.body &&
                  lastMessage.senderId !== user?.id &&
                  messageMentionsUser(lastMessage.body, user)));
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
            const showPreviewLine =
              showPreview ||
              showSpecialCare ||
              showMentionAlert ||
              showAtAll ||
              showReplyMe ||
              showGroupKeyword ||
              showNewFile ||
              showGroupAnnouncement ||
              showRedPacket;
            // 命中的关键词（可能多个）；让「[群提醒词]」能区分是哪个词命中的。
            const groupKeywordWords =
              markers.important && unreadCount > 0
                ? [
                    ...new Set(
                      (conversation.highlights ?? [])
                        .filter((h) => h.kind === 'groupKeyword' && h.text)
                        .map((h) => h.text as string),
                    ),
                  ]
                : [];
            // 普通会话的免打扰由 DB 值（41220）打底，本地手动偏好覆盖。
            const muted = conversation.generated
              ? Boolean(conversation.preference?.muted)
              : Boolean(
                  {
                    ...conversation.preference,
                    ...preferences[conversation.id],
                  }.muted,
                );
            const reminderTone = muted ? 'muted' : 'notice';
            const pinned = isPinned(conversation, preferences);
            const virtualRow = directory?.virtual.find((item) => item.id === conversation.id);
            const canOpenContextMenu = conversation.type !== 'merged' || Boolean(directory?.onPin);

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
                {...(conversation.type === 'merged' ? {} : multi.itemProps(conversation.id))}
                onPointerEnter={() => {
                  if (!selectionMode) directory?.onConversationIntent?.(conversation);
                }}
                onFocus={() => {
                  if (!selectionMode) directory?.onConversationIntent?.(conversation);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (!canOpenContextMenu) return;
                  setActionMenu({
                    conversation,
                    ids: menuIds(conversation),
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
                onKeyDown={(event) => {
                  if (!canOpenContextMenu) return;
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
                      <FEATURE_ICONS.guildDirect size={20} strokeWidth={2} aria-hidden />
                    ) : conversation.mergedKind === 'clone' ? (
                      <Bot size={20} strokeWidth={2} />
                    ) : conversation.mergedKind === 'assistant' ? (
                      <Sparkles size={20} strokeWidth={2} />
                    ) : conversation.mergedKind === 'service' ||
                      conversation.mergedKind === 'groupAssistant' ? (
                      <Users size={20} strokeWidth={2} />
                    ) : (
                      <UserRound size={20} strokeWidth={2} />
                    )}
                  </span>
                ) : conversation.generated?.kind === 'assistant' ? (
                  <span className={cn('avatar', 'has-default', 'merged-avatar')}>
                    <Sparkles size={20} />
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
                <ConversationRowContent
                  title={
                    <>
                      <span className={cn('row-title-text')}>
                        {conversationTitle(conversation)}
                      </span>
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
                            <FEATURE_ICONS.cloneGroup size={11} aria-hidden />
                          ) : (
                            <FEATURE_ICONS.clone size={11} aria-hidden />
                          )}
                        </small>
                      ) : null}
                      {isBotConversation(conversation) ? (
                        <small className={cn('bot-badge')} aria-label="机器人" title="机器人">
                          <Bot size={12} strokeWidth={2.4} />
                        </small>
                      ) : null}
                    </>
                  }
                  preview={
                    !showPreviewLine ? null : hasDraft ? (
                      <span className={cn('row-draft')}>
                        <PenLine size={15} />
                        <span className={cn('row-draft-text')}>
                          {conversation.generated ? draft : formatDraftPreview(draft)}
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
                        {preview.length ? <PreviewNodes nodes={preview} /> : null}
                      </span>
                    )
                  }
                  time={
                    <>
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
                      <TimeLabel value={updatedAt} tabbable={false}>
                        {formatConversationTime(updatedAt)}
                      </TimeLabel>
                    </>
                  }
                  status={
                    showUnreadCount ? (
                      <ReminderCount
                        count={unreadCount}
                        tone={reminderTone}
                        className="row-unread"
                      />
                    ) : conversation.type !== 'merged' &&
                      directory?.interactionBadges?.has(
                        `${conversation.type === 'group' ? 'group' : 'c2c'}:${conversation.id}`,
                      ) ? (
                      <ReminderDot
                        className="row-unread"
                        tone={reminderTone}
                        role="img"
                        aria-label="有新互动"
                        title="有新互动"
                      />
                    ) : !unreadCount && muted ? (
                      <BellOff className="row-muted" size={15} />
                    ) : null
                  }
                />
              </button>
            );
          }}
        />
      </div>
      {hasMore ? <ConversationListLoadMore loading={loadingMore} onLoadMore={onLoadMore} /> : null}
      {selectionMode ? (
        <ConversationBatchToolbar
          conversations={directory?.rows ?? conversations}
          ids={[...selectedIds]}
          busy={selectingAll}
          view={view}
        />
      ) : null}
      {actionMenu ? (
        <FriendConversationActionsMenu
          friendUid={
            actionMenu.ids.length === 1 &&
            actionMenu.conversation.type === 'direct' &&
            conversationSupportsAction(actionMenu.conversation, 'read') &&
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
              generated={actionMenu.conversation.generated}
              count={actionMenu.ids.length}
              onOpenProfile={
                singleMenuConversation && directory?.onOpenProfile
                  ? (anchor: HTMLElement) => {
                      directory.onOpenProfile(singleMenuConversation, anchor);
                      setActionMenu(null);
                    }
                  : undefined
              }
              onOpenChat={
                singleMenuConversation && directory?.onOpenProfile
                  ? (event) => {
                      setActionMenu(null);
                      selectConversation(singleMenuConversation.id, event);
                    }
                  : undefined
              }
              containedCount={
                actionMenu.conversation.type === 'merged' &&
                actionMenu.conversation.mergedKind === 'groupAssistant'
                  ? (directory?.groupAssistantIds?.size ??
                    directory?.views?.groupAssistant.length ??
                    0)
                  : undefined
              }
            />
          }
          onClose={() => setActionMenu(null)}
          actions={(() => {
            return [
              ...(singleMenuConversation && directory?.onPreview
                ? [
                    {
                      label: '预览会话',
                      icon: <Eye size={16} aria-hidden />,
                      action: () => directory.onPreview(singleMenuConversation),
                    },
                  ]
                : []),
              ...(!aggregateMenu && conversationViewActions(view).includes('read')
                ? batch.readStateMenuActions(actionMenu.ids)
                : []),
              ...(directory?.onMuteGenerated &&
              actionMenu.conversation.generated &&
              actionMenu.ids.length === 1
                ? [
                    {
                      label: actionMenu.conversation.preference?.muted
                        ? '取消免打扰'
                        : '消息免打扰',
                      icon: actionMenu.conversation.preference?.muted ? (
                        <Bell size={16} />
                      ) : (
                        <BellOff size={16} />
                      ),
                      action: () =>
                        directory.onMuteGenerated?.(
                          actionMenu.conversation,
                          !actionMenu.conversation.preference?.muted,
                        ),
                    },
                  ]
                : []),
              ...(directory?.onPin &&
              (aggregateMenu ||
                (!actionMenu.conversation.directoryRead &&
                  conversationSupportsAction(actionMenu.conversation, 'read')) ||
                (actionMenu.conversation.generated &&
                  actionMenu.conversation.generated.kind !== 'assistant')) &&
              actionMenu.ids.length === 1
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
              ...(batch.exportAvailable && !aggregateMenu
                ? [
                    {
                      label: actionMenu.ids.length > 1 ? '导出所选会话' : '导出',
                      icon: <Download size={16} />,
                      action: () => batch.runExport(actionMenu.ids),
                    },
                  ]
                : []),
              ...(requestExport &&
              !aggregateMenu &&
              conversationViewActions(view).includes('roster') &&
              (actionMenu.ids.length > 1 ||
                conversationSupportsAction(actionMenu.conversation, 'roster'))
                ? [
                    {
                      label: '导出群成员名单',
                      icon: <Users size={16} />,
                      disabled: !batch.supportsAny(actionMenu.ids, 'roster'),
                      action: () => batch.runRoster(actionMenu.ids),
                    },
                  ]
                : []),
              ...(directory?.onRoaming &&
              !aggregateMenu &&
              conversationViewActions(view).includes('roaming') &&
              (actionMenu.ids.length > 1 ||
                conversationSupportsAction(actionMenu.conversation, 'roaming'))
                ? [
                    {
                      label: actionMenu.ids.length > 1 ? '拉取所选会话漫游消息' : '拉取漫游消息',
                      icon: <CloudDownload size={16} />,
                      disabled: !batch.supportsAny(actionMenu.ids, 'roaming'),
                      action: () => batch.runRoaming(actionMenu.ids),
                    },
                  ]
                : []),
              ...(directory?.onDelete &&
              !aggregateMenu &&
              conversationViewActions(view).includes('delete') &&
              (actionMenu.ids.length > 1 ||
                conversationSupportsAction(actionMenu.conversation, 'delete'))
                ? [
                    {
                      danger: 'solid',
                      label: '永久删除',
                      icon: <Trash2 size={16} />,
                      disabled:
                        directory.deleteBusy || !batch.supportsAny(actionMenu.ids, 'delete'),
                      reason: directory.deleteBusy ? '正在永久删除所选会话' : undefined,
                      action: () => batch.runDelete(actionMenu.ids),
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

const NO_FILTER_MATCHES: string[] = [];

function useFilteredDirectoryIds(
  tab: 'friends' | 'groups',
  active: boolean,
  ids: string[] | undefined,
) {
  const update = useContext(ContactDirectoryContext)?.onFilteredIds;
  useLayoutEffect(() => {
    if (active) update?.(tab, ids);
  }, [active, ids, tab, update]);
  useLayoutEffect(() => {
    if (active && update) return () => update(tab, undefined);
  }, [active, tab, update]);
}

export function GroupList({
  active = true,
  conversations,
  activeConversationId,
  onSelect,
  loading,
}: {
  active?: boolean;
  conversations: Conversation[];
  activeConversationId: string | null;
  onSelect: (conversationId: string, event?: React.MouseEvent) => void;
  loading?: boolean;
}) {
  const relationships = useContext(RelationshipDirectoryContext);
  const directory = useContext(ContactDirectoryContext);
  const conversationDirectory = useContext(ConversationDirectoryContext);
  const batch = useConversationBatchActions(conversations);
  const groupAction = useQQAction('group-directory', 'all', { passive: true });
  const groupExits = useGroupExitActions(groupAction);
  const [actionMenu, setActionMenu] = useState<{
    conversation: Conversation;
    ids: string[];
    x: number;
    y: number;
  } | null>(null);
  const [membership, setMembership] = useState<'all' | 'member' | 'nonmember'>('all');
  const hasFilter = membership !== 'all';
  const needle = directory?.query.trim().toLocaleLowerCase() ?? '';
  const searchable = useMemo(
    () =>
      conversations.filter(
        (item): item is Extract<Conversation, { type: 'group' }> =>
          item.type === 'group' &&
          (membership === 'all' || groupRelationship(item.group, relationships) === membership) &&
          (!needle ||
            `${conversationTitle(item)} ${conversationSeed(item)} ${item.group.name}`
              .toLocaleLowerCase()
              .includes(needle)),
      ),
    [conversations, membership, needle, relationships],
  );
  const groupSelection = useContentMultiSelect({ kind: 'contacts', container: 'groups' });
  const menuGroup =
    !groupSelection.selectionMode &&
    actionMenu?.ids.length === 1 &&
    actionMenu.conversation.type === 'group'
      ? actionMenu.conversation.group
      : undefined;
  const menuGroupId = Number(menuGroup?.identityValue);
  const menuRole =
    menuGroup && groupRelationship(menuGroup, relationships) === 'member'
      ? (relationships?.groups.get(menuGroup.identityValue)?.role ??
        (menuGroup.roleKnown ? menuGroup.role : null))
      : null;
  const groupExit =
    Number.isInteger(menuGroupId) && menuGroupId > 0 && menuGroupId <= 0xffffffff
      ? menuRole === 'owner'
        ? groupExits.disband
        : menuRole === 'member' || menuRole === 'admin'
          ? groupExits.leave
          : null
      : null;
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
            searchable,
            order.preferences.sort,
            order.preferences.descending,
            order.rows,
            order.rawGroupNames,
          ),
        },
      ];
    const groups = sortGroups(
      searchable.filter(
        (conversation) => groupRelationship(conversation.group, relationships) === 'member',
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
  const historicalCategory = useMemo(
    () => ({
      mode: 'historical',
      label: '历史群聊',
      items: sortGroups(
        searchable.filter(
          (conversation) => groupRelationship(conversation.group, relationships) === 'nonmember',
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
          (conversation) => groupRelationship(conversation.group, relationships) === 'unknown',
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
  const shownCategories = useMemo(
    () =>
      basis === 'none'
        ? computedCategories
        : [...computedCategories, historicalCategory, unknownCategory],
    [basis, computedCategories, historicalCategory, unknownCategory],
  );
  const categories = useFrozenDirectory(
    shownCategories,
    groupSelection.selectionMode,
    `${order.scopeKey}:${JSON.stringify(order.preferences)}:${needle}:${membership}`,
  );
  const selectionIds = useMemo(
    () => [...new Set(categories.flatMap((category) => category.items.map((row) => row.id)))],
    [categories],
  );
  useFilteredDirectoryIds(
    'groups',
    active,
    hasFilter ? (loading ? NO_FILTER_MATCHES : selectionIds) : undefined,
  );
  const multi = useMultiSelection({
    ids: selectionIds,
    selected: groupSelection.selectedIds,
    onChange: groupSelection.setSelectedIds,
    anchorRef: groupSelection.anchorRef,
    enabled: groupSelection.selectionMode,
    onStart: () => groupSelection.setSelectionMode(true),
    onExit: () => groupSelection.setSelectionMode(false),
  });

  if (loading) return <ListSkeleton rows={9} />;
  return (
    <div className="weq-contact-directory" {...multi.rootProps}>
      <ContactDirectoryOrder
        order={order}
        active={active}
        filtersApplied={hasFilter}
        filtersDisabled={groupSelection.selectionMode}
        filters={
          <SegmentedControl
            label="群聊关系"
            value={membership}
            onChange={setMembership}
            options={[
              { value: 'all', label: '全部' },
              { value: 'member', label: '我在群内' },
              { value: 'nonmember', label: '我不在群内' },
            ]}
          />
        }
      />
      <div className={cn('list-stack', 'contact-cat-list', 'weq-contact-directory-scroll')}>
        {!selectionIds.length && (
          <EmptyState
            title={hasFilter ? '没有符合条件的群聊' : '暂无群聊'}
            body={hasFilter ? '可调整筛选条件。' : ''}
            icon={<Users />}
          />
        )}
        {categories.map((category) => (
          <GroupNotificationSection
            key={category.mode}
            category={category}
            filtered={hasFilter}
            activeConversationId={activeConversationId}
            onSelect={onSelect}
            selection={groupSelection}
            multi={multi}
            onMenu={setActionMenu}
            order={order}
          />
        ))}
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
            ...batch.readStateMenuActions(actionMenu.ids),
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
            ...(groupExit && menuGroup
              ? [
                  {
                    label: groupExit.label,
                    icon: menuRole === 'owner' ? <UserRoundX size={16} /> : <LogOut size={16} />,
                    danger: 'outline',
                    separatorBefore: true,
                    disabled: groupExit.disabled,
                    action: () => void groupExit.run(menuGroupId, displayGroupName(menuGroup)),
                  },
                ]
              : []),
          ]}
        />
      ) : null}
      {batch.confirmation}
    </div>
  );
}

function GroupNotificationSection({
  category,
  filtered,
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
  const expansion = filtered ? 'filtered' : 'all';
  const [openByMode, setOpenByMode] = useState({ all: containsActive, filtered: true });
  const open = openByMode[expansion];
  useEffect(() => {
    if (containsActive) setOpenByMode({ all: true, filtered: true });
  }, [containsActive]);
  const expanded =
    category.mode === 'none' || open || Boolean(directory?.query) || selection.selectionMode;
  const chatShortcut = useContext(ProfileChatShortcutContext);
  const visibleCount = useProgressiveRowCount(expanded ? category.items.length : 0);
  if (category.items.length === 0) return null;
  return (
    <div className="contact-cat">
      <button
        type="button"
        className="contact-cat-header"
        hidden={category.mode === 'none'}
        aria-expanded={expanded}
        onClick={() => setOpenByMode((current) => ({ ...current, [expansion]: !open }))}
      >
        <ChevronRight className={cn('contact-cat-caret', open && 'is-open')} size={15} />
        <span className="contact-cat-name">{category.label}</span>
        <span className="contact-cat-count">
          {<span className="weq-number weq-number-inherit">{category.items.length}</span>}
        </span>
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
                onClick={(event) => {
                  if (selection.selectionMode) return;
                  activateProfile(
                    event,
                    () => onSelect(conversation.id),
                    chatShortcut?.({ kind: 'group', conversation }),
                    conversation.id,
                  );
                }}
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
                    {detail ? (
                      detail.text
                    ) : conversation.group.memberCount > 0 ? (
                      <NumericText>{`${conversation.group.memberCount} 位成员`}</NumericText>
                    ) : (
                      '人数未读取'
                    )}
                  </span>
                </span>
                {conversationDirectory?.showContactUnreadCount &&
                (conversation.unreadCount ?? 0) > 0 ? (
                  <ReminderCount
                    count={conversation.unreadCount}
                    className="row-unread"
                    tone={
                      (conversationDirectory?.preferences?.[conversation.id]?.muted ??
                      conversation.preference?.muted)
                        ? 'muted'
                        : 'notice'
                    }
                  />
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
  select: (contact: Contact, event: MouseEvent<HTMLButtonElement>) => void;
  dragStart: (contact: Contact, event: DragEvent<HTMLButtonElement>) => void;
  dragEnd: () => void;
  menu: (contact: Contact, event: MouseEvent<HTMLButtonElement>) => void;
  keyDown: (contact: Contact, event: KeyboardEvent<HTMLButtonElement>) => void;
};

const ContactDirectoryRow = memo(function ContactDirectoryRow({
  contact,
  onlineStatus = contact.onlineStatusObj,
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
  onlineStatus?: Contact['onlineStatusObj'];
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
  const own =
    personRelationship(contact, useContext(RelationshipDirectoryContext)) === 'self' &&
    !contact.clone;
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
        onClick={(event) => events.select(contact, event)}
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
                {!own && onlineStatus && onlineStatus.typeName !== '未知' ? (
                  <span className={cn('contact-card-status')}>
                    <ContactOnlineStatusIcon status={onlineStatus} />
                    <span>[{onlineStatus.displayStatus}]</span>
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
          <ReminderCount
            count={unreadCount}
            tone={muted ? 'muted' : 'notice'}
            className="row-unread"
          />
        ) : null}
      </button>
      {own && !detail && onlineStatus && onlineStatus.typeName !== '未知' ? (
        <div className="weq-contact-self-status-row">
          <OnlineStatus
            uid={contact.uid || contact.id}
            selfUin={contact.identityValue}
            showBaseStatus
            fallbackText={onlineStatus.displayStatus}
          />
        </div>
      ) : null}
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

type ContactRelationshipFilter = 'all' | 'friend' | 'nonfriend';
type ContactPresenceFilter = 'all' | 'online' | 'offline';

const onlineContactStatuses = new Set(['在线', 'Q我吧', '离开', '忙碌', '勿扰']);
const offlineContactStatuses = new Set(['离线', '隐身']);

const ContactListContent = memo(function ContactListContent({
  active = true,
  contacts,
  categoryDefinitions = EMPTY_CONTACT_OPTIONS,
  specialSections = EMPTY_CONTACT_OPTIONS,
  trailingSections = EMPTY_CONTACT_OPTIONS,
  activeContactId,
  onSelect,
  loading,
}: {
  active?: boolean;
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
  const [relationshipFilter, setRelationshipFilter] = useState<ContactRelationshipFilter>('all');
  const [presenceFilter, setPresenceFilter] = useState<ContactPresenceFilter>('all');
  const hasPresenceFilter = presenceFilter !== 'all';
  const hasFilters = relationshipFilter !== 'all' || hasPresenceFilter;
  const contactIds = useMemo(() => new Set(contacts.map((contact) => contact.id)), [contacts]);
  const relationships = useContext(RelationshipDirectoryContext);
  const conversationDirectory = useContext(ConversationDirectoryContext);
  const friendDirectory = useFriendDirectory();
  const deleteFriend = useDeleteFriend('contact-directory', { passive: true });
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
  const menuContact = actionMenu?.contact;
  const menuUid = menuContact?.uid || menuContact?.id;
  const canRemoveFriend =
    !selection.selectionMode &&
    actionMenu?.ids.length === 1 &&
    Boolean(menuUid?.startsWith('u_')) &&
    !menuContact?.clone &&
    personRelationship(menuContact, relationships) === 'friend';
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
  const matchesSearchAndRelationship = useCallback(
    (contact: Contact) =>
      (relationshipFilter === 'all' ||
        (!contact.clone &&
          contact.identityLabel !== '设备' &&
          personRelationship(contact, relationships) === relationshipFilter)) &&
      (!needle ||
        `${displayUserName(contact)} ${contact.nick ?? ''} ${contact.identityValue} ${occupationText(contact.extInfo?.occupation) ?? ''}`
          .toLocaleLowerCase()
          .includes(needle)),
    [needle, relationshipFilter, relationships],
  );
  // 同一联系人可出现在多个分组。按 UID 去重，避免分组和在线状态回填触发重复读取。
  const presenceTargetKey = useMemo(
    () =>
      JSON.stringify(
        hasPresenceFilter
          ? [
              ...new Set(
                allContacts
                  .filter(
                    (contact) =>
                      !contact.onlineStatusObj &&
                      !contact.clone &&
                      contact.identityLabel !== '设备' &&
                      matchesSearchAndRelationship(contact),
                  )
                  .map((contact) => contact.uid || contact.id),
              ),
            ]
          : [],
      ),
    [allContacts, hasPresenceFilter, matchesSearchAndRelationship],
  );
  const presenceTargets = useMemo(
    () => (JSON.parse(presenceTargetKey) as string[]).map((uid) => ({ uid })),
    [presenceTargetKey],
  );
  const { statuses: additionalStatuses, loading: presenceLoading } = useContactOnlineStatuses(
    presenceTargets,
    active && !loading && hasPresenceFilter && !selection.selectionMode,
    Infinity,
  );
  const matches = useCallback(
    (contact: Contact) => {
      if (!matchesSearchAndRelationship(contact)) return false;
      if (!hasPresenceFilter) return true;
      if (contact.clone || contact.identityLabel === '设备') return false;
      const status = contact.onlineStatusObj ?? additionalStatuses[contact.uid || contact.id];
      const types = presenceFilter === 'online' ? onlineContactStatuses : offlineContactStatuses;
      return Boolean(status && types.has(status.typeName));
    },
    [matchesSearchAndRelationship, hasPresenceFilter, presenceFilter, additionalStatuses],
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
  const filteredCategories = useMemo(
    () =>
      hasFilters
        ? computedCategories.filter((category) => category.items.length)
        : computedCategories,
    [computedCategories, hasFilters],
  );
  const categories = useFrozenDirectory(
    filteredCategories,
    selection.selectionMode,
    `${order.scopeKey}:${JSON.stringify(order.preferences)}:${needle}:${relationshipFilter}:${presenceFilter}`,
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
  const filteredIds = useMemo(
    () => (hasFilters ? [...new Set(loading ? [] : selectionRows.values())] : undefined),
    [hasFilters, loading, selectionRows],
  );
  useFilteredDirectoryIds('friends', active, filteredIds);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
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
  const chatShortcut = useContext(ProfileChatShortcutContext);
  const rowEvents = useEventContextValue<ContactRowEvents>({
    selection: multi.itemProps,
    select: (contact, event) => {
      if (selection.selectionMode) return;
      activateProfile(
        event,
        () => onSelect(contact),
        chatShortcut?.({ kind: 'direct', user: contact }),
        contact.id,
      );
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

  return (
    <div className="weq-contact-directory" {...multi.rootProps}>
      <ContactDirectoryOrder
        order={order}
        active={active}
        filtersApplied={hasFilters}
        filtersDisabled={selection.selectionMode}
        filters={
          <>
            <div className="weq-directory-filter-row">
              <span>好友关系</span>
              <SegmentedControl
                label="好友关系"
                value={relationshipFilter}
                onChange={setRelationshipFilter}
                options={[
                  { value: 'all', label: '全部' },
                  { value: 'friend', label: '好友' },
                  { value: 'nonfriend', label: '非好友' },
                ]}
              />
            </div>
            <div className="weq-directory-filter-row">
              <span>在线状态</span>
              <SegmentedControl
                label="在线状态"
                value={presenceFilter}
                onChange={setPresenceFilter}
                options={[
                  { value: 'all', label: '全部' },
                  { value: 'online', label: '在线' },
                  { value: 'offline', label: '离线' },
                ]}
              />
            </div>
          </>
        }
      />
      <div className={cn('list-stack', 'contact-cat-list', 'weq-contact-directory-scroll')}>
        {presenceLoading && (
          <small className="contact-cat-description" role="status">
            正在读取在线状态…
          </small>
        )}
        {!categories.length && !presenceLoading && !friendDirectory?.error && (
          <EmptyState
            title={hasFilters ? '没有符合条件的联系人' : '暂无联系人'}
            body={hasFilters ? '可调整筛选条件。' : '通过 ID 搜索或邀请链接添加联系人。'}
            icon={<UserRound />}
          />
        )}
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
          const expansionKey = JSON.stringify([relationshipFilter, presenceFilter, category.id]);
          const open =
            order.preferences.grouping === 'none' ||
            Boolean(needle) ||
            (expanded[expansionKey] ?? hasFilters);
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
                const id = category.id;
                if (
                  typeof id !== 'number' ||
                  !source ||
                  !friendDirectory?.available ||
                  friendDirectory.busy ||
                  source.category === id
                ) {
                  setDragTarget(null);
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                let position: 'inside' | 'before' | 'after' = 'inside';
                if (source.category !== undefined) {
                  const rect = event.currentTarget.getBoundingClientRect();
                  position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                }
                setDragTarget((current) =>
                  current?.id === id && current.position === position ? current : { id, position },
                );
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
                    [expansionKey]: !open,
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
                  {hasFilters
                    ? category.items.length
                    : category.count === null
                      ? '-'
                      : (category.count ?? category.items.length)}
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
                        onlineStatus={
                          contact.onlineStatusObj ?? additionalStatuses[contact.uid || contact.id]
                        }
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
          removeFriend={
            canRemoveFriend
              ? {
                  label: '删除好友',
                  icon: <UserMinus size={16} />,
                  danger: 'outline',
                  separatorBefore: true,
                  disabled: deleteFriend.disabled,
                  action: () => void deleteFriend.run(menuUid, displayUserName(menuContact)),
                }
              : undefined
          }
          friendUid={
            actionMenu.ids.length === 1 && contacts.some((row) => row.id === actionMenu.contact.id)
              ? actionMenu.contact.id
              : undefined
          }
          actions={[
            ...batch.readStateMenuActions(actionMenu.ids),
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
              danger: 'outline',
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

function conversationPreviewNodes(conversation: Conversation): PreviewNode[] {
  // When the last message has no text body (e.g. element-only messages like
  // pure image / sticker / file with no preview text), keep the row's
  // preview line empty rather than printing a placeholder — the timestamp
  // and unread-count next to it already convey "there is activity".
  if (!conversation.lastMessage?.body) return [];

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

  return prefix ? [{ t: 'text', text: prefix }, ...body] : body;
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

function isPinned(conversation: Conversation, preferences: ConversationPreferences): boolean {
  return conversationPinned(conversation, preferences);
}

function listRowClass(active: boolean, semanticClass: 'conversation-row' | 'contact-row') {
  return cn(semanticClass, active && 'active');
}
