import { FormSelect, FormSuggestions } from '../FormSelect';
import { EmptyState } from '../EmptyState';
import { eventTimeFormatter } from '@weq/time';
/** 会话消息搜索：全局搜索内嵌展示，会话顶栏入口使用单会话浮窗。 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { CalendarDays, Download, LocateFixed, Play, X, SearchX } from 'lucide-react';
import { ChatRecordsHeader } from './ChatRecordsHeader';
import { ConversationCalendar } from './ConversationCalendar';
import { TimeRangePicker } from '../../views/export/TimeRangePicker';
import { beijingDay, daySeconds } from '../../lib/messageCalendar';
import { Modal } from '../Dialog';
import { LoadingIndicator } from '../LoadingIndicator';
import { SearchListSkeleton } from './SearchSkeleton';
import { c2cAvatarSrc, groupAvatarSrc, highlightText } from './SearchResultCard.shared';
import type { ChatRecordSearchHit, ConversationRecordHit } from './types';
import { client } from '../../trpc/client';
import { preflightExportEstimate } from '../../views/export/preflight';
import { useExportReportDialog } from '../../views/export/ExportReportControl.shared';
import { useAppDialog } from '../../lib/dialogUtils';
import type { QQWriteBinding } from '../../hooks/useQQWriteSession';
import {
  ConvContext,
  ForwardKindContext,
  ReplyJumpContext,
  type ReplyJumpTarget,
} from '../../state/messageContext';
import { closeForwardWindows } from '../../state/forwardWindow';
import { ChatMediaGallery } from '../ChatMediaGallery';
import { useChatMediaItems, useChatMediaOpen } from '../ChatMediaGallery.shared';
import { ShimmerImage } from '../ShimmerImage';
import { MessageBubble } from '../../im-template/template/messageBubble';
import { displayUserName } from '../../im-template/template/user';
import type { MessageRenderer } from '../../im-template/template/messageRenderers';
import type { Conversation, GroupMember, Message, User } from '../../im-template/template/types';
import '../../styles/chat-records.css';
import { conversationExportSelection } from '../../lib/conversationActions';
import { useRequestContentExport } from '../../state/contentSelection.shared';
import { createReplyPreviewIndex } from '../../lib/replyPreview';
import { enrichReplyElements } from '../../views/workspace/messageProjection';
import type { RenderElement } from '../QqMessageContent.shared';
import type { MessageCategory } from '@weq/service';

const noop = (): void => {};
type BrowseCursor = { time: number; rowId: string };
const categoryLabels: Record<MessageCategory, string> = {
  text: '文字',
  image: '图片',
  video: '视频',
  voice: '语音',
  file: '文件',
  link: '链接',
  emoji: '表情',
  system: '系统',
  other: '其他',
};
const sharedCategories = ['image', 'video', 'file'] as const;

export function ChatRecordsModal({
  initialHit,
  initialKeyword,
  fixed = false,
  sharedMedia = false,
  accountBinding,
  suspended = false,
  onClose,
  onSuspend,
  onJumpMessage,
  renderers,
  user,
  groupMembers,
  resolveGroupMembers,
  localSource,
  embeddedKeyword,
}: {
  /** 非 QQ 数据源复用同一搜索页面；不向原生记录接口提交本地身份。 */
  localSource?: {
    conversation: Conversation;
    messages: Message[];
    user: User;
    onJump: (messageId: string) => void;
  };
  /** 全局搜索内嵌明细：共用顶栏关键词，不再查询或显示会话排名。 */
  embeddedKeyword?: string;
  initialHit: ChatRecordSearchHit;
  initialKeyword: string;
  /**
   * 固定在 `initialHit` 这个会话内搜索（聊天顶栏搜索按钮进入）：隐藏左侧会话
   * 列表，结果列表占满整个宽度，跳转目标始终是当前会话。
   */
  fixed?: boolean;
  sharedMedia?: boolean;
  accountBinding?: QQWriteBinding;
  suspended?: boolean;
  onClose: () => void;
  /** 跳原消息时关闭浮层，保留这次搜索会话。 */
  onSuspend?: () => void;
  /** Jump to a conversation + seq (like a file hit). */
  onJumpMessage: (hit: {
    source: 'buddy' | 'group';
    targetUid: string;
    msgSeq: string;
    msgId?: string;
  }) => void;
  /** The same message renderers the chat pane uses (qqMessageRenderer etc.). */
  renderers?: MessageRenderer[];
  user?: User;
  groupMembers?: (groupCode: string) => ReadonlyMap<string, GroupMember>;
  resolveGroupMembers?: (groupCode: string, uids: string[]) => void;
}): ReactElement | null {
  const dialog = useAppDialog();
  const requestExport = useRequestContentExport();
  const [localKeyword, setKeyword] = useState(initialKeyword);
  const embedded = embeddedKeyword !== undefined;
  const keyword = embeddedKeyword ?? localKeyword;
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [rangeCalendarOpen, setRangeCalendarOpen] = useState(false);
  const [startDay, setStartDay] = useState('');
  const [endDay, setEndDay] = useState('');
  const [sender, setSender] = useState('');
  const [senderMatches, setSenderMatches] = useState<{
    query: string;
    options: { value: string; label: string }[];
  }>();
  const senderQuery = sender.trim();
  const senderIdentity =
    !senderQuery || localSource || /^(?:[1-9]\d*|u_[\w-]+)$/.test(senderQuery)
      ? senderQuery || undefined
      : undefined;
  const expectedAccountUin = accountBinding?.expectedAccountUin;
  const expectedAccountConfigId = accountBinding?.expectedAccountConfigId;
  const [ownUin, setOwnUin] = useState('');
  const [category, setCategory] = useState<MessageCategory | ''>(sharedMedia ? 'image' : '');
  const [exportFormat, setExportFormat] = useState<
    'json' | 'jsonl' | 'txt' | 'csv' | 'xlsx' | 'html'
  >('jsonl');
  const [exportBusy, setExportBusy] = useState(false);
  const [includeMedia, setIncludeMedia] = useState(false);
  const report = useExportReportDialog();
  const [msgError, setMsgError] = useState('');
  const [browseHasMore, setBrowseHasMore] = useState(false);
  const browseCursor = useRef<BrowseCursor | null>(null);
  const [scannedDay, setScannedDay] = useState('');
  const localMatches = useRef<ConversationRecordHit[]>([]);
  const filter = useMemo(
    () => ({
      sender: senderIdentity,
      keyword: keyword.trim() || undefined,
      category: category || undefined,
      start: startDay ? Math.floor(Date.parse(`${startDay}T00:00:00+08:00`) / 1000) : undefined,
      end: endDay ? Math.floor(Date.parse(`${endDay}T23:59:59+08:00`) / 1000) : undefined,
    }),
    [senderIdentity, keyword, category, startDay, endDay],
  );
  useEffect(() => {
    let active = true;
    if (localSource) {
      setOwnUin(localSource.user.identityValue);
      return () => {};
    }
    if (user) {
      setOwnUin(user.identityValue);
      return () => {};
    }
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
  }, [fixed, localSource, user]);
  const selected = initialHit;
  const [messages, setMessages] = useState<ConversationRecordHit[]>([]);
  const [msgLoading, setMsgLoading] = useState(
    () => !localSource && (fixed || Boolean(filter.keyword)),
  );
  const [msgLoadingMore, setMsgLoadingMore] = useState(false);
  const [msgTotal, setMsgTotal] = useState(0);
  const [msgLimited, setMsgLimited] = useState(false);
  const msgRunRef = useRef<{ controller: AbortController; loadingMore: boolean } | null>(null);
  const msgScrollRef = useRef<HTMLDivElement | null>(null);
  const savedScrollTop = useRef<number | null>(null);
  const bindMsgScroll = useCallback((element: HTMLDivElement | null) => {
    msgScrollRef.current = element;
    if (!element || savedScrollTop.current === null) return;
    element.scrollTop = savedScrollTop.current;
    savedScrollTop.current = null;
  }, []);
  const isGroup = selected.source === 'group';
  const members = useMemo(
    () => (isGroup && !localSource ? groupMembers?.(selected.targetUid) : undefined),
    [isGroup, localSource, groupMembers, selected.targetUid],
  );
  useEffect(() => {
    if (!fixed || !isGroup || localSource || suspended || !senderQuery || senderIdentity) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void client.account.searchGroupMembers
        .query(
          {
            groupCode: selected.targetUid,
            keyword: senderQuery,
            limit: 30,
            expectedAccountUin,
            expectedAccountConfigId,
          },
          { signal: controller.signal },
        )
        .then(({ members }) => {
          if (controller.signal.aborted) return;
          setSenderMatches({
            query: senderQuery,
            options: members.map((member) => ({
              value: member.uin && member.uin !== '0' ? member.uin : member.uid,
              label: [...new Set([member.card, member.nick].filter(Boolean))].join(' · '),
            })),
          });
        })
        .catch(() => undefined);
    }, 170);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    fixed,
    isGroup,
    localSource,
    suspended,
    senderIdentity,
    senderQuery,
    selected.targetUid,
    expectedAccountUin,
    expectedAccountConfigId,
  ]);
  const senderOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const message of messages) {
      const value =
        message.senderUin && message.senderUin !== '0' ? message.senderUin : message.senderUid;
      if (value) options.set(value, message.senderName);
    }
    if (!isGroup && selected.targetUid) options.set(selected.targetUid, selected.name);
    for (const member of members?.values() ?? []) {
      const value = member.uin && member.uin !== '0' ? member.uin : member.id;
      if (!value) continue;
      const label = [
        ...new Set([member.remark, member.card, member.nick, member.displayName].filter(Boolean)),
      ].join(' · ');
      options.set(value, label || options.get(value) || '');
    }
    if (senderMatches?.query === senderQuery)
      for (const { value, label } of senderMatches.options)
        if (value && !options.has(value)) options.set(value, label);
    return [...options].map(([value, label]) => ({ value, label }));
  }, [messages, isGroup, selected.name, selected.targetUid, members, senderMatches, senderQuery]);
  useEffect(() => {
    if (!isGroup || localSource || !resolveGroupMembers) return;
    const uids = new Set<string>();
    for (const row of messages) {
      if (row.senderUid) uids.add(row.senderUid);
      for (const element of (row.elements ?? []) as RenderElement[]) {
        const uid = element?.type === 'reply' ? element.data?.origSenderUid : undefined;
        if (typeof uid === 'string' && uid) uids.add(uid);
      }
    }
    if (uids.size) resolveGroupMembers(selected.targetUid, [...uids]);
  }, [isGroup, localSource, selected.targetUid, messages, resolveGroupMembers]);
  const replyIndex = useMemo(
    () =>
      createReplyPreviewIndex(
        messages
          .filter((row) => row.elements?.length)
          .map((row) => ({ ...row, elements: row.elements! })),
      ),
    [messages],
  );

  // A minimal conversation view for the selected hit — enough for MessageBubble.
  const conversation = useMemo(
    () => localSource?.conversation ?? (selected ? conversationFromHit(selected) : null),
    [selected, localSource],
  );

  const queryMessages = useCallback(
    async (offset: number, signal: AbortSignal) => {
      if (!fixed) {
        return client.account.searchConversationRecords.query(
          {
            source: selected.source,
            conv: selected.targetUid,
            keyword: filter.keyword ?? '',
            offset,
            limit: 30,
          },
          { signal },
        );
      }

      // 空批次也可能扫描过几千条原始消息。按游标接着查，直到有命中或到达范围末尾。
      while (!signal.aborted) {
        const cursor = browseCursor.current;
        const page = await client.account.browseConversation.query(
          {
            kind: selected.source === 'group' ? 'group' : 'c2c',
            conv: selected.targetUid,
            filter,
            expectedAccountUin,
            expectedAccountConfigId,
            cursor: cursor ?? undefined,
            limit: 30,
          },
          { signal },
        );
        if (signal.aborted) return;
        if (
          page.hasMore &&
          (!page.cursor ||
            (page.cursor.time === cursor?.time && page.cursor.rowId === cursor.rowId))
        )
          throw new Error('聊天记录搜索进度未推进');
        browseCursor.current = page.cursor ?? null;
        if (page.cursor && page.cursor.time > 0) {
          setScannedDay(beijingDay(new Date(page.cursor.time * 1000)));
        }
        setBrowseHasMore(page.hasMore);
        if (page.items.length || !page.hasMore)
          return { items: page.items, total: undefined, limited: false };
      }
    },
    [fixed, selected, filter, expectedAccountUin, expectedAccountConfigId],
  );

  // Fetch messages for the selected conversation.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    msgRunRef.current = { controller, loadingMore: false };
    const cancel = () => controller.abort();
    setMsgLoadingMore(false);
    setMsgLimited(false);
    setMsgError('');
    setScannedDay('');
    browseCursor.current = null;
    msgScrollRef.current?.scrollTo(0, 0);
    if (localSource) {
      const keyword = (filter.keyword ?? '').toLocaleLowerCase();
      const rows = localSource.messages
        .filter((message) => {
          const time = new Date(message.createdAt).getTime() / 1000;
          const sender = message.sender;
          return (
            !message.generatedPending &&
            (!keyword || message.body.toLocaleLowerCase().includes(keyword)) &&
            (!filter.sender ||
              [message.senderId, sender?.identityValue, sender?.displayName].includes(
                filter.sender,
              )) &&
            (filter.start == null || time >= filter.start) &&
            (filter.end == null || time <= filter.end)
          );
        })
        .map(
          (message): ConversationRecordHit => ({
            msgId: message.id,
            msgSeq: '',
            senderUid: message.senderId,
            senderUin: message.sender?.identityValue ?? '',
            senderName: message.sender?.displayName ?? '',
            sendTime: String(new Date(message.createdAt).getTime() / 1000),
            content: message.body,
            elements: [{ type: 'text', data: { textContent: message.body } }],
          }),
        );
      localMatches.current = rows;
      setMessages(rows.slice(0, 30));
      setMsgTotal(Math.min(rows.length, 30));
      setMsgLoading(false);
      setBrowseHasMore(rows.length > 30);
      return cancel;
    }
    setMessages([]);
    setMsgTotal(0);
    setBrowseHasMore(false);
    if (!filter.keyword && !fixed) {
      setMsgLoading(false);
      return cancel;
    }
    setMsgLoading(true);
    void queryMessages(0, signal)
      .then((r) => {
        if (signal.aborted || !r) return;
        setMsgLimited(Boolean(r.limited));
        setMessages(r.items);
        setMsgTotal(r.total ?? r.items.length);
      })
      .catch((err) => {
        if (!signal.aborted) setMsgError(String(err));
      })
      .finally(() => {
        if (!signal.aborted) setMsgLoading(false);
      });
    return cancel;
  }, [fixed, filter, localSource, queryMessages]);

  const loadMoreMessages = useCallback(() => {
    if (localSource) {
      const next = localMatches.current.slice(0, messages.length + 30);
      setMessages(next);
      setMsgTotal(next.length);
      setBrowseHasMore(next.length < localMatches.current.length);
      return;
    }
    const run = msgRunRef.current;
    if (!run || run.loadingMore || msgLoading) return;
    const { signal } = run.controller;
    if (signal.aborted) return;
    run.loadingMore = true;
    setMsgLoadingMore(true);
    setMsgError('');
    void queryMessages(messages.length, signal)
      .then((r) => {
        if (signal.aborted || !r) return;
        setMsgLimited(Boolean(r.limited));
        setMessages((prev) => [...prev, ...r.items]);
        setMsgTotal(r.total ?? messages.length + r.items.length);
      })
      .catch((err) => {
        if (!signal.aborted) setMsgError(String(err));
      })
      .finally(() => {
        if (!signal.aborted) setMsgLoadingMore(false);
        run.loadingMore = false;
      });
  }, [messages.length, msgLoading, localSource, queryMessages]);

  // Infinite scroll for the message list.
  const onMsgScroll = useCallback(() => {
    const el = msgScrollRef.current;
    if (
      !el?.clientHeight ||
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

  // 结果不足一屏时没有滚动事件，填满列表或读完为止。
  useEffect(() => {
    const el = msgScrollRef.current;
    if (!fixed || !browseHasMore || msgLoading || msgLoadingMore || msgError || !el) return;
    onMsgScroll();
    const observer = new ResizeObserver(onMsgScroll);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fixed, browseHasMore, msgLoading, msgLoadingMore, msgError, onMsgScroll, suspended]);

  const jumpTo = useCallback(
    (msg: Pick<ConversationRecordHit, 'msgSeq' | 'msgId'>) => {
      if (localSource) {
        closeForwardWindows();
        localSource.onJump(msg.msgId);
        onClose();
        return;
      }
      if (!selected) return;
      if (
        (!/^\d+$/.test(msg.msgSeq) || BigInt(msg.msgSeq) <= 0n) &&
        !(selected.targetUid.startsWith('service:') && msg.msgId)
      ) {
        setMsgError('该消息没有可定位的原生序号。');
        return;
      }
      if (onSuspend) {
        savedScrollTop.current = msgScrollRef.current?.scrollTop ?? null;
        setCalendarOpen(false);
        setRangeCalendarOpen(false);
      }
      closeForwardWindows();
      onJumpMessage({
        source: selected.source,
        targetUid: selected.targetUid,
        msgSeq: msg.msgSeq,
        msgId: msg.msgId,
      });
      (onSuspend ?? onClose)();
    },
    [onJumpMessage, onClose, onSuspend, selected, localSource],
  );

  const jumpToReply = useCallback(
    async (target: ReplyJumpTarget) => {
      if (localSource) {
        if (target.msgId) jumpTo({ msgId: target.msgId, msgSeq: '' });
        return;
      }
      const positive = (value: unknown) =>
        /^[1-9]\d*$/.test(String(value)) ? String(value) : undefined;
      const run = msgRunRef.current;
      let seq = isGroup ? (positive(target.seq) ?? positive(target.index)) : positive(target.index);
      if (!isGroup && !seq && positive(target.clientSeq)) {
        try {
          seq =
            (await client.account.resolveReplySeq.query({
              conv: selected.targetUid,
              clientSeq: String(target.clientSeq),
              senderUin: positive(target.senderUin),
              sendTime: positive(target.sendTime),
            })) ?? undefined;
        } catch {
          // 服务未能精确解析引用时，不用不同语义的序号跳到另一条消息。
        }
      } else if (!isGroup) seq ??= positive(target.seq);
      if (run !== msgRunRef.current || run?.controller.signal.aborted) return;
      jumpTo({ msgId: target.msgId ?? '', msgSeq: seq ?? '' });
    },
    [isGroup, jumpTo, localSource, selected.targetUid],
  );

  const convKey = isGroup ? selected.targetUid : '';
  const browseRecords = fixed && !localSource;
  const mediaKind = sharedMedia && (category === 'image' || category === 'video') ? category : null;
  const messageList = mediaKind ? [] : messages;
  const searchingRecords = browseRecords && (msgLoading || msgLoadingMore);
  const progress = scannedDay ? `已查到 ${scannedDay}` : '';
  const galleryMessages = useMemo(
    () =>
      messages.map((message) => ({
        msgId: message.msgId,
        msgSeq: message.msgSeq,
        sendTime: message.sendTime,
        elements: message.elements ?? [],
      })),
    [messages],
  );
  if (suspended) return null;

  const content = (
    <>
      {report.dialog}
      <div className="weq-chatrecords">
        {embedded ? null : (
          <ChatRecordsHeader
            conversationName={fixed ? initialHit.name : undefined}
            title={sharedMedia ? '共享媒体' : undefined}
            onClose={onClose}
          />
        )}
        {calendarOpen && selected ? (
          <ConversationCalendar
            embedded={embedded}
            kind={selected.source === 'group' ? 'group' : 'c2c'}
            conv={selected.targetUid}
            onClose={() => setCalendarOpen(false)}
            onJump={(seq, msgId) => jumpTo({ msgSeq: seq, msgId: msgId ?? '' })}
          />
        ) : null}
        {embedded ? null : (
          <input
            className="weq-search-more-input"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder={fixed ? `搜索「${initialHit.name}」的消息` : '搜索消息'}
            autoFocus
          />
        )}
        <div className="weq-record-calendar-actions">
          {sharedMedia ? (
            <div className="weq-record-media-categories" role="group" aria-label="共享媒体类型">
              {sharedCategories.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className="weq-set-btn"
                  aria-pressed={category === kind}
                  onClick={() => setCategory(kind)}
                >
                  {categoryLabels[kind]}
                </button>
              ))}
            </div>
          ) : null}
          {fixed ? (
            <button type="button" onClick={() => setRangeCalendarOpen(true)}>
              <CalendarDays size={15} />
              {startDay || endDay ? `${startDay || '不限'} 至 ${endDay || '不限'}` : '时间范围'}
            </button>
          ) : null}
          <button
            type="button"
            title="按日期定位"
            disabled={Boolean(localSource) || !selected}
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
              <FormSuggestions
                aria-label="发送者"
                placeholder="昵称、备注或 QQ 号"
                value={sender}
                onValueChange={setSender}
                options={senderOptions}
              />
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
            {!sharedMedia ? (
              <FormSelect
                aria-label="消息类型"
                disabled={Boolean(localSource)}
                value={category}
                onChange={(e) => setCategory(e.target.value as typeof category)}
              >
                <option value="">全部类型</option>
                {Object.entries(categoryLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </FormSelect>
            ) : null}
            <FormSelect
              aria-label="导出格式"
              disabled={Boolean(localSource)}
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value as typeof exportFormat)}
            >
              {['json', 'jsonl', 'txt', 'csv', 'xlsx', 'html'].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </FormSelect>
            <label className="weq-record-self">
              <input
                type="checkbox"
                checked={includeMedia || exportFormat === 'html'}
                disabled={Boolean(localSource) || exportFormat === 'html'}
                onChange={(e) => setIncludeMedia(e.target.checked)}
              />
              附件
            </label>
            <button
              className="weq-dialog-x"
              aria-label="导出筛选结果"
              title="导出筛选结果"
              disabled={
                exportBusy ||
                msgLoading ||
                !!msgError ||
                !selected ||
                Boolean(localSource && (!requestExport || !messages.length))
              }
              onClick={() => {
                if (localSource) {
                  const scope = conversationExportSelection(localSource.conversation);
                  if (requestExport && scope && messages.length)
                    requestExport({
                      ...scope,
                      scope: {
                        type: 'items',
                        ids: localMatches.current.map((message) => message.msgId),
                      },
                    });
                  if (requestExport && scope && messages.length) onClose();
                  return;
                }
                if (!selected) return;
                setExportBusy(true);
                setMsgError('');
                void (async () => {
                  const includeIntegrityReport = await report.choose();
                  if (includeIntegrityReport === null) return;
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
                    includeIntegrityReport,
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
        <div className="weq-chatrecords-body is-fixed">
          {searchingRecords || (browseRecords && browseHasMore && progress) ? (
            <div className="weq-record-progress" role="status">
              {searchingRecords ? (
                <LoadingIndicator>
                  {progress ? `正在搜索，${progress}` : '正在搜索聊天记录…'}
                </LoadingIndicator>
              ) : (
                progress
              )}
            </div>
          ) : null}
          <div className="weq-chatrecords-msgs" ref={bindMsgScroll} onScroll={onMsgScroll}>
            <ForwardKindContext.Provider value={isGroup ? 'group' : 'c2c'}>
              <ConvContext.Provider value={convKey}>
                <ChatMediaGallery
                  key={`${selected?.targetUid}:${JSON.stringify(filter)}`}
                  scopeKey={selected?.targetUid}
                  conv={selected?.targetUid ?? ''}
                  kind={isGroup ? 'group' : 'c2c'}
                  filter={filter}
                  mediaKind={mediaKind ?? undefined}
                  paged={!localSource}
                  messages={galleryMessages}
                >
                  <ReplyJumpContext.Provider value={jumpToReply}>
                    {msgLoading ? (
                      browseRecords ? null : (
                        <SearchListSkeleton rows={4} />
                      )
                    ) : messages.length === 0 ? (
                      browseRecords && (msgError || searchingRecords) ? null : (
                        <EmptyState compact icon={<SearchX />} title="没有找到相关消息" />
                      )
                    ) : (
                      <>
                        {mediaKind ? (
                          <SharedRecordMedia mediaKind={mediaKind} onLocate={jumpTo} />
                        ) : null}
                        {messageList.map((msg) => {
                          // 能取到原消息 40800 正文的，渲染真实气泡；找不到的回退纯文本行。
                          const elements = sharedMedia
                            ? msg.elements?.filter(
                                (element) =>
                                  !!element &&
                                  typeof element === 'object' &&
                                  'type' in element &&
                                  (element.type === 'file' ||
                                    element.type === 'onlineFile' ||
                                    element.type === 'onlineFolder'),
                              )
                            : msg.elements;
                          if (elements?.length && conversation) {
                            const message =
                              localSource?.messages.find((message) => message.id === msg.msgId) ??
                              messageFromHit(
                                msg,
                                conversation,
                                user
                                  ? enrichReplyElements(
                                      elements,
                                      conversation,
                                      user,
                                      members,
                                      replyIndex,
                                    )
                                  : elements,
                              );
                            const mine = localSource
                              ? message.senderId === localSource.user.id
                              : Boolean(
                                  (user?.uid && user.uid === msg.senderUid) ||
                                    (ownUin && ownUin === msg.senderUin),
                                );
                            const sender =
                              members?.get(msg.senderUid) ??
                              (mine && !isGroup ? (localSource?.user ?? user) : undefined) ??
                              message.sender ??
                              senderUserFromHit(msg);
                            return (
                              <div
                                key={msg.msgId}
                                className="weq-chatrecords-msg is-bubble"
                                role="button"
                                tabIndex={0}
                                onClick={(event) => {
                                  if (
                                    event.defaultPrevented ||
                                    (event.target instanceof Element &&
                                      event.target !== event.currentTarget &&
                                      event.target.closest('button, a[href], input, video, audio'))
                                  )
                                    return;
                                  jumpTo(msg);
                                }}
                                onKeyDown={(event) => {
                                  if (
                                    event.target === event.currentTarget &&
                                    (event.key === 'Enter' || event.key === ' ')
                                  ) {
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
                                  mine={mine}
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
                                  {msg.senderName ? (
                                    <>
                                      <span data-privacy-sensitive>{msg.senderName}</span>
                                      {' · '}
                                    </>
                                  ) : null}
                                  <span className="weq-number weq-number-inherit">
                                    {formatTime(msg.sendTime)}
                                  </span>{' '}
                                  · seq{' '}
                                  <span className="weq-number weq-number-inherit">
                                    {msg.msgSeq}
                                  </span>
                                </span>
                                <span className="weq-chatrecords-msg-content">
                                  {highlightText(msg.content, keyword.trim())}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                        {msgLoadingMore && !browseRecords ? <SearchListSkeleton rows={2} /> : null}
                        {(fixed ? !browseHasMore : messages.length >= msgTotal) &&
                        messages.length > 0 ? (
                          <div className="weq-search-more-end">
                            {msgLimited ? '本轮候选已显示完' : '没有更多了'}
                          </div>
                        ) : null}
                      </>
                    )}
                  </ReplyJumpContext.Provider>
                </ChatMediaGallery>
              </ConvContext.Provider>
            </ForwardKindContext.Provider>
          </div>
        </div>
      </div>
    </>
  );
  if (embedded) return content;
  return (
    <Modal
      presentation="floating"
      onClose={() => {
        if (rangeCalendarOpen) setRangeCalendarOpen(false);
        else if (calendarOpen) setCalendarOpen(false);
        else onClose();
      }}
      width={960}
      labelledBy="weq-chatrecords-title"
    >
      {content}
    </Modal>
  );
}

function SharedRecordMedia({
  mediaKind,
  onLocate,
}: {
  mediaKind: 'image' | 'video';
  onLocate: (message: Pick<ConversationRecordHit, 'msgSeq' | 'msgId'>) => void;
}) {
  const open = useChatMediaOpen();
  const items = useChatMediaItems();
  if (!items.length) return <EmptyState compact icon={<SearchX />} title="没有可浏览的媒体" />;
  return (
    <div className="weq-record-media-grid" role="list" aria-label={categoryLabels[mediaKind]}>
      {items.map((item) => (
        <div className="weq-record-media-tile" role="listitem" key={item.key}>
          <button
            type="button"
            className="weq-record-media-thumbnail"
            aria-label={`查看${categoryLabels[mediaKind]}：${item.title}`}
            onClick={(event) => open?.(item.key, event.currentTarget.ownerDocument)}
          >
            <ShimmerImage
              className="qq-media-image"
              src={item.kind === 'video' ? item.poster : item.src}
              alt=""
              loading="lazy"
            />
            {item.kind === 'video' ? (
              <Play className="weq-record-media-play" size={17} aria-hidden />
            ) : null}
          </button>
          <button
            type="button"
            className="weq-set-btn"
            aria-label={`定位原消息：${item.title}`}
            onClick={() =>
              onLocate({ msgId: item.order?.rawId ?? '', msgSeq: item.order?.sequence ?? '' })
            }
          >
            <LocateFixed size={14} aria-hidden />
            定位原消息
          </button>
        </div>
      ))}
    </div>
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
      id: code,
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
    id: hit.targetUid,
    updatedAt: '',
    unreadCount: 0,
    lastMessage: null,
    otherUser,
    group: null,
    members: [],
  } as unknown as Conversation;
}

/** Build the template Message the bubble renders from a search hit. */
function messageFromHit(
  hit: ConversationRecordHit,
  conversation: Conversation,
  elements: unknown[],
): Message {
  const sender = senderUserFromHit(hit);
  return {
    id: hit.msgId,
    conversationId: conversation.id,
    senderId: sender.id,
    sender,
    body: hit.content,
    createdAt: toIsoTime(hit.sendTime),
    qqElements: elements,
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
  return `${eventTimeFormatter.format(d)} +08`;
}
