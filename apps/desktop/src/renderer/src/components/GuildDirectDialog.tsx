/**
 * GuildDirectDialog — QQ 频道内的本地私聊查看器。
 *
 * 左侧私聊列表只读 `direct_node_list_table`（guild_msg.db），绝不回扫
 * `guild_msg_table` 匹配特征补全会话。右侧按 40027 node id 查同库
 * `guild_msg_table` 的本地消息：最新 seq 起始（消息贴底），向上滚动加载更旧页。
 * 消息渲染复用主聊天的 MessageBubble + 渲染器（含 40801 装扮）；自己的消息使用
 * 主界面的账号头像（selfUser，不依赖 t_GPro_ProfileInfo），对方头像来自
 * t_GPro_CommonUserProfile_v2.avatar_meta_ 派生的 URL（可能为空）。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import {
  ArrowLeft,
  CheckSquare,
  Hash,
  Inbox,
  MessageSquareText,
  RotateCw,
  X,
  Copy,
  Download,
  FileText,
  ClipboardCopy,
} from 'lucide-react';
import { Modal } from './Dialog';
import { client } from '../trpc/client';
import { cn } from '../im-template/template/classNames';
import { Avatar } from '../im-template/template/primitives';
import { MessageBubble } from '../im-template/template/messageBubble';
import { MessageTimeDivider, shouldShowMessageTime } from '../im-template/template/messageTime';
import { displayUserName } from '../im-template/template/user';
import type { MessageRenderer } from '../im-template/template/messageRenderers';
import type { Conversation, Message, User } from '../im-template/template/types';
import { ConvContext, ForwardKindContext, ReplyJumpContext } from './QqMessageContent';
import { previewNodes, previewNodesToText } from '../lib/conversationPreview';
import { useContentMultiSelect, useRequestContentExport } from '../state/contentSelection';
import { useMultiSelection } from '../hooks/useMultiSelection';
import { useMessageMarquee } from '../hooks/useMessageMarquee';
import { selectedMessagesText } from '../lib/messageSelection';
import { messageRichClipboard } from '../lib/messageClipboard';
import { writeMentionClipboard } from '../lib/mentionClipboard';
import { copyTextToClipboard } from '../im-template/template/clipboard';
import { ConversationActionsMenu } from './ConversationActionsMenu';
import { useToast } from './Toast';
import type { RepeatElement } from '../lib/messageRepeat';
import '../styles/channel.css';

const PAGE = 50;
export interface GuildSearchTarget {
  nodeId: string;
  msgId: string;
  msgSeq: string;
  revision: string;
}

/** 40013 之外的值（观察为 2）= 本账号设备发的消息；0 = 对方。 */
function isSelfSent(sendType: string): boolean {
  return sendType !== '0';
}

/** 会话 wire 形状（serde.guildDirectSessionToWire 输出）。 */
interface GuildDirectSessionWire {
  nodeId: string;
  directGid: string;
  lastTime: string;
  lastSeq: string;
  peerTinyId: string;
  guildId: string;
  guildName: string;
  nickChannel: string;
  nickGlobal: string;
  peerNick: string;
  peerAvatarUrl: string | null;
  preview: unknown | null;
}

/** 消息 wire 形状（serde.guildDirectMsgToWire 输出）。 */
interface GuildDirectMsgWire {
  msgId: string;
  msgSeq: string;
  nodeId: string;
  senderTinyId: string;
  sendType: string;
  sendTime: string;
  elements: unknown[];
  decoration?: { bubbleId: number; fontId: number; widgetId: number };
}

/** 一条 wire 消息 + 渲染所需的派生字段。 */
interface BuiltRow {
  message: Message & {
    qqElements: unknown[];
    msgId: string;
    msgSeq: string;
    decoration?: unknown;
  };
  sender: User;
  mine: boolean;
}

const noop = (): void => {};

