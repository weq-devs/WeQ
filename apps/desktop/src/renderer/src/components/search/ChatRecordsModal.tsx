/** Chat-record modal: left = matched conversations, right = their matching messages. */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Search, X } from 'lucide-react';
import { Modal } from '../Dialog';
import { SearchListSkeleton } from './SearchSkeleton';
import { c2cAvatarSrc, groupAvatarSrc, highlightText } from './SearchResultCard';
import type { ChatRecordSearchHit, ConversationRecordHit, MoreSearchResult } from './types';
import { client } from '../../trpc/client';
import { ConvContext, ForwardKindContext, ReplyJumpContext } from '../QqMessageContent';
import { MessageBubble } from '../../im-template/template/messageBubble';
import { displayUserName } from '../../im-template/template/user';
import type { MessageRenderer } from '../../im-template/template/messageRenderers';
import type { Conversation, Message, User } from '../../im-template/template/types';

const noop = (): void => {};

export function ChatRecordsModal({
  initialHit,
  initialKeyword,
  fixed = false,
  onClose,
  onJumpMessage,
  pushToast,
  renderers,
}: {
  initialHit: ChatRecordSearchHit;
  initialKeyword: string;
  /**
   * 固定在 `initialHit` 这个会话内搜索（聊天顶栏搜索按钮进入）：隐藏左侧会话
   * 列表，结果列表占满整个宽度，跳转目标始终是当前会话。
   */
  fixed?: boolean;
  onClose: () => void;
  /** Jump to a conversation + seq (like a file hit). */
  onJumpMessage: (hit: { source: 'buddy' | 'group'; targetUid: string; msgSeq: string }) => void;
  pushToast: (t: { tone: 'info'; title: string; detail?: string }) => void;
  /** The same message renderers the chat pane uses (qqMessageRenderer etc.). */
  renderers?: MessageRenderer[];
}): ReactElement {
  const [keyword, setKeyword] = useState(initialKeyword);
  const [conversations, setConversations] = useState<ChatRecordSearchHit[]>([]);
  const [convLoading, setConvLoading] = useState(false);
  // fixed 模式下不请求会话排名，selected 恒为当前会话的 hit。
  const [selected, setSelected] = useState<ChatRecordSearchHit | null>(initialHit);
  const [messages, setMessages] = useState<ConversationRecordHit[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [msgLoadingMore, setMsgLoadingMore] = useState(false);
  const [msgTotal, setMsgTotal] = useState(0);
  const convRunRef = useRef(0);
  const msgRunRef = useRef(0);
  const msgScrollRef = useRef<HTMLDivElement | null>(null);

  // A minimal conversation view for the selected hit — enough for MessageBubble.
  const conversation = useMemo(() => (selected ? conversationFromHit(selected) : null), [selected]);

  // Fetch the conversation ranking for the current keyword.
  useEffect(() => {
    const trimmed = keyword.trim();
    if (!trimmed || fixed) return undefined;
    const run = ++convRunRef.current;
    setConvLoading(true);
    const timer = window.setTimeout(() => {
      void client.account.searchMore
        .query({ category: 'chatRecord', keyword: trimmed, offset: 0, limit: 100 })
        .then((result) => {
          if (run !== convRunRef.current) return;
          const items = ((result as MoreSearchResult).items ?? []) as ChatRecordSearchHit[];
          setConversations(items);
          // Keep the selection valid: prefer the previously selected conversation.
          setSelected((prev) =>
            prev && items.some((c) => c.partition === prev.partition && c.source === prev.source)
              ? prev
              : (items[0] ?? null),
          );
        })
        .catch((err) => console.error('[chat-records] conversation list failed', err))
        .finally(() => {
          if (run === convRunRef.current) setConvLoading(false);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [keyword, fixed]);

  // Fetch messages for the selected conversation.
  useEffect(() => {
    const trimmed = keyword.trim();
    if (!trimmed || !selected) {
      setMessages([]);
      setMsgTotal(0);
      return undefined;
    }
    const run = ++msgRunRef.current;
    setMsgLoading(true);
    void client.account.searchConversationRecords
      .query({
        source: selected.source,
        conv: selected.targetUid,
        keyword: trimmed,
        offset: 0,
        limit: 30,
      })
      .then((result) => {
        if (run !== msgRunRef.current) return;
        const r = result as { items: ConversationRecordHit[]; total: number };
        setMessages(r.items);
        setMsgTotal(r.total);
        if (r.items.length === 0) {
          pushToast({
            tone: 'info',
            title: '没有找到相关消息',
            detail: fixed
              ? '试试更换关键词后再搜索。'
              : '试试更换关键词，或切换左侧会话范围后再搜索。',
          });
        }
      })
      .catch((err) => console.error('[chat-records] messages failed', err))
      .finally(() => {
        if (run === msgRunRef.current) setMsgLoading(false);
      });
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
    };
  }, [selected, keyword, pushToast, fixed]);

  const loadMoreMessages = useCallback(() => {
    const trimmed = keyword.trim();
    if (!trimmed || !selected || msgLoadingMore) return;
    setMsgLoadingMore(true);
    void client.account.searchConversationRecords
      .query({
        source: selected.source,
        conv: selected.targetUid,
        keyword: trimmed,
        offset: messages.length,
        limit: 30,
      })
      .then((result) => {
        const r = result as { items: ConversationRecordHit[]; total: number };
        setMessages((prev) => [...prev, ...r.items]);
        setMsgTotal(r.total);
      })
      .catch((err) => console.error('[chat-records] load more failed', err))
      .finally(() => setMsgLoadingMore(false));
  }, [keyword, selected, messages.length, msgLoadingMore]);

  // Infinite scroll for the message list.
  const onMsgScroll = useCallback(() => {
    const el = msgScrollRef.current;
    if (!el || msgLoading || msgLoadingMore || messages.length >= msgTotal) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
      void loadMoreMessages();
    }
  }, [loadMoreMessages, msgLoading, msgLoadingMore, messages.length, msgTotal]);

  const jumpTo = useCallback(
    (msg: ConversationRecordHit) => {
      if (!selected) return;
      // 跳转进会话时自动关闭聊天记录模态。
      onJumpMessage({ source: selected.source, targetUid: selected.targetUid, msgSeq: msg.msgSeq });
      onClose();
    },
    [onJumpMessage, onClose, selected],
  );

  const isGroup = selected?.source === 'group';
  const convKey = isGroup && selected ? selected.targetUid : '';

  return (
    <Modal onClose={onClose} width={960} labelledBy="weq-chatrecords-title">
      <div className="weq-chatrecords">
        <div className="weq-chatrecords-head">
          <div className="weq-chatrecords-title-wrap">
            <h3 id="weq-chatrecords-title" className="weq-search-more-title">
              聊天记录
            </h3>
            {fixed ? (
              <span className="weq-chatrecords-fixed-conv" title={initialHit.name}>
                <Search size={13} aria-hidden />
                {initialHit.name}
              </span>
            ) : null}
          </div>
          <button type="button" className="weq-dialog-x" onClick={onClose} aria-label="关闭">
            <X size={16} strokeWidth={1.9} aria-hidden />
          </button>
        </div>
        <input
          className="weq-search-more-input"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={fixed ? `搜索「${initialHit.name}」的聊天记录` : '搜索聊天记录'}
          autoFocus
        />
        <div className={`weq-chatrecords-body${fixed ? ' fixed' : ''}`}>
          {fixed ? null : (
            <div className="weq-chatrecords-convs">
              {convLoading ? (
                <SearchListSkeleton rows={4} />
              ) : conversations.length === 0 ? (
                <div className="weq-search-empty">无结果</div>
              ) : (
                conversations.map((conv) => (
                  <button
                    type="button"
                    key={`${conv.source}:${conv.partition}`}
                    className={`weq-chatrecords-conv ${selected?.partition === conv.partition && selected.source === conv.source ? 'active' : ''}`}
                    onClick={() => setSelected(conv)}
                  >
                    <span className="weq-chatrecords-conv-name">{conv.name}</span>
                    <span className="weq-chatrecords-conv-meta">
                      搜索到<strong>{conv.count}</strong>条包含{keyword.trim()}的消息
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
          <div className="weq-chatrecords-msgs" ref={msgScrollRef} onScroll={onMsgScroll}>
            <ForwardKindContext.Provider value={isGroup ? 'group' : 'c2c'}>
              <ConvContext.Provider value={convKey}>
                <ReplyJumpContext.Provider value={noop}>
                  {msgLoading ? (
                    <SearchListSkeleton rows={4} />
                  ) : messages.length === 0 ? (
                    <div className="weq-search-empty">
                      {fixed && !keyword.trim()
                        ? '输入关键词，搜索当前会话的聊天记录'
                        : '没有找到相关消息'}
                    </div>
                  ) : (
                    <>
                      {messages.map((msg) => {
                        // 能取到原消息 40800 正文的，渲染真实气泡；找不到的回退纯文本行。
                        if (msg.elements?.length && conversation) {
                          const sender = senderUserFromHit(msg);
                          const message = messageFromHit(msg, conversation);
                          return (
                            <div
                              key={msg.msgId}
                              className="weq-chatrecords-msg is-bubble"
                              role="button"
                              tabIndex={0}
                              onClick={() => jumpTo(msg)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault();
                                  jumpTo(msg);
                                }
                              }}
                              title="点击跳转到该消息"
                            >
                              <MessageBubble
                                message={message}
                                conversation={conversation}
                                sender={sender}
                                mine={false}
                                senderName={displayUserName(sender)}
                                senderAvatarUrl={sender.avatarUrl}
                                senderSeed={sender.identityValue}
                                senderKind={sender.kind}
                                showSenderName
                                active={false}
                                renderers={renderers}
                                onContextMenu={noop}
                                onLongPress={noop}
                              />
                            </div>
                          );
                        }
                        return (
                          <button
                            type="button"
                            key={msg.msgId}
                            className="weq-chatrecords-msg"
                            onClick={() => jumpTo(msg)}
                          >
                            <img
                              className="weq-chatrecords-msg-avatar"
                              src={
                                msg.senderUin && msg.senderUin !== '0'
                                  ? (c2cAvatarSrc(msg.senderUin) ?? undefined)
                                  : isGroup
                                    ? (groupAvatarSrc(selected?.targetUid ?? '') ?? undefined)
                                    : (c2cAvatarSrc(selected?.targetUin ?? '') ?? undefined)
                              }
                              alt=""
                              loading="lazy"
                            />
                            <span className="weq-chatrecords-msg-text">
                              <span className="weq-chatrecords-msg-meta">
                                {msg.senderName ? `${msg.senderName} · ` : ''}
                                {formatTime(msg.sendTime)} · seq {msg.msgSeq}
                              </span>
                              <span className="weq-chatrecords-msg-content">
                                {highlightText(msg.content, keyword.trim())}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                      {msgLoadingMore ? <SearchListSkeleton rows={2} /> : null}
                      {messages.length >= msgTotal && messages.length > 0 ? (
                        <div className="weq-search-more-end">没有更多了</div>
                      ) : null}
                    </>
                  )}
                </ReplyJumpContext.Provider>
              </ConvContext.Provider>
            </ForwardKindContext.Provider>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Build a sender User from the search hit's resolved identity. */
function senderUserFromHit(hit: ConversationRecordHit): User {
  const uin = hit.senderUin && hit.senderUin !== '0' ? hit.senderUin : '';
  return {
    id: hit.senderUid || `sender:${uin}`,
    identityLabel: uin ? 'QQ' : 'UID',
    identityValue: uin || hit.senderUid,
    username: hit.senderUid || uin,
    displayName: hit.senderName || uin || hit.senderUid || '成员',
    avatarUrl: uin ? c2cAvatarSrc(uin) : null,
    kind: 'human',
  };
}

/** A minimal Conversation view for the target hit — enough for MessageBubble. */
function conversationFromHit(hit: ChatRecordSearchHit): Conversation {
  if (hit.source === 'group') {
    const code = hit.targetUid;
    return {
      type: 'group',
      id: `group:${code}`,
      updatedAt: '',
      unreadCount: 0,
      lastMessage: null,
      otherUser: null,
      group: {
        id: code,
        name: hit.name || code,
        identityLabel: '群号',
        identityValue: code,
        avatarUrl: groupAvatarSrc(code),
        announcement: null,
        memberCount: 0,
        role: 'member',
      },
      members: [],
    } as unknown as Conversation;
  }
  const uin = hit.targetUin && hit.targetUin !== '0' ? hit.targetUin : '';
  const otherUser: User = {
    id: hit.targetUid || `peer:${uin}`,
    identityLabel: uin ? 'QQ' : 'UID',
    identityValue: uin || hit.targetUid,
    username: hit.targetUid || uin,
    displayName: hit.name || uin || hit.targetUid || '对方',
    avatarUrl: uin ? c2cAvatarSrc(uin) : null,
  };
  return {
    type: 'direct',
    id: `c2c:${hit.targetUid}`,
    updatedAt: '',
    unreadCount: 0,
    lastMessage: null,
    otherUser,
    group: null,
    members: [],
  } as unknown as Conversation;
}

/** Build the template Message the bubble renders from a search hit. */
function messageFromHit(hit: ConversationRecordHit, conversation: Conversation): Message {
  const sender = senderUserFromHit(hit);
  return {
    id: hit.msgId,
    conversationId: conversation.id,
    senderId: sender.id,
    sender,
    body: hit.content,
    createdAt: toIsoTime(hit.sendTime),
    qqElements: hit.elements ?? [],
    ...(hit.setEmojiList ? { setEmojiList: hit.setEmojiList } : {}),
    ...(hit.decoration ? { decoration: hit.decoration } : {}),
    msgId: hit.msgId,
    msgSeq: hit.msgSeq,
  } as Message & {
    qqElements: unknown[];
    setEmojiList?: unknown;
    msgId: string;
    msgSeq: string;
    decoration?: unknown;
  };
}

function toIsoTime(seconds: string): string {
  const secs = Number(seconds);
  if (!Number.isFinite(secs) || secs <= 0) return new Date(0).toISOString();
  return new Date(secs * 1000).toISOString();
}

function formatTime(sendTimeSeconds: string): string {
  const secs = Number(sendTimeSeconds);
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
