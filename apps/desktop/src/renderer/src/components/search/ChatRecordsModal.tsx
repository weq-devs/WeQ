import { NumericText } from '../NumericText';
import { EmptyState } from '../EmptyState';
/** 会话消息搜索：全局搜索内嵌展示，会话顶栏入口使用单会话浮窗。 */

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { CalendarDays, LocateFixed, Search, SearchX, X } from 'lucide-react';
import { ChatRecordsHeader } from './ChatRecordsHeader';
import { RecordSearchCalendar } from './RecordSearchCalendar';
import { RecordSenderAvatar, RecordSenderPicker, type RecordSender } from './RecordSenderPicker';
import { RecordMediaResults } from './RecordMediaResults';
import { useReadonlyMessageMenu } from '../../hooks/useReadonlyMessageMenu';
import { daySeconds, pickCalendarRange } from '../../lib/messageCalendar';
import { RecordDayHeading } from './recordDays';
import { recordDay, groupRecordDays } from './recordDays.shared';
import { conversationDisplayKey } from '@weq/service/client-preferences';
import { matchesConversationRecordType } from '@weq/service/message-filter';
import { Modal } from '../Dialog';
import { LoadingIndicator } from '../LoadingIndicator';
import { SearchListSkeleton } from './SearchSkeleton';
import { c2cAvatarSrc, createSearchHighlighter, groupAvatarSrc } from './SearchResultCard.shared';
import type { ChatRecordSearchHit, ConversationRecordHit } from './types';
import { client, trpc } from '../../trpc/client';
import type { QQWriteBinding } from '../../hooks/useQQWriteSession';
import {
  ConvContext,
  ForwardKindContext,
  ReplyJumpContext,
  type ReplyJumpTarget,
} from '../../state/messageContext';
import { closeForwardWindows } from '../../state/forwardWindow';
import { ChatMediaGallery } from '../ChatMediaGallery';
import { MessageRow } from '../../im-template/template/messageRow';
import { grayTipOf } from '../../im-template/template/messageRow.shared';
import { MessageProvenance } from '../MessageProvenance';
import { displayUserName } from '../../im-template/template/user';
import type { MessageRenderer } from '../../im-template/template/messageRenderers';
import type { Conversation, GroupMember, Message, User } from '../../im-template/template/types';
import '../../styles/qzone.css';
import '../../styles/chat-records.css';
import { useRecordedSenderNames } from '../../hooks/useRecordedSenderNames';
import { useShowHistoricalNames } from '../../lib/clientPreferences';
import { createReplyPreviewIndex } from '../../lib/replyPreview';
import {
  enrichReplyElements,
  extractGrayTipUids,
  resolveRecallRevokerName,
} from '../../views/workspace/messageProjection';
import { createMemberUinLookup, messageSender } from '../../lib/messageSender';
import { useRecordMatchHighlight } from './useRecordMatchHighlight';
import type { RenderElement } from '../QqMessageContent.shared';
import type { ConversationRecordType } from '@weq/service';
import type { GlobalChatRecordFilter } from '@weq/service/search-policy';

const emptySelf: User = {
  id: '',
  username: '',
  displayName: '',
  identityLabel: '',
  identityValue: '',
  avatarUrl: null,
};
type BrowseCursor = { time: number; rowId: string };
const tabs = [
  ['', '全部'],
  ['media', '图片/视频'],
  ['emoji', '表情'],
  ['voice', '语音'],
  ['file', '文件'],
  ['forward', '聊天记录'],
  ['linkCard', '链接/卡片'],
  ['other', '其他'],
] as const satisfies ReadonlyArray<readonly [ConversationRecordType | '', string]>;

