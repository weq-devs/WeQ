// @ts-nocheck
import {
  BellOff,
  Bot,
  PenLine,
  Pin,
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
  Loader2,
  RefreshCw,
  Plus,
  MessagesSquare,
} from 'lucide-react';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ConversationDirectoryContext,
  ContactDirectoryContext,
  virtualConversationRow,
} from '../../lib/conversationDirectory';
import { useContentMultiSelect } from '../../state/contentSelection';
import { DirectoryToolbar } from '../../components/DirectoryToolbar';
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
import { displayUserName } from './user';

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
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !onLoadMore) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const hit = entries.some((entry) => entry.isIntersecting);
        setVisible(hit);
        if (hit && !loading) onLoadMore();
      },
      { rootMargin: '240px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [onLoadMore, loading]);

  return (
    <div ref={sentinelRef} className="conversation-list-load-more">
      {loading ? (
        <Loader2 size={14} className="spin" />
      ) : visible ? (
        '加载中…'
      ) : (
        <button type="button" onClick={onLoadMore}>
          加载更多会话
        </button>
      )}
    </div>
  );
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
  const [keyword, setKeyword] = useState('');
  const [scope, setScope] = useState<'all' | 'real' | 'virtual'>('all');
  const [scopeOpen, setScopeOpen] = useState(false);
  const { selectionMode, selectedIds, setSelectedIds, setSelectionMode } = useContentMultiSelect({
    kind: 'conversations',
    container: 'main-list',
  });
  const listRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(600);
  const menuRef = useRef<HTMLDivElement>(null);
  const virtualIds = useMemo(
    () => new Set(directory?.virtual.map((item) => item.id)),
    [directory?.virtual],
  );
  const filtered = useMemo(() => {
    // 置顶会话排最前。sort 是稳定的，所以 MainView 已排好的置顶时间（41103）
    // 次序在这里被保留。
    const needle = keyword.trim().toLocaleLowerCase();
    const real = needle ? (directory?.real ?? conversations) : conversations;
    const rows = [
      ...(scope === 'virtual' ? [] : real),
      ...(scope === 'real' ? [] : (directory?.virtual ?? []).map(virtualConversationRow)),
    ].filter(
      (row) =>
        !needle ||
        `${conversationTitle(row)} ${conversationSeed(row)}`.toLocaleLowerCase().includes(needle),
    );
    return rows.sort(
      (first, second) =>
        Number(isPinned(second, preferences)) - Number(isPinned(first, preferences)),
    );
  }, [conversations, preferences, directory?.virtual, directory?.real, keyword, scope]);

  const locateId = directory?.locate?.id;
  const locateRevision = directory?.locate?.revision;
  useEffect(() => {
    if (!locateId) return;
    setKeyword('');
    setScope('all');
  }, [locateId, locateRevision]);
  useEffect(() => {
    const measure = () => {
      if (listRef.current) setListHeight(Math.max(62, listRef.current.clientHeight - 44));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (listRef.current) observer.observe(listRef.current);
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

  return (
    <div className="list-stack weq-conversation-directory" ref={listRef}>
      <DirectoryToolbar
        noun="会话"
        query={keyword}
        onQuery={setKeyword}
        selecting={selectionMode}
        onSelecting={setSelectionMode}
        count={selectedIds.size}
        onSelectAll={() => setSelectedIds(new Set(filtered.map((item) => item.id)))}
      >
        <div className="weq-directory-scope" ref={menuRef}>
          <button
            type="button"
            title={`显示范围：${scope === 'all' ? '真实与虚拟' : scope === 'real' ? '仅真实会话' : '仅虚拟会话'}`}
            aria-label="显示范围"
            aria-haspopup="menu"
            aria-expanded={scopeOpen}
            onClick={() => setScopeOpen(!scopeOpen)}
          >
            {scope === 'all' ? (
              <MessagesSquare size={16} />
            ) : scope === 'real' ? (
              <UserRound size={16} />
            ) : (
              <Bot size={16} />
            )}
          </button>
          {scopeOpen ? (
            <div role="menu" className="weq-directory-scope-menu" aria-label="会话显示范围">
              {[
                { id: 'all', name: '真实与虚拟', icon: MessagesSquare },
                { id: 'real', name: '仅真实会话', icon: UserRound },
                { id: 'virtual', name: '仅虚拟会话', icon: Bot },
              ].map((item) => (
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
        <button
          type="button"
          title="添加会话克隆"
          aria-label="添加会话克隆"
          disabled={!directory}
          onClick={() => directory?.onCreate()}
        >
          <Plus size={16} />
        </button>
      </DirectoryToolbar>
      {loading ? <ListSkeleton rows={9} /> : null}
      {!loading && !filtered.length ? (
        <EmptyState title="暂无会话" body="" icon={<MessageSquare />} />
      ) : null}
      <WindowedList
        items={filtered}
        rowHeight={62}
        height={listHeight}
        resetKey={`${scope}:${keyword}`}
        itemKey={(item) => item.id}
        scrollToKey={scope === 'all' && !keyword ? locateId : null}
        scrollRevision={locateRevision}
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
          const showGroupAnnouncement = unreadCount > 0 && highlightKinds.has('groupAnnouncement');
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

          return (
            <button
              key={conversation.id}
              data-conversation-id={conversation.id}
              className={cn(
                listRowClass(!selectionMode && active, 'conversation-row'),
                pinned && 'pinned',
                selectionMode && selectedIds.has(conversation.id) && 'is-multiselected',
              )}
              aria-pressed={selectionMode ? selectedIds.has(conversation.id) : undefined}
              onClick={(e) => {
                if (selectionMode) {
                  setSelectedIds((current) => {
                    const next = new Set(current);
                    if (next.has(conversation.id)) next.delete(conversation.id);
                    else next.add(conversation.id);
                    return next;
                  });
                  return;
                }
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
                  ) : conversation.mergedKind === 'service' ||
                    conversation.mergedKind === 'groupAssistant' ? (
                    <Users size={20} strokeWidth={2} />
                  ) : (
                    <UserRound size={20} strokeWidth={2} />
                  )}
                </span>
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
                  {virtualIds.has(conversation.id) ? (
                    <small
                      className="weq-conversation-virtual"
                      title="虚拟会话"
                      aria-label="虚拟会话"
                    >
                      <Bot size={12} />
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
                      {showAtAll ? <span className={cn('row-mention-alert')}>[@全体]</span> : null}
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
                  {!unreadCount && muted ? <BellOff className={cn('row-muted')} size={15} /> : null}
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
                {unreadCount ? (
                  <span className={cn(unreadClass(muted))}>{formatBadgeCount(unreadCount)}</span>
                ) : null}
              </span>
            </button>
          );
        }}
      />
      {hasMore ? <ConversationListLoadMore loading={loadingMore} onLoadMore={onLoadMore} /> : null}
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
          `${conversationTitle(item)} ${conversationSeed(item)}`
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

  if (loading) return <ListSkeleton rows={9} />;
  if (!categories.some((category) => category.items.length) && !historicalCategory.items.length)
    return <EmptyState title="暂无群聊" body="从左上角 + 创建一个群聊。" icon={<Users />} />;
  return (
    <div className={cn('list-stack', 'contact-cat-list')}>
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
        />
      ))}
      <GroupNotificationSection
        category={historicalCategory}
        activeConversationId={activeConversationId}
        onSelect={onSelect}
      />
    </div>
  );
}

function GroupNotificationSection({ category, activeConversationId, onSelect }) {
  const directory = useContext(ContactDirectoryContext);
  const selection = useContentMultiSelect({ kind: 'contacts', container: 'groups' });
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
              onClick={(event) => {
                if (selection.selectionMode)
                  selection.setSelectedIds((current) => {
                    const next = new Set(current);
                    if (next.has(conversation.id)) next.delete(conversation.id);
                    else next.add(conversation.id);
                    return next;
                  });
                else onSelect(conversation.id, event);
              }}
            >
              <Avatar
                name={conversation.group.name}
                avatarUrl={conversation.group.avatarUrl}
                seed={conversation.id}
              />
              <span className="row-main">
                <strong>
                  <span className="row-title-text">{conversation.group.name}</span>
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

export function ContactList({
  contacts,
  categoryDefinitions = [],
  specialSections = [],
  trailingSections = [],
  activeContactId,
  onSelect,
  loading,
}: {
  contacts: Contact[];
  categoryDefinitions?: { id: number; name: string; buddyCount: number; sortOrder?: number }[];
  specialSections?: ContactSection[];
  trailingSections?: ContactSection[];
  activeContactId: string | null;
  onSelect: (contact: Contact) => void;
  loading?: boolean;
}) {
  const directory = useContext(ContactDirectoryContext);
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

  // 按好友分组归类，分组内保持原顺序；分组按 categoryId 升序（0「我的好友」在前）。
  const categories = useMemo(() => {
    const map = new Map<number, { id: number; name: string; items: Contact[]; order: number }>();
    categoryDefinitions.forEach((category, index) => {
      map.set(category.id, {
        id: category.id,
        name: category.name || (category.id === 0 ? '我的好友' : '未命名分组'),
        items: [],
        order: category.sortOrder ?? index,
      });
    });
    for (const contact of filtered) {
      const id = contact.categoryId ?? 0;
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
  }, [filtered, categoryDefinitions, specialSections, trailingSections, matches]);

  // 默认全部折叠。
  const [expanded, setExpanded] = useState<Record<string | number, boolean>>({});

  if (loading) {
    return <ListSkeleton rows={9} />;
  }

  if (categories.length === 0) {
    return (
      <EmptyState
        title="暂无联系人"
        body="通过 ID 搜索或邀请链接添加联系人。"
        icon={<UserRound />}
      />
    );
  }

  return (
    <div className={cn('list-stack', 'contact-cat-list')}>
      {categories.map((category) => {
        const open = Boolean(expanded[category.id]) || Boolean(needle) || selection.selectionMode;
        return (
          <div className={cn('contact-cat')} key={category.id}>
            <button
              type="button"
              className={cn('contact-cat-header')}
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
              ? category.items.map((contact) => (
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
                    onClick={() => {
                      if (selection.selectionMode)
                        selection.setSelectedIds((current) => {
                          const next = new Set(current);
                          if (next.has(contact.id)) next.delete(contact.id);
                          else next.add(contact.id);
                          return next;
                        });
                      else onSelect(contact);
                    }}
                  >
                    <Avatar
                      name={displayUserName(contact)}
                      avatarUrl={contact.avatarUrl}
                      seed={contact.identityValue}
                    />
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
                        {contact.onlineStatusObj && contact.onlineStatusObj.typeName !== '未知' ? (
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
                ))
              : null}
          </div>
        );
      })}
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
    ? conversation.group.name
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
  return Boolean(
    {
      ...conversation.preference,
      ...preferences[conversation.id],
    }.pinned,
  );
}

function listRowClass(active: boolean, semanticClass: 'conversation-row' | 'contact-row') {
  return cn(semanticClass, active && 'active');
}

function unreadClass(muted: boolean) {
  return cn('row-unread', muted && 'muted');
}