function toIsoTime(seconds: string): string {
  const secs = Number(seconds);
  if (!Number.isFinite(secs) || secs <= 0) return '';
  const date = new Date(secs * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function formatListTime(seconds: string): string {
  const secs = Number(seconds);
  if (!Number.isFinite(secs) || secs <= 0) return '';
  const d = new Date(secs * 1000);
  if (!Number.isFinite(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 会话列表预览（40051）→ 纯文本；频道元素常不带正文，可能为空串。 */
function sessionPreviewText(session: GuildDirectSessionWire): string {
  return previewNodesToText(previewNodes(session.preview ?? null));
}

/** 消息 40800 元素 → 纯文本兜底（富节点由渲染器接管，这里只做 fallback）。 */
function messageBodyText(elements: unknown[]): string {
  if (!Array.isArray(elements)) return '';
  return elements
    .map((el) => previewNodesToText(previewNodes(el)))
    .filter((text) => text.length > 0)
    .join(' ');
}

function peerUser(session: GuildDirectSessionWire): User {
  return {
    id: `guild:${session.nodeId}`,
    identityLabel: '频道',
    identityValue: session.peerTinyId,
    username: session.peerTinyId,
    displayName: session.peerNick || session.peerTinyId,
    avatarUrl: session.peerAvatarUrl,
    kind: 'human',
  };
}

function buildConversation(session: GuildDirectSessionWire): Conversation {
  return {
    type: 'direct',
    id: `guild:${session.nodeId}`,
    updatedAt: toIsoTime(session.lastTime),
    unreadCount: 0,
    lastMessage: null,
    otherUser: peerUser(session),
    group: null,
    members: [],
  };
}

function buildRow(
  raw: GuildDirectMsgWire,
  session: GuildDirectSessionWire,
  selfUser: User,
): BuiltRow {
  const mine = isSelfSent(raw.sendType);
  const sender = mine ? selfUser : peerUser(session);
  const message = {
    id: raw.msgId,
    conversationId: `guild:${session.nodeId}`,
    senderId: sender.id,
    sender,
    body: messageBodyText(raw.elements),
    createdAt: toIsoTime(raw.sendTime),
    qqElements: raw.elements ?? [],
    msgId: raw.msgId,
    msgSeq: raw.msgSeq,
    ...(raw.decoration ? { decoration: raw.decoration } : {}),
  } as BuiltRow['message'];
  return { message, sender, mine };
}

export function GuildDirectDialog({
  open,
  onClose,
  selfUser,
  renderers,
  embedded = false,
  active = open,
  searchTarget,
  onActiveSessionChange,
}: {
  open: boolean;
  onClose: () => void;
  /** 当前账号在主界面的 User（自带 QQ 头像）——绝不来自 t_GPro_ProfileInfo。 */
  selfUser: User;
  /** 与主聊天相同的渲染器（qqMessageRenderer 等）。 */
  renderers?: MessageRenderer[];
  embedded?: boolean;
  active?: boolean;
  searchTarget?: GuildSearchTarget | null;
  /** 当前打开的会话 nodeId，交给外层浮动工具按当前位置导出。 */
  onActiveSessionChange?: (nodeId: string | null) => void;
}): ReactElement | null {
  const [sessions, setSessions] = useState<GuildDirectSessionWire[] | null>(null);
  const [selected, setSelected] = useState<GuildDirectSessionWire | null>(null);
  /** 已加载消息，seq 从小到大（旧的在上、新的在下）。 */
  const [messages, setMessages] = useState<GuildDirectMsgWire[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [latestLoading, setLatestLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [messageError, setMessageError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const runRef = useRef(0);
  const [searchMessageId, setSearchMessageId] = useState<string | null>(null);
  const [searchNotice, setSearchNotice] = useState('');
  const handledSearch = useRef('');
  const scrolledSearch = useRef('');
  const [searchRetry, setSearchRetry] = useState(0);
  // 把当前打开的频道私聊同步给外层（浮动工具「导出当前频道私聊」用它定位）。
  useEffect(() => {
    onActiveSessionChange?.(selected?.nodeId ?? null);
  }, [selected?.nodeId, onActiveSessionChange]);
  const selection = useContentMultiSelect({
    kind: 'guild-direct',
    container: selected?.nodeId ?? '',
  });
  const requestExport = useRequestContentExport();
  const [copyMenu, setCopyMenu] = useState<{ x: number; y: number } | null>(null);
  const selectionAnchor = useRef<string | null>(null);
  useEffect(
    () => () => {
      selection.setSelectionMode(false);
      selectionAnchor.current = null;
      setCopyMenu(null);
    },
    [selection.setSelectionMode],
  );
  useEffect(() => {
    if (!active) selection.setSelectionMode(false);
  }, [active, selection.setSelectionMode]);
  const multi = useMultiSelection({
    ids: messages.map((message) => message.msgId),
    selected: selection.selectedIds,
    onChange: selection.setSelectedIds,
    enabled: selection.selectionMode,
    disabled: !active,
    anchorRef: selectionAnchor,
    onStart: () => selection.setSelectionMode(true),
    onExit: () => selection.setSelectionMode(false),
  });
  const marquee = useMessageMarquee({
    conversationKey: selected?.nodeId,
    enabled: active && Boolean(selected) && !copyMenu,
    selectionMode: selection.selectionMode,
    selected: selection.selectedIds,
    orderedIds: messages.map((message) => message.msgId),
    anchorRef: selectionAnchor,
    onChange: selection.setSelectedIds,
    onStart: () => selection.setSelectionMode(true),
    onSelect: multi.toggle,
  });

  // 打开时拉一遍会话列表（列表小，一次性加载）。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const run = ++runRef.current;
    setSessions(null);
    setSelected(null);
    setMessages([]);
    setHasMore(false);
    setListLoading(true);
    setListError(null);
    void client.account.guildDirectListSessions
      .query()
      .then((rows) => {
        if (cancelled || run !== runRef.current) return;
        setSessions((rows as GuildDirectSessionWire[]) ?? []);
      })
      .catch((error: unknown) => {
        if (cancelled || run !== runRef.current) return;
        setListError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (cancelled || run !== runRef.current) return;
        setListLoading(false);
      });
    return () => {
      cancelled = true;
      runRef.current++;
    };
  }, [open]);

  // 选中会话 → 加载最新一页（seq 大到小），反转成升序渲染。
  const openSession = useCallback((session: GuildDirectSessionWire) => {
    setSearchMessageId(null);
    setSearchNotice('');
    const run = ++runRef.current;
    setSelected(session);
    setMessages([]);
    setHasMore(false);
    setLatestLoading(true);
    setOlderLoading(false);
    setMessageError(null);
    void client.account.guildDirectLatest
      .query({ nodeId: session.nodeId, limit: PAGE, stablePaging: true })
      .then((rows) => {
        if (run !== runRef.current) return;
        const asc = ((rows as GuildDirectMsgWire[]) ?? []).slice().reverse();
        setMessages(asc);
        setHasMore(asc.length >= PAGE);
      })
      .catch((error: unknown) => {
        if (run !== runRef.current) return;
        setMessageError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (run !== runRef.current) return;
        setLatestLoading(false);
      });
  }, []);
  useEffect(() => {
    if (
      !open ||
      listLoading ||
      !sessions ||
      !searchTarget ||
      handledSearch.current === searchTarget.revision
    )
      return;
    handledSearch.current = searchTarget.revision;
    const session = sessions.find((item) => item.nodeId === searchTarget.nodeId);
    if (!session) {
      setSelected(null);
      setMessages([]);
      setSearchNotice('搜索命中的频道私聊会话已删除或本地不可用。');
      return;
    }
    // 只指定了会话、没有指定消息：直接从会话列表/聚合入口打开，不拉锚点上下文。
    if (!searchTarget.msgId) {
      openSession(session);
      return;
    }
    const run = ++runRef.current;
    setSelected(session);
    setMessages([]);
    setHasMore(false);
    setLatestLoading(true);
    setOlderLoading(false);
    setMessageError(null);
    setSearchNotice('');
    setSearchMessageId(searchTarget.msgId);
    void client.account.guildDirectAround
      .query({
        nodeId: searchTarget.nodeId,
        msgId: searchTarget.msgId,
        msgSeq: searchTarget.msgSeq,
      })
      .then((result) => {
        if (run !== runRef.current) return;
        if (!result.found) {
          setMessageError('搜索命中的消息已删除或本地不可用。');
          return;
        }
        setMessages(result.items as GuildDirectMsgWire[]);
        setHasMore(result.hasMore);
      })
      .catch((error: unknown) => {
        if (run === runRef.current)
          setMessageError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (run === runRef.current) setLatestLoading(false);
      });
  }, [open, sessions, listLoading, searchTarget, searchRetry, openSession]);
  useEffect(() => {
    if (!searchMessageId || latestLoading) return;
    const key = JSON.stringify([searchTarget?.revision, searchMessageId]);
    if (scrolledSearch.current === key) return;
    const frame = requestAnimationFrame(() => {
      const row = [
        ...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-guild-msg-id]') ?? []),
      ].find((node) => node.dataset.guildMsgId === searchMessageId);
      if (!row) return;
      scrolledSearch.current = key;
      row.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [searchMessageId, latestLoading, messages, searchTarget?.revision]);

  // 切换会话 / 最新页落地后滚到底部（贴最新）。
  useLayoutEffect(() => {
    if (!selected || latestLoading) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [selected, latestLoading, messages.length === 0]);

  // 向上翻更旧的一页：beforeSeq = 当前最旧一条的 seq。
  const loadOlder = useCallback(async () => {
    const el = scrollRef.current;
    if (!el || !selected || olderLoading || latestLoading || !hasMore) return;
    const oldest = messages[0];
    if (!oldest) return;
    const run = runRef.current;
    const prevHeight = el.scrollHeight;
    setOlderLoading(true);
    setMessageError(null);
    try {
      const rows = (await client.account.guildDirectBefore.query({
        nodeId: selected.nodeId,
        beforeSeq: oldest.msgSeq,
        beforeMsgId: oldest.msgId,
        limit: PAGE,
      })) as GuildDirectMsgWire[];
      if (run !== runRef.current) return;
      const asc = (rows ?? []).slice().reverse();
      setMessages((prev) => [...asc, ...prev]);
      setHasMore(asc.length >= PAGE);
      // 保持视口锚点：新页插在顶部，把滚动条往下推回原内容处。
      requestAnimationFrame(() => {
        if (run !== runRef.current) return;
        const now = scrollRef.current;
        if (!now) return;
        now.scrollTop = Math.max(0, now.scrollHeight - prevHeight);
      });
    } catch (error) {
      if (run === runRef.current)
        setMessageError(error instanceof Error ? error.message : String(error));
    } finally {
      if (run === runRef.current) setOlderLoading(false);
    }
  }, [selected, messages, olderLoading, latestLoading, hasMore]);

  const handleMsgScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop <= 64) void loadOlder();
  }, [loadOlder]);

  const conversation = useMemo(() => (selected ? buildConversation(selected) : null), [selected]);
  // 遍历时携带上一条消息，避免按索引回看（noUncheckedIndexedAccess）。
  const rows = useMemo(() => {
    if (!selected) return [];
    let previous: Message | undefined;
    return messages.map((raw) => {
      const row = buildRow(raw, selected, selfUser);
      const entry = { row, previous };
      if (row.message.createdAt) previous = row.message;
      return entry;
    });
  }, [messages, selected, selfUser]);
  const peer = selected ? peerUser(selected) : null;
  const picked = rows.filter(({ row }) => selection.selectedIds.has(row.message.id));
  const copySelected = async (format: 'text' | 'rich' | 'json') => {
    if (!conversation || !picked.length) return;
    try {
      const copied =
        format === 'rich'
          ? await writeMentionClipboard(
              messageRichClipboard(
                picked.map(({ row }) => ({
                  sender: displayUserName(row.sender),
                  time: row.message.createdAt,
                  body: row.message.body,
                  elements: row.message.qqElements as RepeatElement[],
                })),
              ),
            )
          : await copyTextToClipboard(
              format === 'json'
                ? JSON.stringify(
                    picked.map(({ row }) => row.message),
                    null,
                    2,
                  )
                : selectedMessagesText(
                    picked.map(({ row }) => row.message),
                    conversation,
                    selfUser,
                  ),
            );
      if (!copied) throw new Error('无法写入剪贴板');
    } catch (error) {
      useToast.getState().push({
        tone: 'error',
        title: '复制失败',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  if (!open) return null;

  const content = (
    <div
      className={cn(
        'weq-guild-direct',
        selected && 'has-selected-session',
        embedded && 'is-embedded',
      )}
      role={embedded ? 'region' : undefined}
      aria-labelledby="weq-guild-direct-title"
    >
      <header className="weq-guild-direct-head">
        <span className="weq-guild-direct-title">
          <span className="weq-guild-direct-title-icon" aria-hidden="true">
            <Hash size={16} strokeWidth={2} />
          </span>
          <strong id="weq-guild-direct-title">频道私聊</strong>
        </span>
        <button
          type="button"
          className="weq-compose-x"
          onClick={onClose}
          title={embedded ? '返回 QQ 频道' : '关闭'}
          aria-label={embedded ? '返回 QQ 频道' : '关闭'}
        >
          {embedded ? <ArrowLeft size={17} /> : <X size={17} />}
        </button>
      </header>

      {searchNotice ? <p role="status">{searchNotice}</p> : null}
      <div className="weq-guild-direct-body">
        <aside className="weq-guild-direct-side">
          <div className="weq-guild-direct-side-title">会话列表</div>
          <div className="weq-guild-direct-list">
            {listLoading ? (
              <div className="weq-guild-direct-empty">加载中…</div>
            ) : listError ? (
              <div className="weq-guild-direct-empty">
                <Inbox size={26} />
                <span>会话列表加载失败</span>
                <small>{listError}</small>
              </div>
            ) : !sessions || sessions.length === 0 ? (
              <div className="weq-guild-direct-empty">
                <Inbox size={26} />
                <span>没有频道私聊会话</span>
                <small>该账号本地没有 direct_node_list_table 会话记录。</small>
              </div>
            ) : (
              sessions.map((session) => {
                const active = selected?.nodeId === session.nodeId;
                const previewText = sessionPreviewText(session);
                return (
                  <button
                    type="button"
                    key={session.nodeId}
                    className={cn('weq-guild-direct-item', active && 'active')}
                    onClick={() => openSession(session)}
                  >
                    <Avatar
                      name={session.peerNick || session.peerTinyId}
                      avatarUrl={session.peerAvatarUrl}
                      seed={session.peerTinyId}
                    />
                    <span className="weq-guild-direct-item-main">
                      <span className="weq-guild-direct-item-top">
                        <span className="weq-guild-direct-item-title">
                          <span className="weq-guild-direct-item-name">
                            {session.peerNick || session.peerTinyId}
                          </span>
                          {session.guildName ? (
                            <span className="weq-guild-direct-item-guild" title={session.guildName}>
                              <Hash size={11} strokeWidth={2.4} aria-hidden="true" />
                              <span className="weq-guild-direct-item-guild-text">
                                {session.guildName}
                              </span>
                            </span>
                          ) : null}
                        </span>
                        <time className="weq-guild-direct-item-time">
                          {formatListTime(session.lastTime)}
                        </time>
                      </span>
                      <span className="weq-guild-direct-item-preview">
                        {previewText || '（无本地预览）'}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <section className="weq-guild-direct-chat">
          {!selected || !conversation || !peer ? (
            <div className="weq-guild-direct-empty weq-guild-direct-pick-hint">
              <MessageSquareText size={34} strokeWidth={1.5} />
              <span>选择会话查看频道私聊</span>
              <small>从左侧选择一个频道私聊会话，右侧展示该会话的本地消息。</small>
            </div>
          ) : (
            <>
              <div className="weq-guild-direct-chat-head">
                <button
                  type="button"
                  className="weq-guild-direct-list-back"
                  title="会话列表"
                  aria-label="会话列表"
                  onClick={() => setSelected(null)}
                >
                  <ArrowLeft size={18} />
                </button>
                <Avatar
                  name={peer.displayName}
                  avatarUrl={peer.avatarUrl}
                  seed={peer.identityValue}
                />
                <span className="weq-guild-direct-chat-title">
                  <span className="weq-guild-direct-chat-namewrap">
                    <strong>{peer.displayName}</strong>
                    {selected.guildName ? (
                      <span className="weq-guild-direct-chat-guild" title={selected.guildName}>
                        <Hash size={12} strokeWidth={2.2} aria-hidden="true" />
                        <span className="weq-guild-direct-chat-guild-text">
                          {selected.guildName}
                        </span>
                      </span>
                    ) : null}
                  </span>
                </span>
                <button
                  type="button"
                  className={cn('weq-compose-x', selection.selectionMode && 'active')}
                  title={selection.selectionMode ? '退出消息多选' : '多选消息'}
                  aria-label={selection.selectionMode ? '退出消息多选' : '多选消息'}
                  aria-pressed={selection.selectionMode}
                  onClick={() => selection.setSelectionMode(!selection.selectionMode)}
                >
                  {selection.selectionMode ? <X size={17} /> : <CheckSquare size={17} />}
                </button>
              </div>

              <div className="weq-guild-direct-topbar" aria-live="polite">
                {selection.selectionMode ? (
                  <span>已选 {selection.selectedIds.size} 条消息</span>
                ) : null}
                {olderLoading ? (
                  <span>加载更早消息…</span>
                ) : hasMore ? (
                  <span>继续向上滚动可加载更早的本地消息</span>
                ) : rows.length > 0 ? (
                  <span>已是最早的本地消息</span>
                ) : null}
              </div>
              {messageError ? (
                <div className="weq-search-failure" role="status">
                  <span title={messageError}>消息读取失败</span>
                  <button
                    type="button"
                    title="重试读取消息"
                    aria-label="重试读取消息"
                    onClick={() => {
                      if (
                        searchTarget &&
                        searchMessageId === searchTarget.msgId &&
                        !messages.length
                      ) {
                        handledSearch.current = '';
                        setSearchRetry((value) => value + 1);
                      } else if (messages.length) void loadOlder();
                      else openSession(selected);
                    }}
                  >
                    <RotateCw size={14} />
                  </button>
                </div>
              ) : null}

              <ForwardKindContext.Provider value="c2c">
                <ConvContext.Provider value="">
                  <ReplyJumpContext.Provider value={noop}>
                    <div
                      className={cn('message-scroll', 'weq-guild-direct-msgs')}
                      {...multi.rootProps}
                      {...marquee.handlers}
                      ref={(element) => {
                        scrollRef.current = element;
                        multi.rootProps.ref(element);
                      }}
                      onScroll={handleMsgScroll}
                      onKeyDown={(event) => {
                        multi.rootProps.onKeyDown(event);
                        if (
                          !event.defaultPrevented &&
                          selection.selectionMode &&
                          (event.ctrlKey || event.metaKey) &&
                          event.key.toLowerCase() === 'c'
                        ) {
                          event.preventDefault();
                          void copySelected(event.shiftKey ? 'rich' : 'text');
                        }
                      }}
                    >
                      {latestLoading ? (
                        <div className="weq-guild-direct-empty">加载消息…</div>
                      ) : rows.length === 0 ? (
                        <div className="weq-guild-direct-empty">
                          <Inbox size={26} />
                          <span>{messageError ? '无法读取指定消息' : '该会话没有本地消息'}</span>
                        </div>
                      ) : (
                        rows.map(({ row, previous }) => (
                          <div
                            key={row.message.id}
                            data-guild-msg-id={row.message.id}
                            data-message-id={row.message.id}
                            {...multi.itemProps(row.message.id)}
                            className={cn(
                              'weq-guild-direct-msg',
                              selection.selectedIds.has(row.message.id) && 'is-selected',
                              row.message.id === searchMessageId && 'is-search-hit',
                            )}
                            aria-selected={
                              selection.selectionMode
                                ? selection.selectedIds.has(row.message.id)
                                : undefined
                            }
                          >
                            {shouldShowMessageTime(previous, row.message) ? (
                              <MessageTimeDivider value={row.message.createdAt} />
                            ) : null}
                            <MessageBubble
                              message={row.message}
                              conversation={conversation}
                              sender={row.sender}
                              mine={row.mine}
                              senderName={displayUserName(row.sender)}
                              senderAvatarUrl={row.sender.avatarUrl}
                              senderSeed={row.sender.identityValue}
                              senderKind={row.sender.kind}
                              showSenderName={false}
                              active={false}
                              selectionMode={selection.selectionMode}
                              selected={selection.selectedIds.has(row.message.id)}
                              renderers={renderers}
                              onContextMenu={noop}
                              onLongPress={noop}
                            />
                          </div>
                        ))
                      )}
                      {marquee.box ? (
                        <div className="weq-message-marquee" style={marquee.box} />
                      ) : null}
                    </div>
                  </ReplyJumpContext.Provider>
                </ConvContext.Provider>
              </ForwardKindContext.Provider>
              {selection.selectionMode ? (
                <div className="selection-bar">
                  <div className="selection-bar-info" aria-live="polite">
                    已选 {picked.length} 条消息
                  </div>
                  <div className="selection-bar-actions">
                    {requestExport ? (
                      <button
                        type="button"
                        className="selection-action"
                        title="导出所选消息"
                        aria-label="导出所选消息"
                        disabled={!picked.length}
                        onClick={() =>
                          requestExport({
                            owner: { kind: 'guild-direct', container: selected.nodeId },
                            scope: { type: 'items', ids: picked.map(({ row }) => row.message.id) },
                          })
                        }
                      >
                        <Download size={17} />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="selection-action"
                      title="复制所选消息"
                      aria-label="复制所选消息"
                      disabled={!picked.length}
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        setCopyMenu({ x: rect.left, y: rect.top });
                      }}
                    >
                      <Copy size={17} />
                    </button>
                    <button
                      type="button"
                      className="selection-action"
                      title="退出多选"
                      aria-label="退出多选"
                      onClick={() => selection.setSelectionMode(false)}
                    >
                      <X size={17} />
                    </button>
                  </div>
                </div>
              ) : null}
              {selection.selectionMode && copyMenu ? (
                <ConversationActionsMenu
                  label="复制格式"
                  {...copyMenu}
                  onClose={() => setCopyMenu(null)}
                  actions={[
                    {
                      label: '纯文本',
                      icon: <FileText size={16} />,
                      action: () => void copySelected('text'),
                    },
                    {
                      label: '富文本',
                      icon: <Copy size={16} />,
                      action: () => void copySelected('rich'),
                    },
                    {
                      label: 'JSON',
                      icon: <ClipboardCopy size={16} />,
                      action: () => void copySelected('json'),
                    },
                  ]}
                />
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
  return embedded ? (
    content
  ) : (
    <Modal
      presentation="page"
      title="频道私聊"
      onClose={onClose}
      width={1120}
      labelledBy="weq-guild-direct-title"
    >
      {content}
    </Modal>
  );
}
