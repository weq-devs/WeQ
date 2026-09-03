/**
 * GuildDirectDialog — 左栏「更多功能 → 频道私聊」查看器（大灯箱卡片）。
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
import { Hash, Inbox, MessageSquareText, X } from 'lucide-react';
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

const PAGE = 50;

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
  if (!Number.isFinite(secs) || secs <= 0) return new Date(0).toISOString();
  return new Date(secs * 1000).toISOString();
}

function formatListTime(seconds: string): string {
  const secs = Number(seconds);
  if (!Number.isFinite(secs) || secs <= 0) return '';
  const d = new Date(secs * 1000);
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
}: {
  open: boolean;
  onClose: () => void;
  /** 当前账号在主界面的 User（自带 QQ 头像）——绝不来自 t_GPro_ProfileInfo。 */
  selfUser: User;
  /** 与主聊天相同的渲染器（qqMessageRenderer 等）。 */
  renderers?: MessageRenderer[];
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const runRef = useRef(0);

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
    };
  }, [open]);

  // 选中会话 → 加载最新一页（seq 大到小），反转成升序渲染。
  const openSession = useCallback((session: GuildDirectSessionWire) => {
    const run = ++runRef.current;
    setSelected(session);
    setMessages([]);
    setHasMore(false);
    setLatestLoading(true);
    void client.account.guildDirectLatest
      .query({ nodeId: session.nodeId, limit: PAGE })
      .then((rows) => {
        if (run !== runRef.current) return;
        const asc = ((rows as GuildDirectMsgWire[]) ?? []).slice().reverse();
        setMessages(asc);
        setHasMore(asc.length >= PAGE);
      })
      .catch(() => {
        // 单会话失败保持空态，不让错误顶掉整个面板。
      })
      .finally(() => {
        if (run !== runRef.current) return;
        setLatestLoading(false);
      });
  }, []);

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
    try {
      const rows = (await client.account.guildDirectBefore.query({
        nodeId: selected.nodeId,
        beforeSeq: oldest.msgSeq,
        limit: PAGE,
      })) as GuildDirectMsgWire[];
      if (run !== runRef.current) return;
      const asc = (rows ?? []).slice().reverse();
      setMessages((prev) => [...asc, ...prev]);
      setHasMore(asc.length >= PAGE);
      // 保持视口锚点：新页插在顶部，把滚动条往下推回原内容处。
      requestAnimationFrame(() => {
        const now = scrollRef.current;
        if (!now) return;
        now.scrollTop = Math.max(0, now.scrollHeight - prevHeight);
      });
    } catch {
      // 失败静默，滚动条仍在顶部可再触发。
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
      previous = row.message;
      return entry;
    });
  }, [messages, selected, selfUser]);
  const peer = selected ? peerUser(selected) : null;

  if (!open) return null;

  return (
    <Modal onClose={onClose} width={1120} labelledBy="weq-guild-direct-title">
      <div className="weq-guild-direct">
        <header className="weq-guild-direct-head">
          <span className="weq-guild-direct-title">
            <span className="weq-guild-direct-title-icon" aria-hidden="true">
              <Hash size={16} strokeWidth={2} />
            </span>
            <strong id="weq-guild-direct-title">频道私聊</strong>
          </span>
          <button type="button" className="weq-compose-x" onClick={onClose} title="关闭">
            <X size={17} />
          </button>
        </header>

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
                              <span
                                className="weq-guild-direct-item-guild"
                                title={session.guildName}
                              >
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
                </div>

                <div className="weq-guild-direct-topbar" aria-live="polite">
                  {olderLoading ? (
                    <span>加载更早消息…</span>
                  ) : hasMore ? (
                    <span>继续向上滚动可加载更早的本地消息</span>
                  ) : rows.length > 0 ? (
                    <span>已是最早的本地消息</span>
                  ) : null}
                </div>

                <ForwardKindContext.Provider value="c2c">
                  <ConvContext.Provider value="">
                    <ReplyJumpContext.Provider value={noop}>
                      <div
                        className={cn('message-scroll', 'weq-guild-direct-msgs')}
                        ref={scrollRef}
                        onScroll={handleMsgScroll}
                      >
                        {latestLoading ? (
                          <div className="weq-guild-direct-empty">加载消息…</div>
                        ) : rows.length === 0 ? (
                          <div className="weq-guild-direct-empty">
                            <Inbox size={26} />
                            <span>该会话没有本地消息</span>
                          </div>
                        ) : (
                          rows.map(({ row, previous }) => (
                            <div key={row.message.id} className="weq-guild-direct-msg">
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
                                renderers={renderers}
                                onContextMenu={noop}
                                onLongPress={noop}
                              />
                            </div>
                          ))
                        )}
                      </div>
                    </ReplyJumpContext.Provider>
                  </ConvContext.Provider>
                </ForwardKindContext.Provider>
              </>
            )}
          </section>
        </div>
      </div>
    </Modal>
  );
}