export function ChatRecordsModal({
  initialHit,
  initialKeyword,
  fixed = false,
  accountBinding,
  globalRecordFilter,
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
  accountBinding?: QQWriteBinding;
  globalRecordFilter?: GlobalChatRecordFilter;
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
  const [localKeyword, setKeyword] = useState(initialKeyword);
  const embedded = embeddedKeyword !== undefined;
  const keyword = embeddedKeyword ?? localKeyword;
  const trimmedKeyword = keyword.trim();
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [senderOpen, setSenderOpen] = useState(false);
  const calendarAnchor = useRef<HTMLButtonElement>(null);
  const senderAnchor = useRef<HTMLButtonElement>(null);
  const [{ start: startDay, end: endDay }, setRange] = useState({ start: '', end: '' });
  const [locateDay, setLocateDay] = useState('');
  const [dayNotice, setDayNotice] = useState('');
  const [senders, setSenders] = useState<RecordSender[]>([]);
  const expectedAccountUin = accountBinding?.expectedAccountUin;
  const expectedAccountConfigId = accountBinding?.expectedAccountConfigId;
  const [ownUin, setOwnUin] = useState('');
  const [category, setCategory] = useState<ConversationRecordType | ''>('');
  const [msgError, setMsgError] = useState('');
  const [settledFilter, setSettledFilter] = useState<typeof filter>();
  const [browseHasMore, setBrowseHasMore] = useState(false);
  const browseCursor = useRef<BrowseCursor | null>(null);
  const [scannedDay, setScannedDay] = useState('');
  const localMatches = useRef<ConversationRecordHit[]>([]);
  const filter = useMemo(
    () => ({
      senders: senders.length ? senders.map(({ id }) => id) : undefined,
      keyword: trimmedKeyword || undefined,
      recordType: category || undefined,
      start: startDay ? daySeconds(startDay) : undefined,
      end: endDay ? daySeconds(endDay) + 86399 : undefined,
    }),
    [senders, trimmedKeyword, category, startDay, endDay],
  );
  const refreshing = fixed && settledFilter !== filter;
  const hasSearch = fixed || Boolean(filter.keyword);
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
  const [msgLoading, setMsgLoading] = useState(() => !localSource && hasSearch);
  const [msgLoadingMore, setMsgLoadingMore] = useState(false);
  const [atResultsEnd, setAtResultsEnd] = useState(false);
  const [msgTotal, setMsgTotal] = useState(0);
  const [msgLimited, setMsgLimited] = useState(false);
  const msgRunRef = useRef<{ controller: AbortController; requestPending: boolean } | null>(null);
  const msgScrollRef = useRef<HTMLDivElement | null>(null);
  const savedScrollTop = useRef<number | null>(null);
  const bindMsgScroll = useCallback((element: HTMLDivElement | null) => {
    msgScrollRef.current = element;
    if (!element || savedScrollTop.current === null) return;
    element.scrollTop = savedScrollTop.current;
    savedScrollTop.current = null;
  }, []);
  const isGroup = selected.source === 'group';
  const kind = isGroup ? 'group' : 'c2c';
  const essence = trpc.account.listGroupEssenceSeqs.useQuery(
    {
      groupCode: selected.targetUid,
      expectedAccountUin,
      expectedAccountConfigId,
    },
    { enabled: isGroup && !localSource && !suspended && messages.length > 0, staleTime: 300_000 },
  );
  const showHistorical = useShowHistoricalNames(
    localSource ? undefined : conversationDisplayKey(kind, selected.targetUid),
  );
  const recordedSenderNames = useRecordedSenderNames(
    showHistorical && !suspended ? { kind, conv: selected.targetUid } : null,
    accountBinding,
    messages,
  );
  const members = useMemo(
    () => (isGroup && !localSource ? groupMembers?.(selected.targetUid) : undefined),
    [isGroup, localSource, groupMembers, selected.targetUid],
  );
  const memberByUin = useMemo(() => members && createMemberUinLookup(members), [members]);
  const recordUser = useMemo(() => {
    if (localSource) return localSource.user;
    if (user) return user;
    return ownUin
      ? {
          ...emptySelf,
          id: `self:${ownUin}`,
          identityLabel: 'QQ',
          identityValue: ownUin,
          displayName: '你',
          avatarUrl: c2cAvatarSrc(ownUin),
        }
      : emptySelf;
  }, [localSource, user, ownUin]);
  const localMessagesById = useMemo(
    () => new Map(localSource?.messages.map((message) => [message.id, message])),
    [localSource],
  );
  const localRows = useMemo(() => {
    if (!localSource) return [];
    return localSource.messages
      .filter((message) => !message.generatedPending)
      .map(
        (message): ConversationRecordHit => ({
          msgId: message.id,
          msgSeq: message.msgSeq ?? '',
          senderUid: message.senderId,
          senderUin: message.sender?.identityValue ?? '',
          senderName: message.sender?.displayName ?? '',
          sendTime: String(new Date(message.createdAt).getTime() / 1000),
          content: message.body,
          elements: message.qqElements?.length
            ? message.qqElements
            : [{ type: 'text', data: { textContent: message.body } }],
        }),
      )
      .sort((a, b) => Number(b.sendTime) - Number(a.sendTime));
  }, [localSource]);
  const localDays = useMemo(
    () =>
      localSource
        ? [...groupRecordDays(localRows)]
            .filter(([day]) => day)
            .map(([day, rows]) => ({ day, count: rows.length }))
            .reverse()
        : undefined,
    [localRows, localSource],
  );
  const senderOptions = useMemo(() => {
    if (!senderOpen) return [];
    const options = new Map<string, RecordSender>();
    if (localSource?.conversation.type === 'group') {
      for (const member of localSource.conversation.members)
        options.set(member.id, {
          id: member.id,
          label: displayUserName(member),
          avatar: member.avatarUrl,
        });
    }
    for (const message of localSource ? localRows : messages) {
      const uin = message.senderUin && message.senderUin !== '0' ? message.senderUin : '';
      const id = (localSource ? message.senderUid : uin) || message.senderUid;
      if (id && !options.has(id))
        options.set(id, {
          id,
          label: message.senderName || id,
          avatar: !localSource && uin ? c2cAvatarSrc(uin) : null,
        });
    }
    const self = localSource?.user ?? user;
    const selfId = localSource ? self?.id : ownUin || self?.uid;
    if (selfId)
      options.set(selfId, {
        id: selfId,
        label: self?.displayName || '我',
        avatar: self?.avatarUrl ?? c2cAvatarSrc(ownUin),
      });
    if (!isGroup && !localSource) {
      const uin = /^[1-9]\d*$/.test(selected.targetUin) ? selected.targetUin : '';
      const avatar = c2cAvatarSrc(uin);
      const id = uin || selected.targetUid;
      if (id) options.set(id, { id, label: selected.name, avatar });
    }
    for (const member of members?.values() ?? []) {
      const uin = member.uin && member.uin !== '0' ? member.uin : '';
      const id = uin || member.id;
      if (!id) continue;
      const label = [
        ...new Set([member.remark, member.card, member.nick, member.displayName].filter(Boolean)),
      ].join(' · ');
      options.set(id, { id, label: label || id, avatar: member.avatarUrl ?? c2cAvatarSrc(uin) });
    }
    return [...options.values()];
  }, [senderOpen, messages, localRows, localSource, isGroup, selected, members, ownUin, user]);
  useEffect(() => {
    if (!isGroup || localSource || !resolveGroupMembers) return;
    const uids = new Set<string>();
    for (const row of messages) {
      if (row.senderUid) uids.add(row.senderUid);
      if (row.recall?.revokeUid) uids.add(row.recall.revokeUid);
      for (const uid of extractGrayTipUids(row.elements ?? [])) uids.add(uid);
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
          .map((row) => ({
            ...row,
            elements: row.elements!,
            ...(recordedSenderNames
              ? { senderAtTime: recordedSenderNames.get(row.msgId) ?? undefined }
              : {}),
          })),
      ),
    [messages, recordedSenderNames],
  );

  // 共享灰条和昵称解析需要这次搜索的会话及已取得的成员资料。
  const conversation = useMemo(
    () => localSource?.conversation ?? conversationFromHit(selected, members, essence.data),
    [selected, localSource, members, essence.data],
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
            lookAhead: true,
            recordFilter: globalRecordFilter,
            expectedAccountUin,
            expectedAccountConfigId,
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
        if (page.scannedTime) setScannedDay(recordDay(page.scannedTime));
        setBrowseHasMore(page.hasMore);
        if (page.items.length || !page.hasMore)
          return { items: page.items, total: undefined, limited: false };
      }
    },
    [fixed, selected, filter, expectedAccountUin, expectedAccountConfigId, globalRecordFilter],
  );

  // Fetch messages for the selected conversation.
  useEffect(() => {
    setMsgLoadingMore(false);
    setAtResultsEnd(false);
    setMsgLimited(false);
    setMsgError('');
    setScannedDay('');
    browseCursor.current = null;
    msgScrollRef.current?.scrollTo(0, 0);
    if (!hasSearch) {
      msgRunRef.current = null;
      localMatches.current = [];
      setMessages([]);
      setMsgTotal(0);
      setBrowseHasMore(false);
      setMsgLoading(false);
      return;
    }
    // 筛选切换时滚动回调仍可能看到上一轮的分页状态，首屏和续页共用这个同步标记。
    const run = { controller: new AbortController(), requestPending: !localSource };
    const { signal } = run.controller;
    msgRunRef.current = run;
    const cancel = () => run.controller.abort();
    if (localSource) {
      const selectedSenders = new Set(filter.senders);
      const keyword = filter.keyword?.toLocaleLowerCase();
      const rows = localRows.filter((message) => {
        const time = Number(message.sendTime);
        return (
          (!keyword || message.content.toLocaleLowerCase().includes(keyword)) &&
          (filter.start == null || time >= filter.start) &&
          (filter.end == null || time <= filter.end) &&
          (!selectedSenders.size || selectedSenders.has(message.senderUid)) &&
          (!filter.recordType ||
            matchesConversationRecordType(
              (message.elements ?? []) as RenderElement[],
              filter.recordType,
            ))
        );
      });
      localMatches.current = rows;
      setMessages(rows.slice(0, 30));
      setMsgTotal(Math.min(rows.length, 30));
      setMsgLoading(false);
      setBrowseHasMore(rows.length > 30);
      setSettledFilter(filter);
      return cancel;
    }
    setMessages([]);
    setMsgTotal(0);
    setBrowseHasMore(false);
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
        run.requestPending = false;
        if (!signal.aborted) {
          setSettledFilter(filter);
          setMsgLoading(false);
        }
      });
    return cancel;
  }, [hasSearch, filter, localRows, localSource, queryMessages]);

  const loadMoreMessages = useCallback(() => {
    if (localSource) {
      const next = localMatches.current.slice(0, messages.length + 30);
      setMessages(next);
      setMsgTotal(next.length);
      setBrowseHasMore(next.length < localMatches.current.length);
      return;
    }
    const run = msgRunRef.current;
    if (!run || run.requestPending || msgLoading) return;
    const { signal } = run.controller;
    if (signal.aborted) return;
    run.requestPending = true;
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
        run.requestPending = false;
        if (!signal.aborted) setMsgLoadingMore(false);
      });
  }, [messages.length, msgLoading, localSource, queryMessages]);

  // 提前续页与显示底部进度使用不同的距离。
  const onMsgScroll = useCallback(() => {
    const el = msgScrollRef.current;
    if (!el?.clientHeight) return;
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (fixed && !localSource) setAtResultsEnd(el.scrollTop > 0 && remaining <= 1);
    if (
      !hasSearch ||
      msgLoading ||
      msgLoadingMore ||
      msgError ||
      remaining > 120 ||
      (fixed ? !browseHasMore : messages.length >= msgTotal)
    )
      return;
    void loadMoreMessages();
  }, [
    hasSearch,
    loadMoreMessages,
    localSource,
    msgLoading,
    msgLoadingMore,
    msgError,
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
        setDayNotice('该消息没有可定位的原生序号。');
        return;
      }
      if (onSuspend) {
        savedScrollTop.current = msgScrollRef.current?.scrollTop ?? null;
        setCalendarOpen(false);
        setSenderOpen(false);
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

  const recordMenu = useReadonlyMessageMenu({
    conversation,
    user: recordUser,
    detailsBinding: localSource ? null : accountBinding,
    scope: JSON.stringify([
      expectedAccountUin,
      expectedAccountConfigId,
      kind,
      selected.targetUid,
      filter,
      suspended,
    ]),
    onLocate: (message) =>
      jumpTo({
        msgSeq: message.msgSeq ?? '',
        msgId: localSource ? message.id : (message.msgId ?? message.id),
      }),
  });
  function recordMessage(hit: ConversationRecordHit): Message {
    const body = recordBodies.get(hit.msgId);
    return (
      localMessagesById.get(hit.msgId) ??
      messageFromHit(
        body ? { ...hit, elements: body } : hit,
        conversation,
        recordUser,
        members,
        memberByUin,
        replyIndex,
        showHistorical,
        recordedSenderNames?.get(hit.msgId)?.name,
      )
    );
  }

  const convKey = isGroup ? selected.targetUid : '';
  const browseRecords = fixed && !localSource;
  const searchingRecords = browseRecords && (refreshing || msgLoading || msgLoadingMore);
  const showSearchProgress = browseRecords && !refreshing && msgLoadingMore && atResultsEnd;
  useLayoutEffect(() => {
    const el = msgScrollRef.current;
    // 底栏出现会缩短滚动视口，保持最后一条已加载结果可见。
    if (showSearchProgress && el) el.scrollTop = el.scrollHeight;
  }, [showSearchProgress, suspended]);
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
  const resultsByDay = useMemo(
    () => (fixed ? groupRecordDays(messages) : new Map([['', messages]])),
    [fixed, messages],
  );

  useEffect(() => {
    if (!locateDay || suspended || refreshing || msgLoading || msgLoadingMore || msgError) return;
    const day = msgScrollRef.current?.querySelector<HTMLElement>(
      `[data-record-day="${locateDay}"]`,
    );
    if (day) {
      day.scrollIntoView({ block: 'start' });
      setLocateDay('');
    } else if (browseHasMore && (!scannedDay || scannedDay >= locateDay)) {
      loadMoreMessages();
    } else {
      setDayNotice(`${locateDay} 没有符合条件的消息`);
      setLocateDay('');
    }
  }, [
    locateDay,
    suspended,
    refreshing,
    msgLoading,
    msgLoadingMore,
    msgError,
    browseHasMore,
    scannedDay,
    loadMoreMessages,
  ]);

  const updateRange = (range: { start: string; end: string }) => {
    setRange(range);
    setLocateDay('');
    setDayNotice('');
  };
  const mediaType = category === 'media' || category === 'emoji' ? category : undefined;
  const highlightRichText = useRecordMatchHighlight(
    msgScrollRef,
    hasSearch && !mediaType && !suspended ? trimmedKeyword : '',
  );
  const highlighter = useMemo(() => createSearchHighlighter(trimmedKeyword), [trimmedKeyword]);
  if (suspended) return null;
  const dateLabel = startDay
    ? endDay && endDay !== startDay
      ? `${startDay} 至 ${endDay}`
      : startDay
    : '按日期筛选';
  const senderLabel =
    senders.length === 0
      ? '全部发送者'
      : senders.length === 1
        ? senders[0]?.label
        : `${senders.length} 位发送者`;
  const content = (
    <div className={`weq-chatrecords${fixed ? ' weq-conversation-records' : ''}`}>
      {embedded ? null : (
        <ChatRecordsHeader
          conversationName={fixed ? initialHit.name : undefined}
          onClose={onClose}
        />
      )}
      {fixed && senderOpen ? (
        <RecordSenderPicker
          options={senderOptions}
          selected={senders}
          groupCode={isGroup && !localSource ? selected.targetUid : undefined}
          binding={accountBinding}
          anchor={senderAnchor.current}
          onChange={(value) => {
            setSenders(value);
            setLocateDay('');
            setDayNotice('');
          }}
          onClose={() => setSenderOpen(false)}
        />
      ) : null}
      {fixed && calendarOpen ? (
        <RecordSearchCalendar
          kind={isGroup ? 'group' : 'c2c'}
          conv={selected.targetUid}
          binding={accountBinding}
          anchor={calendarAnchor.current}
          initialDay={recordDay(messages[0]?.sendTime)}
          localDays={localDays}
          start={startDay}
          end={endDay}
          onPick={(day) => updateRange(pickCalendarRange(startDay, endDay, day))}
          onPickSingle={(day) => updateRange({ start: day, end: day })}
          onClear={() => updateRange({ start: '', end: '' })}
          onLocate={(day) => {
            setCalendarOpen(false);
            setDayNotice('');
            const unfiltered = !trimmedKeyword && !senders.length && !category && !startDay;
            if (unfiltered || (startDay && (day < startDay || (endDay && day > endDay))))
              setRange({ start: day, end: day });
            setLocateDay(day);
          }}
          onClose={() => setCalendarOpen(false)}
        />
      ) : null}
      {embedded ? null : (
        <div className="weq-record-search-bar">
          {fixed ? (
            <button
              type="button"
              ref={senderAnchor}
              className="weq-record-filter-trigger"
              aria-label={senderLabel}
              title={senderLabel}
              aria-haspopup="dialog"
              aria-expanded={senderOpen}
              data-active={senders.length > 0 || undefined}
              onClick={() => setSenderOpen(!senderOpen)}
            >
              <RecordSenderAvatar sender={senders.length === 1 ? senders[0] : undefined} />
              {senders.length > 1 ? <NumericText>{senders.length}</NumericText> : null}
            </button>
          ) : null}
          <div className="weq-record-search-input">
            <Search size={16} aria-hidden />
            <input
              type="search"
              value={keyword}
              maxLength={512}
              aria-label="搜索本会话"
              onChange={(event) => {
                setKeyword(event.target.value);
                setLocateDay('');
                setDayNotice('');
              }}
              placeholder="搜索本会话"
              data-weq-autofocus
            />
            {keyword ? (
              <button
                type="button"
                className="weq-dialog-x"
                aria-label="清空关键词"
                onClick={() => {
                  setKeyword('');
                  setLocateDay('');
                  setDayNotice('');
                }}
              >
                <X size={15} />
              </button>
            ) : null}
          </div>
          {fixed ? (
            <button
              type="button"
              ref={calendarAnchor}
              className="weq-record-filter-trigger"
              aria-label={dateLabel}
              title={dateLabel}
              aria-haspopup="dialog"
              aria-expanded={calendarOpen}
              data-active={Boolean(startDay) || undefined}
              onClick={() => setCalendarOpen(!calendarOpen)}
            >
              <CalendarDays size={18} aria-hidden />
            </button>
          ) : null}
        </div>
      )}
      {fixed ? (
        <div className="weq-qzn weq-record-types">
          <div className="weq-qzn-navigation">
            <nav aria-label="消息类型">
              {tabs.map(([type, label]) => (
                <button
                  type="button"
                  key={type}
                  aria-current={category === type ? 'page' : undefined}
                  onClick={() => {
                    setCategory(type);
                    setLocateDay('');
                    setDayNotice('');
                  }}
                >
                  {label}
                </button>
              ))}
            </nav>
          </div>
        </div>
      ) : null}
      {dayNotice && hasSearch ? (
        <p className="weq-record-notice" role="status">
          {dayNotice}
        </p>
      ) : null}
      {hasSearch && msgError ? (
        <p role="alert" className="weq-record-error">
          {msgError}
          <button type="button" className="weq-set-btn" onClick={loadMoreMessages}>
            重试
          </button>
        </p>
      ) : null}
      {hasSearch || !fixed ? (
        <div className="weq-chatrecords-body is-fixed">
          <div className="weq-chatrecords-msgs" ref={bindMsgScroll} onScroll={onMsgScroll}>
            <ForwardKindContext.Provider value={isGroup ? 'group' : 'c2c'}>
              <ConvContext.Provider value={convKey}>
                <ChatMediaGallery
                  key={`${selected?.targetUid}:${JSON.stringify(filter)}`}
                  scopeKey={selected?.targetUid}
                  conv={selected?.targetUid ?? ''}
                  kind={isGroup ? 'group' : 'c2c'}
                  filter={filter}
                  renderToolbarActions={
                    fixed
                      ? (item) =>
                          item.order?.rawId ? (
                            <button
                              type="button"
                              className="weq-lightbox-action"
                              title="定位原消息"
                              aria-label="定位原消息"
                              onClick={() =>
                                jumpTo({
                                  msgId: item.order?.rawId ?? '',
                                  msgSeq: item.order?.sequence ?? '',
                                })
                              }
                            >
                              <LocateFixed size={18} />
                            </button>
                          ) : null
                      : undefined
                  }
                  paged={!localSource}
                  browseThumbnails={Boolean(mediaType)}
                  messages={galleryMessages}
                >
                  <ReplyJumpContext.Provider value={jumpToReply}>
                    {!hasSearch ? null : refreshing || msgLoading ? (
                      browseRecords ? (
                        <div className="weq-record-notice" role="status">
                          <LoadingIndicator>正在搜索聊天记录…</LoadingIndicator>
                        </div>
                      ) : (
                        <SearchListSkeleton rows={4} />
                      )
                    ) : messages.length === 0 ? (
                      browseRecords && (msgError || searchingRecords) ? null : (
                        <EmptyState compact icon={<SearchX />} title="没有找到相关消息" />
                      )
                    ) : (
                      <>
                        {mediaType ? (
                          <RecordMediaResults
                            groups={resultsByDay}
                            type={mediaType}
                            contextProps={(message) => recordMenu.rowProps(recordMessage(message))}
                          />
                        ) : (
                          [...resultsByDay].map(([day, rows]) => (
                            <Fragment key={day}>
                              {fixed ? <RecordDayHeading day={day} /> : null}
                              {rows.map((hit) => {
                                const message = recordMessage(hit);
                                const rich = Boolean(
                                  localSource || message.qqElements?.length || hit.deletedKind,
                                );
                                return (
                                  <div
                                    key={hit.msgId}
                                    className={
                                      rich ? 'weq-chatrecords-msg is-bubble' : 'weq-chatrecords-msg'
                                    }
                                    data-weq-record-match={rich || undefined}
                                    {...recordMenu.rowProps(message)}
                                    role={fixed ? 'group' : 'button'}
                                    tabIndex={0}
                                    onClick={(event) => {
                                      if (
                                        fixed ||
                                        event.defaultPrevented ||
                                        (event.target instanceof Element &&
                                          event.target !== event.currentTarget &&
                                          event.target.closest(
                                            'button, a[href], [role="button"], input, video, audio',
                                          )) ||
                                        event.currentTarget.ownerDocument.getSelection()
                                          ?.isCollapsed === false
                                      )
                                        return;
                                      jumpTo(hit);
                                    }}
                                    onKeyDown={(event) => {
                                      if (
                                        !fixed &&
                                        event.target === event.currentTarget &&
                                        (event.key === 'Enter' || event.key === ' ')
                                      ) {
                                        event.preventDefault();
                                        jumpTo(hit);
                                      }
                                    }}
                                    title={fixed ? undefined : '点击跳转到该消息'}
                                  >
                                    {rich ? (
                                      <>
                                        <MessageRow
                                          message={message}
                                          conversation={conversation}
                                          user={recordUser}
                                          sender={message.sender}
                                          renderers={renderers}
                                          alwaysShowSenderName
                                          alwaysShowTime
                                          alwaysShowDate={!fixed}
                                          deletedKind={message.deletedKind}
                                          recallRevokerName={message.recallRevokerName}
                                        />
                                        {!highlightRichText &&
                                        !message.deletedKind &&
                                        !grayTipOf(message) &&
                                        highlighter.matches(hit.content) ? (
                                          <span
                                            className="weq-chatrecords-msg-content weq-record-match-excerpt"
                                            data-privacy-sensitive
                                          >
                                            {highlighter.render(hit.content)}
                                          </span>
                                        ) : null}
                                      </>
                                    ) : (
                                      <>
                                        <RecordSenderAvatar
                                          sender={{
                                            id: message.senderId,
                                            label: message.sender?.displayName ?? '',
                                            avatar: message.sender?.avatarUrl,
                                          }}
                                        />
                                        <span className="weq-chatrecords-msg-text">
                                          <span className="weq-chatrecords-msg-meta weq-message-heading">
                                            <span data-privacy-sensitive>
                                              {message.historicalSenderName ||
                                                message.sender?.displayName}
                                            </span>
                                            <MessageProvenance
                                              message={message}
                                              alwaysShowTime
                                              alwaysShowDate={!fixed}
                                            />
                                          </span>
                                          <span
                                            className="weq-chatrecords-msg-content"
                                            data-privacy-sensitive
                                          >
                                            {highlighter.render(hit.content)}
                                          </span>
                                        </span>
                                      </>
                                    )}
                                  </div>
                                );
                              })}
                            </Fragment>
                          ))
                        )}
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
          {showSearchProgress ? (
            <div className="weq-record-progress" role="status">
              <LoadingIndicator>
                <NumericText>
                  {scannedDay ? `正在搜索，已查到 ${scannedDay}` : '正在搜索更多聊天记录…'}
                </NumericText>
              </LoadingIndicator>
            </div>
          ) : null}
        </div>
      ) : null}
      {recordMenu.menu}
    </div>
  );
  if (embedded) return content;
  return (
    <Modal
      presentation="floating"
      centered
      resizeEdges
      onClose={() => {
        if (calendarOpen) setCalendarOpen(false);
        else if (senderOpen) setSenderOpen(false);
        else onClose();
      }}
      width={960}
      labelledBy="weq-chatrecords-title"
    >
      {content}
    </Modal>
  );
}

function conversationFromHit(
  hit: ChatRecordSearchHit,
  members?: ReadonlyMap<string, GroupMember>,
  essenceSeqs?: string[],
): Conversation {
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
        essenceSeqs,
      },
      members: [...(members?.values() ?? [])],
    };
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
  };
}

