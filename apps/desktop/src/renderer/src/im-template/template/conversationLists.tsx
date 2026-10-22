// @ts-nocheck
import {
  BellOff,
  Bot,
  Hash,
  PenLine,
  Pin,
  MailOpen,
  Mail,
  ListChecks,
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
} from 'lucide-react';
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { conversationPinned } from '@weq/service/conversation-order';
import { sortConversationRows } from '../../lib/conversationListOrder';
import {
  ConversationDirectoryContext,
  ContactDirectoryContext,
  virtualConversationRow,
} from '../../lib/conversationDirectory';
import { VirtualConversationAvatar } from '../../components/VirtualConversationAvatar';
import { useContentMultiSelect, useRequestContentExport } from '../../state/contentSelection';
import {
  conversationAnalysisTarget,
  conversationRoamingTarget,
} from '../../lib/conversationActions';
import { ConversationActionsMenu } from '../../components/ConversationActionsMenu';
import { sidebarConversationsWithoutAssistant } from '../../lib/groupAssistant';
import { DirectoryToolbar } from '../../components/DirectoryToolbar';
import { ConversationSelectionToolbar } from '../../components/ConversationSelectionToolbar';
import { useConversationBatchActions } from '../../components/useConversationBatchActions';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import { FriendConversationActionsMenu } from '../../components/FriendConversationActionsMenu';
import { useFriendDirectory } from '../../components/FriendDirectoryControls';
import { QQExactLookup, type QQExactLookupKind } from '../../components/QQExactLookup';
import { allSelectionIdsSelected, toggleAllSelectionIds } from '../../lib/multiSelection';
import { WindowedList } from '../../components/WindowedList';
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
  const [scope, setScope] = useState<ConversationScope>('all');
  const [scopeOpen, setScopeOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [lookupOpen, setLookupOpen] = useState<QQExactLookupKind | null>(null);
  const [selectingAll, setSelectingAll] = useState(false);
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
  const menuRef = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => {
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
    const guildRows = real.filter(isGuild);
    const virtualRows = (directory?.virtual ?? []).map(virtualConversationRow);
    const rows = [
      ...(scope === 'all' || scope === 'real' ? realRows : []),
      ...(scope === 'all' || scope === 'guild' ? guildRows : []),
      ...(scope === 'all' || scope === 'virtual' ? virtualRows : []),
    ].filter(
      (row) =>
        !needle ||
        `${conversationTitle(row)} ${conversationSeed(row)} ${row.type === 'group' ? row.group.name : ''}`
          .toLocaleLowerCase()
          .includes(needle),
    );
    // 完整目录可用于查找操作目标，但不能绕过主列表的群助手归属。
    const visible = directory?.groupAssistantIds
      ? sidebarConversationsWithoutAssistant(rows, directory.groupAssistantIds)
      : rows;
    return sortConversationRows(visible, preferences);
  }, [
    conversations,
    preferences,
    directory?.virtual,
    directory?.real,
    directory?.groupAssistantIds,
    keyword,
    scope,
  ]);
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
  const filteredIds = useMemo(
    () => [...expandIds(filtered.map((item) => item.id))],
    [expandIds, filtered],
  );
  const assistantSelected =
    assistantIds.length > 0 && assistantIds.every((id) => selectedIds.has(id));
  const rowSelectedIds = new Set(selectedIds);
  if (assistantSelected) rowSelectedIds.add('merged:group-assistant');
  const allSelected = allSelectionIdsSelected(filteredIds, selectedIds);
  const toggleAll = () => {
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
      setSelectingAll(false);
      return;
    }
    if (!hasMore && !loadingMore && !loading) {
      setSelectedIds((current) => new Set([...current, ...filteredIds]));
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
    ids: filtered.map((item) => item.id),
    selected: rowSelectedIds,
    onChange: (ids) => {
      if ((hasMore || loading) && filtered.every((row) => ids.has(row.id))) {
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
  const exportReason = selectingAll
    ? '正在补齐全选'
    : !selectedIds.size
      ? '请先选择会话'
      : !requestExport
        ? '当前无法导出会话'
        : undefined;
  const roamingReason = selectingAll
    ? '正在补齐全选'
    : !selectedIds.size
      ? '请先选择会话'
      : !directory?.onRoaming
        ? '当前无法拉取漫游消息'
        : undefined;
  const readStateReason = selectingAll
    ? '正在补齐全选'
    : directory?.readStateBusy
      ? '正在更新标记'
      : !selectedIds.size
        ? '请先选择会话'
        : selectedIds.size > 4096
          ? '一次最多标记 4096 个会话'
          : undefined;

  const locateId = directory?.locate?.id;
  const locateRevision = directory?.locate?.revision;
  useEffect(() => {
    if (!locateId) return;
    setKeyword('');
    setScope('all');
  }, [locateId, locateRevision]);
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
  }, []);
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
    <div className="list-stack weq-conversation-directory" {...multi.rootProps}>
      <DirectoryToolbar
        noun="会话"
        query={keyword}
        onQuery={setKeyword}
        selecting={selectionMode}
        separateSelectionBar
        onSelecting={setSelectionMode}
        count={selectedIds.size}
        allSelected={allSelected}
        onSelectAll={toggleAll}
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
        <div className="weq-directory-scope" ref={createMenuRef}>
          <button
            ref={createTriggerRef}
            type="button"
            title="添加会话"
            aria-label="添加会话"
            aria-haspopup="menu"
            aria-expanded={createOpen}
            disabled={!directory}
            onClick={() => {
              setScopeOpen(false);
              setCreateOpen(!createOpen);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown') return;
              event.preventDefault();
              setScopeOpen(false);
              setCreateOpen(true);
            }}
          >
            <Plus size={16} />
          </button>
          {createOpen ? (
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
      </DirectoryToolbar>
      {lookupOpen && (
        <QQExactLookup key={lookupOpen} kind={lookupOpen} onClose={() => setLookupOpen(null)} />
      )}
      {loading && !filtered.length ? <ListSkeleton rows={9} /> : null}
      {directory?.loadingError ? (
        <div role="alert">
          会话读取失败：{directory.loadingError}
          <button type="button" onClick={onLoadMore}>
            重试
          </button>
        </div>
      ) : null}
      {!loading && !filtered.length ? (
        <EmptyState title="暂无会话" body="" icon={<MessageSquare />} />
      ) : null}
      <div className="weq-conversation-viewport" ref={viewportRef}>
        <WindowedList
          items={filtered}
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
                  listRowClass(!selectionMode && active, 'conversation-row'),
                  pinned && 'pinned',
                  selectionMode && rowSelectedIds.has(conversation.id) && 'is-multiselected',
                )}
                aria-pressed={selectionMode ? rowSelectedIds.has(conversation.id) : undefined}
                {...multi.itemProps(conversation.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setActionMenu({
                    conversation,
                    ids:
                      selectionMode && rowSelectedIds.has(conversation.id)
                        ? [...selectedIds]
                        : [...expandIds([conversation.id])],
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
                    ids:
                      selectionMode && rowSelectedIds.has(conversation.id)
                        ? [...selectedIds]
                        : [...expandIds([conversation.id])],
                    x: rect.left + 20,
                    y: rect.top + 20,
                  });
                }}
                onClick={(e) => {
                  const virtual = directory?.virtual.find((item) => item.id === conversation.id);
                  if (virtual) directory.onVirtual(virtual);
                  else onSelect(conversation.id, e);
                }}
              >
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
        <ConversationSelectionToolbar
          count={selectedIds.size}
          selectingAll={selectingAll}
          assistantCount={
            [...selectedIds].filter((id) => directory?.groupAssistantIds?.has(id)).length
          }
          allSelected={allSelected}
          exportReason={exportReason}
          roamingReason={roamingReason}
          onSelectAll={toggleAll}
          onExport={() => {
            if (!exportReason) batch.runExport([...selectedIds]);
          }}
          onRoaming={() => {
            if (!roamingReason) batch.runRoaming([...selectedIds]);
          }}
          onExit={() => setSelectionMode(false)}
          readStateReason={readStateReason}
          onReadState={
            directory?.onReadState
              ? (unread) => {
                  if (!readStateReason) batch.runReadState([...selectedIds], unread);
                }
              : undefined
          }
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
          onClose={() => setActionMenu(null)}
          actions={(() => {
            const markUnread = !batch.hasUnread(actionMenu.ids);
            return [
              ...(directory?.onReadState
                ? [
                    {
                      label: markUnread ? '标为未读' : '标为已读',
                      icon: markUnread ? <Mail size={16} /> : <MailOpen size={16} />,
                      disabled: directory.readStateBusy || actionMenu.ids.length > 4096,
                      action: () => batch.runReadState(actionMenu.ids, markUnread),
                    },
                  ]
                : []),
              {
                label: '多选',
                icon: <ListChecks size={16} />,
                action: () => {
                  setSelectionMode(true);
                  setSelectedIds(new Set(actionMenu.ids));
                },
              },
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
              ...(requestExport
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
              ...(directory?.onRoaming
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
  const directory = useContext(ContactDirectoryContext);
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
  const [basis, setBasis] = useState(() => {
    try {
      const saved = localStorage.getItem('weq.groups.grouping');
      return ['notify', 'identity', 'size'].includes(saved ?? '') ? saved : 'notify';
    } catch {
      return 'notify';
    }
  });
  const categories = useMemo(() => {
    const groups = searchable.filter(
      (conversation) => conversation.type === 'group' && conversation.group.listed === true,
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
    if (basis === 'size') {
      const limits = [10, 40, 70, 100, 200, 500, 1000, Infinity];
      const labels = [
        '10 人以内',
        '11–40 人',
        '41–70 人',
        '71–100 人',
        '101–200 人',
        '201–500 人',
        '501–1000 人',
        '1000 人以上',
      ];
      return [
        ...limits.map((max, index) => ({
          mode: `size:${index}`,
          label: labels[index],
          items: groups.filter(
            (group) =>
              group.group.memberCount > (limits[index - 1] ?? 0) && group.group.memberCount <= max,
          ),
        })),
        ...(groups.some((group) => !(group.group.memberCount > 0))
          ? [
              {
                mode: 'size-unknown',
                label: '人数未读取',
                items: groups.filter((group) => !(group.group.memberCount > 0)),
              },
            ]
          : []),
      ];
    }
    return GROUP_NOTIFICATION_SECTIONS.map((section) => ({
      ...section,
      items: groups.filter(
        (conversation) => groupNotificationMode(conversation.notifyLevel) === section.mode,
      ),
    }));
  }, [searchable, basis]);
  const historicalCategory = useMemo(
    () => ({
      mode: 'historical',
      label: '已解散或已退出的群聊',
      historical: true,
      items: searchable.filter(
        (conversation) =>
          conversation.type === 'group' &&
          conversation.group.membershipKnown &&
          conversation.group.listed === false,
      ),
    }),
    [searchable],
  );
  const groupSelection = useContentMultiSelect({ kind: 'contacts', container: 'groups' });
  const multi = useMultiSelection({
    ids: searchable.filter((item) => item.type === 'group').map((item) => item.id),
    selected: groupSelection.selectedIds,
    onChange: groupSelection.setSelectedIds,
    anchorRef: groupSelection.anchorRef,
    enabled: groupSelection.selectionMode,
    onStart: () => groupSelection.setSelectionMode(true),
    onExit: () => groupSelection.setSelectionMode(false),
  });

  if (loading) return <ListSkeleton rows={9} />;
  if (!categories.some((category) => category.items.length) && !historicalCategory.items.length)
    return <EmptyState title="暂无群聊" body="" icon={<Users />} />;
  return (
    <div className={cn('list-stack', 'contact-cat-list')} {...multi.rootProps}>
      <label className="weq-group-list-basis">
        分组依据
        <select
          value={basis ?? 'notify'}
          onChange={(event) => {
            setBasis(event.target.value);
            try {
              localStorage.setItem('weq.groups.grouping', event.target.value);
            } catch {
              /* UI choice is optional. */
            }
          }}
        >
          <option value="notify">按消息提醒方式</option>
          <option value="identity">按我的身份</option>
          <option value="size">按群人数</option>
        </select>
      </label>
      {categories.map((category) => (
        <GroupNotificationSection
          key={category.mode}
          category={category}
          activeConversationId={activeConversationId}
          onSelect={onSelect}
          selection={groupSelection}
          multi={multi}
        />
      ))}
      <GroupNotificationSection
        category={historicalCategory}
        activeConversationId={activeConversationId}
        onSelect={onSelect}
        selection={groupSelection}
        multi={multi}
      />
    </div>
  );
}

function GroupNotificationSection({ category, activeConversationId, onSelect, selection, multi }) {
  const directory = useContext(ContactDirectoryContext);
  const containsActive = category.items.some(
    (conversation) => conversation.id === activeConversationId,
  );
  const [open, setOpen] = useState(containsActive);
  useEffect(() => {
    if (containsActive) setOpen(true);
  }, [containsActive]);
  const expanded = open || Boolean(directory?.query) || selection.selectionMode;
  const visibleCount = useProgressiveRowCount(expanded ? category.items.length : 0);
  if (category.items.length === 0) return null;
  return (
    <div className="contact-cat">
      <button
        type="button"
        className="contact-cat-header"
        aria-expanded={expanded}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRight className={cn('contact-cat-caret', open && 'is-open')} size={15} />
        <span className="contact-cat-name">{category.label}</span>
        <span className="contact-cat-count">{category.items.length}</span>
      </button>
      {expanded
        ? category.items.slice(0, visibleCount).map((conversation) => (
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
              onClick={(event) => onSelect(conversation.id, event)}
            >
              <Avatar
                name={displayGroupName(conversation.group)}
                avatarUrl={conversation.group.avatarUrl}
                seed={conversation.id}
              />
              <span className="row-main">
                <strong>
                  <span className="row-title-text">{displayGroupName(conversation.group)}</span>
                </strong>
                <span>
                  {category.historical
                    ? '已不在当前群列表'
                    : conversation.group.memberCount > 0
                      ? `${conversation.group.memberCount} 位成员`
                      : '人数未读取'}
                </span>
              </span>
            </button>
          ))
        : null}
    </div>
  );
}

const EMPTY_CONTACT_OPTIONS = [] as const;

export function ContactList({
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
  const conversationRows = useMemo(
    () =>
      contacts.map(
        (contact): Conversation =>
          conversationDirectory?.real?.find(
            (row) => row.type === 'direct' && row.otherUser.id === contact.id,
          ) ?? {
            id: contact.id,
            type: 'direct',
            otherUser: contact,
            group: null,
            members: [],
            updatedAt: '',
            lastMessage: null,
          },
      ),
    [contacts, conversationDirectory?.real],
  );
  const batch = useConversationBatchActions(conversationRows);
  const selection = useContentMultiSelect({ kind: 'contacts', container: 'friends' });
  const needle = directory?.query.trim().toLocaleLowerCase() ?? '';
  const matches = useCallback(
    (contact: Contact) =>
      !needle ||
      `${displayUserName(contact)} ${contact.nick ?? ''} ${contact.identityValue}`
        .toLocaleLowerCase()
        .includes(needle),
    [needle],
  );
  const filtered = useMemo(() => contacts.filter(matches), [contacts, matches]);

  // 特殊分组固定在两端；普通分组按云端排序，组内保持原顺序。
  const categories = useMemo(() => {
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
    return [
      ...specialSections.map((section) => ({ ...section, items: section.items.filter(matches) })),
      ...[...map.values()].sort((first, second) => first.order - second.order),
      ...trailingSections.map((section) => ({ ...section, items: section.items.filter(matches) })),
    ];
  }, [
    filtered,
    categoryDefinitions,
    specialSections,
    trailingSections,
    matches,
    friendDirectory?.categories,
    friendDirectory?.assignments,
  ]);
  const selectionIds = useMemo(
    () => [...new Set(categories.flatMap((category) => category.items.map((item) => item.id)))],
    [categories],
  );

  // 默认全部折叠。
  const [expanded, setExpanded] = useState<Record<string | number, boolean>>({});
  const multi = useMultiSelection({
    ids: selectionIds,
    selected: selection.selectedIds,
    onChange: selection.setSelectedIds,
    anchorRef: selection.anchorRef,
    enabled: selection.selectionMode,
    onStart: () => selection.setSelectionMode(true),
    onExit: () => selection.setSelectionMode(false),
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
    <div className={cn('list-stack', 'contact-cat-list')} {...multi.rootProps}>
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
        const open = Boolean(expanded[category.id]) || Boolean(needle);
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
              <span className={cn('contact-cat-name')}>{category.name}</span>
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
                  const relation = intimateRelationOf(contact);
                  return (
                    <button
                      key={contact.id}
                      className={cn(
                        listRowClass(
                          !selection.selectionMode && contact.id === activeContactId,
                          'contact-row',
                        ),
                        'contact-cat-row',
                        selection.selectionMode &&
                          selection.selectedIds.has(contact.id) &&
                          'is-multiselected',
                      )}
                      aria-pressed={
                        selection.selectionMode ? selection.selectedIds.has(contact.id) : undefined
                      }
                      {...multi.itemProps(contact.id)}
                      draggable={
                        contacts.some((row) => row.id === contact.id) &&
                        friendDirectory?.available &&
                        !friendDirectory.busy
                      }
                      onDragStart={(event) => {
                        const ids =
                          selection.selectionMode && selection.selectedIds.has(contact.id)
                            ? [...selection.selectedIds]
                            : [contact.id];
                        const uids = ids.filter((id) => contacts.some((row) => row.id === id));
                        if (uids.length !== ids.length || !uids.length) {
                          event.preventDefault();
                          return;
                        }
                        dragging.current = { uids };
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', uids.join(','));
                      }}
                      onDragEnd={() => {
                        dragging.current = null;
                        setDragTarget(null);
                      }}
                      onContextMenu={(event) => {
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
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
                          return;
                        event.preventDefault();
                        const rect = event.currentTarget.getBoundingClientRect();
                        setActionMenu({ x: rect.left, y: rect.bottom, contact, ids: [contact.id] });
                      }}
                      onClick={() => {
                        if (!selection.selectionMode) onSelect(contact);
                      }}
                    >
                      <span className="contact-relation-avatar">
                        <Avatar
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
                          {displayUserName(contact)}
                          {contact.kind === 'bot' ? (
                            <small className={cn('bot-badge')} aria-label="机器人" title="机器人">
                              <Bot size={12} strokeWidth={2.4} />
                            </small>
                          ) : null}
                        </span>
                        <span className={cn('contact-card-bottom')}>
                          {contact.onlineStatusObj &&
                          contact.onlineStatusObj.typeName !== '未知' ? (
                            <span className={cn('contact-card-status')}>
                              <ContactOnlineStatusIcon status={contact.onlineStatusObj} />
                              <span>[{contact.onlineStatusObj.displayStatus}]</span>
                            </span>
                          ) : null}
                          {contact.kind !== 'bot' &&
                          contact.identityLabel !== '设备' &&
                          category.id !== 'special:devices' &&
                          category.id !== 'special:bots' ? (
                            <span className={cn('contact-card-signature')}>
                              {contact.signature || '这个人很懒，什么都没留下'}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  );
                })
              : null}
          </div>
        );
      })}
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
            {
              label: '多选',
              icon: <ListChecks size={16} />,
              action: () => {
                selection.setSelectionMode(true);
                selection.setSelectedIds(new Set(actionMenu.ids));
              },
            },
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
                    disabled: !friendDirectory?.available || friendDirectory.busy,
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
}

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

/** 会话列表时间：今天显示时分，昨天显示"昨天"，一周内显示星期，更早显示年月日。 */
export function formatConversationTime(value: string | undefined) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  const now = new Date();
  const todayStart = startOfDay(now).getTime();
  const dateStart = startOfDay(date).getTime();
  const dayDiff = Math.floor((todayStart - dateStart) / 86400000);

  if (dayDiff <= 0) {
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  if (dayDiff === 1) {
    return '昨天';
  }

  if (dayDiff < 7) {
    return ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][date.getDay()];
  }

  return `${date.getFullYear()}/${padDatePart(date.getMonth() + 1)}/${padDatePart(date.getDate())}`;
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

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function padDatePart(value: number) {
  return value.toString().padStart(2, '0');
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
