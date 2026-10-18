/** Chat-record modal: left = matched conversations, right = their matching messages. */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { CalendarDays, Download, Search, X } from 'lucide-react';
import { ConversationCalendar } from './ConversationCalendar';
import { TimeRangePicker } from '../../views/export/TimeRangePicker';
import { beijingDay, daySeconds } from '../../lib/messageCalendar';
import { Modal } from '../Dialog';
import { SearchListSkeleton } from './SearchSkeleton';
import { c2cAvatarSrc, groupAvatarSrc, highlightText } from './SearchResultCard';
import type { ChatRecordSearchHit, ConversationRecordHit, MoreSearchResult } from './types';
import { client } from '../../trpc/client';
import { preflightExportEstimate } from '../../views/export/preflight';
import { useAppDialog } from '../../lib/dialogUtils';
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
  /** The same message renderers the chat pane uses (qqMessageRenderer etc.). */
  renderers?: MessageRenderer[];
}): ReactElement {
  const dialog = useAppDialog();
  const [keyword, setKeyword] = useState(initialKeyword);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [rangeCalendarOpen, setRangeCalendarOpen] = useState(false);
  const [startDay, setStartDay] = useState('');
  const [endDay, setEndDay] = useState('');
  const [sender, setSender] = useState('');
  const [ownUin, setOwnUin] = useState('');
  const [category, setCategory] = useState<
    'text' | 'image' | 'video' | 'voice' | 'file' | 'emoji' | 'system' | 'other' | ''
  >('');
  const [exportFormat, setExportFormat] = useState<
    'json' | 'jsonl' | 'txt' | 'csv' | 'xlsx' | 'html'
  >('jsonl');
  const [exportBusy, setExportBusy] = useState(false);
  const [includeMedia, setIncludeMedia] = useState(false);
  const [msgError, setMsgError] = useState('');
  const [browseHasMore, setBrowseHasMore] = useState(false);
  const browseCursor = useRef<{ time: number; rowId: string } | null>(null);
  const filter = useMemo(
    () => ({
      sender: sender.trim() || undefined,
      keyword: keyword.trim() || undefined,
      category: category || undefined,
      start: startDay ? Math.floor(Date.parse(`${startDay}T00:00:00+08:00`) / 1000) : undefined,
      end: endDay ? Math.floor(Date.parse(`${endDay}T23:59:59+08:00`) / 1000) : undefined,
    }),
    [sender, keyword, category, startDay, endDay],
  );
  useEffect(() => {
    let active = true;
    if (fixed)
      void client.account.getSelfProfile
        .query()
        .then((p) => {
          if (active && p) setOwnUin(p.uin);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [fixed]);
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
    if ((!trimmed && !fixed) || !selected) {
      setMessages([]);
      setMsgTotal(0);
      setMsgLoading(false);
      setBrowseHasMore(false);
      setMsgError('');
      return undefined;
    }
    const run = ++msgRunRef.current;
    setMsgLoading(true);
    setMsgError('');
    browseCursor.current = null;
    const request = fixed
      ? client.account.browseConversation.query({
          kind: selected.source === 'group' ? 'group' : 'c2c',
          conv: selected.targetUid,
          filter,
          limit: 30,
        })
      : client.account.searchConversationRecords.query({
          source: selected.source,
          conv: selected.targetUid,
          keyword: trimmed,
          offset: 0,
          limit: 30,
        });
    void request
      .then((result) => {
        if (run !== msgRunRef.current) return;
        const r = result as { items: ConversationRecordHit[]; total: number };
        setMessages(r.items);
        if (fixed) {
          const page = result as {
            items: ConversationRecordHit[];
            cursor: { time: number; rowId: string } | null;
            hasMore: boolean;
          };
          browseCursor.current = page.cursor;
          setBrowseHasMore(page.hasMore);
          setMsgTotal(page.items.length);
        } else setMsgTotal(r.total);
        // 拼音输入会产生大量无结果的中间态，不弹 Toast，界面上的空态提示已足够。
      })
      .catch((err) => {
        if (run === msgRunRef.current) {
          setMessages([]);
          setBrowseHasMore(false);
          setMsgError(String(err));
        }
      })
      .finally(() => {
        if (run === msgRunRef.current) setMsgLoading(false);
      });
    return () => {
      if (run === msgRunRef.current) msgRunRef.current++;
    };
  }, [selected, keyword, fixed, filter]);

  const loadMoreMessages = useCallback(() => {
    const trimmed = keyword.trim();
    if ((!trimmed && !fixed) || !selected || msgLoadingMore || msgLoading) return;
    const run = msgRunRef.current;
    setMsgLoadingMore(true);
    const request = fixed
      ? client.account.browseConversation.query({
          kind: selected.source === 'group' ? 'group' : 'c2c',
          conv: selected.targetUid,
          filter,
          cursor: browseCursor.current ?? undefined,
          limit: 30,
        })
      : client.account.searchConversationRecords.query({
          source: selected.source,
          conv: selected.targetUid,
          keyword: trimmed,
          offset: messages.length,
          limit: 30,
        });
    void request
      .then((result) => {
        if (run !== msgRunRef.current) return;
        const r = result as { items: ConversationRecordHit[]; total: number };
        setMessages((prev) => [...prev, ...r.items]);
        if (fixed) {
          const page = result as {
            cursor: { time: number; rowId: string } | null;
            hasMore: boolean;
          };
          browseCursor.current = page.cursor;
          setBrowseHasMore(page.hasMore);
          setMsgTotal(messages.length + r.items.length);
        } else setMsgTotal(r.total);
      })
      .catch((err) => {
        if (run === msgRunRef.current) setMsgError(String(err));
      })
      .finally(() => setMsgLoadingMore(false));
  }, [keyword, selected, messages.length, msgLoadingMore, msgLoading, fixed, filter]);

  // Infinite scroll for the message list.
  const onMsgScroll = useCallback(() => {
    const el = msgScrollRef.current;
    if (
      !el ||
      msgLoading ||
      msgLoadingMore ||
      (fixed ? !browseHasMore : messages.length >= msgTotal)
    )
      return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
      void loadMoreMessages();
    }
  }, [
    loadMoreMessages,
    msgLoading,
    msgLoadingMore,
    messages.length,
    msgTotal,
    fixed,
    browseHasMore,
  ]);

  const jumpTo = useCallback(
    (msg: ConversationRecordHit) => {
      if (!selected) return;
      if (!/^\d+$/.test(msg.msgSeq) || BigInt(msg.msgSeq) <= 0n) {
        setMsgError('该消息没有可定位的原生序号。');
        return;
      }
      // 跳转进会话时自动关闭聊天记录模态。
      onJumpMessage({ source: selected.source, targetUid: selected.targetUid, msgSeq: msg.msgSeq });
      onClose();
    },
    [onJumpMessage, onClose, selected],
  );

  const isGroup = selected?.source === 'group';
  const convKey = isGroup && selected ? selected.targetUid : '';

  return (
    <Modal
      presentation="panel"
      onClose={() => {
        if (rangeCalendarOpen) setRangeCalendarOpen(false);
        else if (calendarOpen) setCalendarOpen(false);
        else onClose();
      }}
      width={960}
      labelledBy="weq-chatrecords-title"
    >
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
        {calendarOpen && selected ? (
          <ConversationCalendar
            kind={selected.source === 'group' ? 'group' : 'c2c'}
            conv={selected.targetUid}
            onClose={() => setCalendarOpen(false)}
            onJump={(seq) => {
              onJumpMessage({
                source: selected.source,
                targetUid: selected.targetUid,
                msgSeq: seq,
              });
              onClose();
            }}
          />
        ) : null}
        <input
          className="weq-search-more-input"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={fixed ? `搜索「${initialHit.name}」的聊天记录` : '搜索聊天记录'}
          autoFocus
        />
        <div className="weq-record-calendar-actions">
          {fixed ? (
            <button type="button" onClick={() => setRangeCalendarOpen(true)}>
              <CalendarDays size={15} />
              {startDay || endDay ? `${startDay || '不限'} 至 ${endDay || '不限'}` : '时间范围'}
            </button>
          ) : null}
          <button
            type="button"
            title="按日期定位"
            disabled={!selected}
            onClick={() => setCalendarOpen(true)}
          >
            <CalendarDays size={15} />
            跳转日期
          </button>
        </div>
        {rangeCalendarOpen && selected ? (
          <Modal
            presentation="popover"
            onClose={() => setRangeCalendarOpen(false)}
            width={440}
            labelledBy="weq-record-range-title"
          >
            <div className="weq-message-calendar">
              <header>
                <h3 id="weq-record-range-title">时间范围</h3>
                <button
                  type="button"
                  className="weq-dialog-x"
                  aria-label="关闭时间范围"
                  onClick={() => setRangeCalendarOpen(false)}
                >
                  <X size={16} />
                </button>
              </header>
              <TimeRangePicker
                value={{
                  preset: startDay || endDay ? 'custom' : 'all',
                  start: startDay ? daySeconds(startDay) : null,
                  end: endDay ? daySeconds(endDay) + 86399 : null,
                }}
                calendarTargets={[
                  { kind: selected.source === 'group' ? 'group' : 'c2c', conv: selected.targetUid },
                ]}
                onChange={(range) => {
                  setStartDay(range.start == null ? '' : beijingDay(new Date(range.start * 1000)));
                  setEndDay(range.end == null ? '' : beijingDay(new Date(range.end * 1000)));
                }}
              />
            </div>
          </Modal>
        ) : null}
        {fixed ? (
          <div className="weq-record-filters">
            <label>
              发送者
              <input
                placeholder="QQ 号或 UID"
                list="weq-record-senders"
                value={sender}
                onChange={(e) => setSender(e.target.value)}
              />
              <datalist id="weq-record-senders">
                {[
                  ...new Map(
                    messages.map((m) => [
                      m.senderUin && m.senderUin !== '0' ? m.senderUin : m.senderUid,
                      m.senderName,
                    ]),
                  ).entries(),
                ]
                  .filter(([id]) => !!id)
                  .map(([id, name]) => (
                    <option key={id} value={id} label={name} />
                  ))}
              </datalist>
            </label>
            <label className="weq-record-self">
              <input
                type="checkbox"
                checked={!!ownUin && sender === ownUin}
                disabled={!ownUin}
                onChange={(e) => setSender(e.target.checked ? ownUin : '')}
              />
              我
            </label>
            <select
              aria-label="消息类型"
              value={category}
              onChange={(e) => setCategory(e.target.value as typeof category)}
            >
              <option value="">全部类型</option>
              {Object.entries({
                text: '文字',
                image: '图片',
                video: '视频',
                voice: '语音',
                file: '文件',
                emoji: '表情',
                system: '系统',
                other: '其他',
              }).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select
              aria-label="导出格式"
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value as typeof exportFormat)}
            >
              {['json', 'jsonl', 'txt', 'csv', 'xlsx', 'html'].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
            <label className="weq-record-self">
              <input
                type="checkbox"
                checked={includeMedia || exportFormat === 'html'}
                disabled={exportFormat === 'html'}
                onChange={(e) => setIncludeMedia(e.target.checked)}
              />
              附件
            </label>
            <button
              className="weq-dialog-x"
              aria-label="导出筛选结果"
              title="导出筛选结果"
              disabled={exportBusy || msgLoading || !!msgError || !selected}
              onClick={() => {
                if (!selected) return;
                setExportBusy(true);
                setMsgError('');
                void (async () => {
                  const range = { start: filter.start ?? null, end: filter.end ?? null };
                  if (
                    !(await preflightExportEstimate(
                      dialog,
                      [
                        {
                          kind: selected.source === 'group' ? 'group' : 'c2c',
                          id: selected.targetUid,
                          name: selected.name,
                        },
                      ],
                      {
                        range,
                        formats: [exportFormat],
                        exportMedia: includeMedia || exportFormat === 'html',
                        filter,
                      },
                    ))
                  )
                    return;
                  await client.account.startExport.mutate({
                    kind: selected.source === 'group' ? 'group' : 'c2c',
                    conv: selected.targetUid,
                    name: selected.name,
                    format: exportFormat,
                    total: 0,
                    media: {
                      exportMedia: includeMedia || exportFormat === 'html',
                      completeMessages: false,
                      completeMedia: false,
                      downloadVideo: false,
                      downloadFile: false,
                      downloadPtt: false,
                      transcribeVoice: false,
                    },
                    filter: {
                      sender: filter.sender,
                      keyword: filter.keyword,
                      category: filter.category,
                    },
                    range,
                  });
                  onClose();
                })()
                  .catch((e) => setMsgError(String(e)))
                  .finally(() => setExportBusy(false));
              }}
            >
              <Download size={16} />
            </button>
          </div>
        ) : null}
        {msgError ? (
          <p role="alert" className="weq-record-error">
            {msgError}
          </p>
        ) : null}
        <div className={`weq-chatrecords-body${fixed ? ' is-fixed' : ''}`}>
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
                      {fixed && browseHasMore ? '本批尚无匹配消息' : '没有找到相关消息'}
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
                      {(fixed ? !browseHasMore : messages.length >= msgTotal) &&
                      messages.length > 0 ? (
                        <div className="weq-search-more-end">没有更多了</div>
                      ) : null}
                    </>
                  )}
                  {fixed && browseHasMore ? (
                    <button
                      className="weq-action-soft"
                      disabled={msgLoading || msgLoadingMore}
                      onClick={() => void loadMoreMessages()}
                    >
                      {msgLoadingMore ? '加载中...' : '继续加载'}
                    </button>
                  ) : null}
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
  if (!Number.isFinite(d.getTime())) return '时间未核验';
  return `${new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(d)} +08`;
}