function messageFromHit(
  hit: ConversationRecordHit,
  conversation: Conversation,
  user: User,
  members: ReadonlyMap<string, GroupMember> | undefined,
  memberByUin: ReturnType<typeof createMemberUinLookup> | undefined,
  replyIndex: ReturnType<typeof createReplyPreviewIndex>,
  showHistorical: boolean,
  historicalSenderName?: string,
): Message {
  const record = { ...hit, elements: hit.elements ?? [] };
  const sender = messageSender(
    record,
    conversation,
    user,
    members,
    undefined,
    undefined,
    memberByUin,
  );
  const knownMember = members?.has(hit.senderUid) || Boolean(memberByUin?.(hit.senderUin));
  return {
    id: hit.msgId,
    msgId: hit.msgId,
    msgSeq: hit.msgSeq,
    clientSeq: hit.clientSeq,
    conversationId: conversation.id,
    senderId: sender.id,
    senderUid: hit.senderUid,
    sender:
      conversation.type === 'group' && !knownMember && hit.senderName
        ? { ...sender, displayName: hit.senderName }
        : sender,
    historicalSenderName,
    body: hit.content,
    sendTime: hit.sendTime,
    createdAt: toIsoTime(hit.sendTime),
    qqElements: enrichReplyElements(
      record.elements,
      conversation,
      user,
      members,
      replyIndex,
      showHistorical,
    ) as Message['qqElements'],
    setEmojiList: hit.setEmojiList,
    decoration: hit.decoration,
    deletedKind: hit.deletedKind,
    recall: hit.recall,
    recallRevokerName: resolveRecallRevokerName(record, conversation, members),
    source: hit.source,
    sourceFormat: hit.sourceFormat,
  };
}

function toIsoTime(seconds: string): string {
  const time = Number(seconds);
  if (!Number.isFinite(time) || time <= 0) return '';
  const date = new Date(time * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}
