import { TIMELINE_VIRTUAL_THRESHOLD } from '../../hooks/useVirtualTimeline';
import { conversationInteractionId } from '../../../../shared/conversation_interaction';
import { revealTimelineMessage, timelineViewport } from '../../lib/timelineViewport';
import { matchesUnreadMessage } from '../../lib/unreadNavigation';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReplyJump, ReplyJumpTarget } from '../../state/messageContext';
import { restoreReadingPosition } from '../../lib/conversationReadingPosition';
import type { Conversation, Message, UnreadDockStop } from './types';
import { unreadHighlightKey } from './unreadDock';
import type { ChatPaneProps } from './chatPane';
import type { TimelineVisibility } from './chatTimeline';
import { countAppendedMessages, unreadTimelineBoundary } from './chatTimelineModel';

type ViewportReadRow = { seq: string; bottom: number };
type ObservedTimelineRow = { id: string; report: boolean; seq?: string; readable: boolean };
const READ_GESTURE_MS = 1000;

export function useChatTimelineNavigation({
  atLatest,
  conversation,
  initialReadingPosition,
  jumpRequest,
  latestMessageSeq,
  loadError,
  loading,
  loadingNewer,
  timelineSettings,
  messages,
  onJumpToLatest,
  readThroughViewport,
  confirmedReadSeq,
  onReadCurrentConversation,
  pendingInteractions,
  onSeeInteractions,
  parentJumpToSeq,
  tabActive,
  unreadDock,
  seenUnreadHighlights,
  user,
  visibleMessages,
}: {
  atLatest: NonNullable<ChatPaneProps['atLatest']>;
  conversation: ChatPaneProps['conversation'];
  initialReadingPosition: ChatPaneProps['initialReadingPosition'];
  jumpRequest: ChatPaneProps['jumpRequest'];
  latestMessageSeq: ChatPaneProps['latestMessageSeq'];
  loadError: ChatPaneProps['loadError'];
  loading: ChatPaneProps['loading'];
  loadingNewer: NonNullable<ChatPaneProps['loadingNewer']>;
  timelineSettings:
    | { autoFollowLatestMessages?: boolean; jumpToLatestAfterSend?: boolean }
    | undefined;
  messages: ChatPaneProps['messages'];
  onJumpToLatest: ChatPaneProps['onJumpToLatest'];
  readThroughViewport: ChatPaneProps['readThroughViewport'];
  confirmedReadSeq: ChatPaneProps['confirmedReadSeq'];
  onReadCurrentConversation: ChatPaneProps['onReadCurrentConversation'];
  pendingInteractions?: ChatPaneProps['pendingInteractions'];
  onSeeInteractions?: ChatPaneProps['onSeeInteractions'];
  parentJumpToSeq: ReplyJump;
  tabActive: boolean;
  unreadDock: ChatPaneProps['unreadDock'];
  seenUnreadHighlights?: Set<string>;
  user: ChatPaneProps['user'];
  visibleMessages: Message[];
}) {
  const [jumpMissing, setJumpMissing] = useState(false);

  const locatedJump = useRef<typeof jumpRequest>(undefined);

  const [locatedSeq, setLocatedSeq] = useState<string | null>(null);
  const entryVisibility = useMemo(
    () => ({ ids: new Set<string>(), sequences: new Set<string>() }),
    [conversation?.id, conversation?.type],
  );
  const confirmedWatermark =
    confirmedReadSeq && /^\d{1,20}$/.test(confirmedReadSeq) ? BigInt(confirmedReadSeq) : undefined;
  const navigationKey = useMemo(
    () => ({ conversationId: conversation?.id, dock: unreadDock, seenUnreadHighlights }),
    [conversation?.id, unreadDock, seenUnreadHighlights],
  );
  const navigationScope = useRef(navigationKey);
  navigationScope.current = navigationKey;
  // 普通未读只记本次跳转；重要提醒在同一数据源内切换会话后仍记得已查看。
  const [visited, setVisited] = useState<{ scope: typeof navigationKey; seqs: Set<string> }>();
  const visitedStops = visited?.scope === navigationKey ? visited.seqs : undefined;
  const visitStops = useCallback((scope: typeof navigationKey, seqs: string[]) => {
    if (navigationScope.current !== scope || !seqs.length) return;
    const { conversationId, dock, seenUnreadHighlights: seen } = scope;
    if (conversationId && seen) {
      for (const stop of dock?.stops ?? []) {
        if (stop.kind !== 'unread' && seqs.includes(stop.seq))
          seen.add(unreadHighlightKey(conversationId, stop));
      }
      while (seen.size > 512) seen.delete(seen.values().next().value!);
    }
    setVisited((current) => {
      const previous = current?.scope === scope ? current.seqs : undefined;
      return seqs.every((seq) => previous?.has(seq))
        ? current
        : { scope, seqs: new Set([...(previous ?? []), ...seqs]) };
    });
  }, []);
  const isVisited = useCallback(
    (stop: UnreadDockStop) =>
      visitedStops?.has(stop.seq) ||
      (stop.kind === 'unread'
        ? entryVisibility.sequences.has(stop.seq) ||
          (confirmedWatermark !== undefined && BigInt(stop.seq) <= confirmedWatermark)
        : navigationKey.conversationId &&
          seenUnreadHighlights?.has(unreadHighlightKey(navigationKey.conversationId, stop))),
    [confirmedWatermark, entryVisibility, navigationKey, seenUnreadHighlights, visitedStops],
  );
  const locateTask = useRef<object | null>(null);
  const [dockJumping, setDockJumping] = useState(false);
  const dockTask = useRef<object | null>(null);

  // Count of newly-arrived (live) messages while the user is reading history.
  // Surfaces the floating "jump to bottom" pill; cleared once at the bottom.
  const [newMessagePill, setNewMessagePill] = useState(0);

  const [showBottomJump, setShowBottomJump] = useState(false);

  const lastScrollTopRef = useRef(0);

  const latestSeqRef = useRef<{
    conversationId: string | undefined;
    seq: string | undefined;
    unread: number;
  }>({
    conversationId: undefined,
    seq: undefined,
    unread: 0,
  });

  const [jumpingToLatest, setJumpingToLatest] = useState(false);

  const messageScrollRef = useRef<HTMLDivElement | null>(null);

  const timelineContentRef = useRef<HTMLDivElement | null>(null);

  const endRef = useRef<HTMLDivElement | null>(null);

  // Tracks whether the view is pinned to the bottom of the message list.
  // Drives auto-scroll-on-new-message vs. "new messages" pill behaviour.
  const atBottomRef = useRef(true);

  const readingPositionApplied = useRef(false);

  const readGestureUntil = useRef(0);
  const messagesForDock = useRef(messages);
  messagesForDock.current = messages;

  const jumpToSeq = useCallback(
    async (target: ReplyJumpTarget): Promise<boolean> => {
      // 滚动事件晚于消息刷新提交；先退出贴底，避免原消息刚定位就被刷新拉回末尾。
      atBottomRef.current = false;
      readGestureUntil.current = 0;
      const started = navigationScope.current;
      const task = {};
      locateTask.current = task;
      const found = await parentJumpToSeq(target);
      if (found === false || navigationScope.current !== started || locateTask.current !== task)
        return false;
      const seq = target.seq == null ? null : String(target.seq);
      setLocatedSeq(seq);
      const stop = started.dock?.stops.find((stop) => stop.seq === seq);
      if (
        stop &&
        (!stop.identity ||
          target.importantMessage === stop.identity ||
          (target.msgId &&
            messagesForDock.current.some(
              (message) =>
                (message.msgId ?? message.id) === target.msgId &&
                matchesUnreadMessage(message, stop.seq, stop.identity),
            )))
      )
        visitStops(started, [stop.seq]);
      return true;
    },
    [parentJumpToSeq, visitStops],
  );

  const lastReadSignal = useRef({ key: '', at: 0 });
  const viewportRead = useMemo(
    () => ({
      scrollTop: undefined as number | undefined,
      visible: new Map<string, ViewportReadRow>(),
      ready: new Set<string>(),
      watermark: undefined as bigint | undefined,
      lastReport: '',
    }),
    [conversation?.id, conversation?.type, readThroughViewport],
  );
  const viewportReadEnabled = Boolean(readThroughViewport && onReadCurrentConversation);
  const viewportReadVersion = viewportReadEnabled
    ? `${confirmedReadSeq ?? ''}:${conversation?.unreadCount}:${latestMessageSeq ?? ''}`
    : '';
  useLayoutEffect(() => {
    if (viewportReadEnabled && tabActive) return;
    viewportRead.visible.clear();
    viewportRead.scrollTop = undefined;
  }, [viewportRead, viewportReadEnabled, tabActive]);

  const readContextRef = useRef({
    tabActive,
    atLatest,
    loading,
    conversation,
    viewportReadEnabled,
    onReadCurrentConversation,
    lastId: messages.at(-1)?.id,
  });

  readContextRef.current = {
    tabActive,
    atLatest,
    loading,
    conversation,
    viewportReadEnabled,
    onReadCurrentConversation,
    lastId: messages.at(-1)?.id,
  };

  // Last message id we auto-scrolled / accounted for, to detect new arrivals.
  const lastMessageIdRef = useRef<string | null>(null);

  // Conversation id the scroll-tracking refs above currently describe.
  const scrollConversationRef = useRef<string | null>(null);

  const bottomAfterLoadingRef = useRef(false);

  const scrollAtLatestRef = useRef(atLatest);

  const bottomLayoutRef = useRef<{
    height: number;
    viewportHeight: number;
    revision: number | undefined;
  } | null>(null);

  // 换会话（或上层重下了新的一份快照）时，跳转坞从第一个跳转点重新开始。
  useEffect(() => {
    setLocatedSeq(null);
    dockTask.current = null;
    setDockJumping(false);
  }, [conversation?.id, unreadDock]);

  const timelineEnabled = visibleMessages.length > TIMELINE_VIRTUAL_THRESHOLD;

  // 下面几个 effect 只该在会话/消息变化时跑，但正文里要调用这些每次渲染都重建的
  // 函数。用 ref 转发拿最新实现，避免把它们塞进依赖导致 effect 每次渲染重跑。
  const scrollMessagesToBottomRef = useRef<() => void>(() => {});

  const jumpToBottomAndReadRef = useRef<() => Promise<void>>(async () => {});

  useLayoutEffect(() => {
    if (!tabActive) return;
    const conversationId = conversation?.id ?? null;
    const newestId = visibleMessages[visibleMessages.length - 1]?.id ?? null;
    const wasAtLatest = scrollAtLatestRef.current;
    scrollAtLatestRef.current = atLatest;
    if (loading || (loadingNewer && wasAtLatest))
      bottomAfterLoadingRef.current = !initialReadingPosition;

    // Conversation switched (or first paint): jump to bottom, reset trackers.
    if (scrollConversationRef.current !== conversationId) {
      scrollConversationRef.current = conversationId;
      lastMessageIdRef.current = newestId;
      readingPositionApplied.current = false;
      bottomLayoutRef.current = null;
      bottomAfterLoadingRef.current = !initialReadingPosition && (loading || loadingNewer);
      atBottomRef.current = !initialReadingPosition;
      setNewMessagePill(0);
      setShowBottomJump(false);
      lastScrollTopRef.current = 0;
      if (initialReadingPosition || (loading && visibleMessages.length === 0)) {
        if (!loading && messageScrollRef.current && initialReadingPosition) {
          restoreReadingPosition(messageScrollRef.current, initialReadingPosition);
          lastScrollTopRef.current = messageScrollRef.current.scrollTop;
          readingPositionApplied.current = true;
        }
        return;
      }
      scrollMessagesToBottomRef.current();
      const viewport = messageScrollRef.current && timelineViewport(messageScrollRef.current);
      const revision = viewport?.scrollRevision?.();
      const frame = window.requestAnimationFrame(() => {
        const current = readContextRef.current;
        if (
          revision === viewport?.scrollRevision?.() &&
          atBottomRef.current &&
          current.tabActive &&
          current.atLatest &&
          current.conversation?.id === conversationId
        )
          scrollMessagesToBottomRef.current();
      });
      return () => window.cancelAnimationFrame(frame);
    }

    if (
      initialReadingPosition &&
      !readingPositionApplied.current &&
      !loading &&
      messageScrollRef.current
    ) {
      restoreReadingPosition(messageScrollRef.current, initialReadingPosition);
      lastScrollTopRef.current = messageScrollRef.current.scrollTop;
      readingPositionApplied.current = true;
      atBottomRef.current = false;
      lastMessageIdRef.current = newestId;
      return;
    }
    if (loading || loadingNewer) {
      // 首屏分批交付时也要贴底，不能等所有来源加载结束才定位。
      if (!initialReadingPosition && atBottomRef.current && atLatest && newestId !== null)
        scrollMessagesToBottomRef.current();
      return;
    }
    const bottomAfterLoading = bottomAfterLoadingRef.current;
    bottomAfterLoadingRef.current = false;
    // 首屏或尾页缓存校准完成属于进入定位，不受后续新消息跟随偏好控制。
    // 重置尾部追踪，兼容整页替换及乐观尾部 id 不变；用户已离开底部时不动。
    if (bottomAfterLoading && !initialReadingPosition && atBottomRef.current && atLatest)
      lastMessageIdRef.current = null;

    // 尾部 id 没变，但列表内容可能变了。典型情况：打开会话时末尾挂着「数据库里还没有」
    // 的乐观消息，它先成为尾部，随后真实历史在它**上面**补全 —— 尾部 id 一直没变，
    // 早退就会停在第一页中间而不是底部。仍钉在底部（且是实时窗口）时就跟着贴底；
    // 用户在看历史（atBottom=false）或脱离实时窗口时不动。
    if (newestId === lastMessageIdRef.current) {
      if (atBottomRef.current && atLatest && timelineSettings?.autoFollowLatestMessages !== false) {
        scrollMessagesToBottomRef.current();
      }
      return;
    }

    const prevId = lastMessageIdRef.current;
    // The window was swapped wholesale (reply-jump rebuild) when the previous
    // tail is no longer present — that's not a live arrival.
    const replaced = prevId !== null && !visibleMessages.some((message) => message.id === prevId);
    const appended = countAppendedMessages(prevId, visibleMessages, user.id);
    lastMessageIdRef.current = newestId;

    // Detached history window (reply-jump context or downward history paging):
    // tail changes are programmatic. Don't pill, don't yank to the bottom — the
    // host positions the view itself.
    if (replaced || !atLatest) {
      return;
    }

    // 首次加载仍定位底部；后续新消息是否贴底由偏好决定。
    if (
      atBottomRef.current &&
      (prevId === null || timelineSettings?.autoFollowLatestMessages !== false)
    ) {
      setNewMessagePill(0);
      scrollMessagesToBottomRef.current();
      const viewport = messageScrollRef.current && timelineViewport(messageScrollRef.current);
      const revision = viewport?.scrollRevision?.();
      const frame = window.requestAnimationFrame(() => {
        const current = readContextRef.current;
        if (
          revision === viewport?.scrollRevision?.() &&
          atBottomRef.current &&
          current.tabActive &&
          current.atLatest &&
          current.conversation?.id === conversationId
        )
          scrollMessagesToBottomRef.current();
      });
      return () => window.cancelAnimationFrame(frame);
    }

    // 阅读历史或关闭自动跟随时保留当前位置，仍提示他人发送的新消息。
    atBottomRef.current = false;
    setNewMessagePill((current) => current + appended);
    return;
  }, [
    tabActive,
    visibleMessages,
    conversation?.id,
    loading,
    loadingNewer,
    atLatest,
    initialReadingPosition,
    user.id,
    timelineSettings?.autoFollowLatestMessages,
  ]);

  useLayoutEffect(() => {
    const scroll = messageScrollRef.current;
    const content = timelineContentRef.current;
    if (!tabActive || !scroll || !content) return;
    // 意图标签、图片及建议回复异步改变内容或视口高度时，延续原来的下沿位置。
    // 新消息是否跟随仍由上面的 effect 决定；阅读历史和恢复锚点时不接管。
    let frame: number | undefined;
    const schedule = () => {
      if (frame !== undefined) return;
      const viewport = timelineViewport(scroll);
      const revision = viewport?.scrollRevision?.();
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        const current = readContextRef.current;
        if (
          revision === viewport?.scrollRevision?.() &&
          bottomLayoutRef.current?.revision === viewport?.scrollRevision?.() &&
          atBottomRef.current &&
          current.tabActive &&
          current.atLatest &&
          scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 1
        )
          scrollMessagesToBottomRef.current();
      });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(scroll);
    // 虚拟行在 RO 内更新父容器高度；父层改用样式通知，避免向上反馈尺寸交付。
    const mutation = new MutationObserver(schedule);
    if (timelineEnabled)
      mutation.observe(content, { attributes: true, attributeFilter: ['style'] });
    else observer.observe(content);
    return () => {
      observer.disconnect();
      mutation.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [tabActive, loading, conversation?.id, visibleMessages.length, timelineEnabled]);

  // 历史窗口不追加实时消息；沿用服务端已排除自己的入站未读数，不用序号差猜条数。
  useEffect(() => {
    const previous = latestSeqRef.current;
    if (
      previous.conversationId === conversation?.id &&
      previous.seq &&
      latestMessageSeq &&
      /^\d+$/.test(previous.seq) &&
      /^\d+$/.test(latestMessageSeq) &&
      BigInt(latestMessageSeq) < BigInt(previous.seq)
    )
      return;
    const unread = Math.max(0, conversation?.unreadCount ?? 0);
    latestSeqRef.current = { conversationId: conversation?.id, seq: latestMessageSeq, unread };
    if (atLatest || previous.conversationId !== conversation?.id) return;
    const delta = unread - previous.unread;
    if (delta > 0) setNewMessagePill((count) => count + Math.min(delta, 100));
  }, [conversation?.id, conversation?.unreadCount, latestMessageSeq, atLatest]);

  useEffect(() => {
    if (!tabActive || !jumpRequest || loading || loadError) {
      setJumpMissing(false);
      if (!jumpRequest) locatedJump.current = undefined;
      return;
    }
    if (locatedJump.current === jumpRequest) return;
    const frame = requestAnimationFrame(() => {
      const scroll = messageScrollRef.current;
      const found = Boolean(scroll && revealTimelineMessage(scroll, jumpRequest.messageId, true));
      setJumpMissing(!found);
      if (!found) return;
      atBottomRef.current = false;
      readGestureUntil.current = 0;
      locatedJump.current = jumpRequest;
    });
    return () => cancelAnimationFrame(frame);
  }, [jumpRequest, loading, loadError, tabActive, visibleMessages]);

  function scrollMessagesToBottom() {
    const scroll = messageScrollRef.current;
    if (!scroll) {
      return;
    }
    readGestureUntil.current = 0;
    const viewport = timelineViewport(scroll);
    if (viewport) viewport.bottom();
    else scroll.scrollTop = scroll.scrollHeight;
    atBottomRef.current = true;
    bottomLayoutRef.current = {
      height: scroll.scrollHeight,
      viewportHeight: scroll.clientHeight,
      revision: viewport?.scrollRevision?.(),
    };
    lastScrollTopRef.current = scroll.scrollTop;
    setShowBottomJump(false);
    setNewMessagePill(0);
  }

  scrollMessagesToBottomRef.current = scrollMessagesToBottom;

  async function jumpAfterSuccessfulSend(sentConversation: Conversation) {
    if (
      timelineSettings?.jumpToLatestAfterSend === false ||
      readContextRef.current.conversation?.id !== sentConversation.id ||
      !readContextRef.current.tabActive
    )
      return;
    await jumpToBottomAndReadRef.current();
  }

  async function jumpToBottomAndRead() {
    if (jumpingToLatest) return;
    readGestureUntil.current = 0;
    if (!atLatest) {
      if (!onJumpToLatest) return;
      setJumpingToLatest(true);
      try {
        if (!(await onJumpToLatest())) return;
        // 等最新窗口提交后再定位；失败时保留提示，供用户重试。
        window.requestAnimationFrame(() => {
          const current = readContextRef.current;
          if (
            current.conversation?.id !== conversation?.id ||
            !current.atLatest ||
            !current.tabActive
          )
            return;
          scrollMessagesToBottomRef.current();
          requestReadAtBottom();
        });
      } finally {
        setJumpingToLatest(false);
      }
      return;
    }
    scrollMessagesToBottom();
    // 显式跳转后再按最新窗口/账号/可见性守卫发已读，不依赖后续滚动事件。
    requestReadAtBottom();
  }

  jumpToBottomAndReadRef.current = jumpToBottomAndRead;

  function isScrolledToBottom(tolerance = 48) {
    const scroll = messageScrollRef.current;
    if (!scroll) {
      return true;
    }
    // Tolerance covers sub-pixel rounding and short content.
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= tolerance;
  }

  function requestReadAtBottom() {
    const current = readContextRef.current;
    if (
      !current.onReadCurrentConversation ||
      readThroughViewport ||
      !current.conversation ||
      current.conversation.id !== conversation?.id ||
      !current.tabActive ||
      !current.atLatest ||
      current.loading ||
      !messageScrollRef.current ||
      document.visibilityState === 'hidden' ||
      !isScrolledToBottom(2)
    )
      return;
    const key = `${current.conversation.id}:${current.conversation.updatedAt}:${current.conversation.unreadCount}:${current.lastId}`;
    const now = performance.now();
    if (lastReadSignal.current.key === key && now - lastReadSignal.current.at < 300) return;
    lastReadSignal.current = { key, at: now };
    current.onReadCurrentConversation(current.conversation);
  }

  function handleReadGesture(event: { target: EventTarget | null }) {
    if (event.target instanceof Element && event.target.closest('.message-scroll'))
      readGestureUntil.current = performance.now() + READ_GESTURE_MS;
    requestReadAtBottom();
  }

  function handleMessageScroll() {
    if (!readContextRef.current.tabActive || document.visibilityState === 'hidden') return;
    const scroll = messageScrollRef.current;
    if (!scroll) return;
    const bottom = isScrolledToBottom();
    const layout = bottomLayoutRef.current;
    const revision = timelineViewport(scroll)?.scrollRevision?.();
    // 原生布局锚定也会派发 scroll；高度已变且没有新手势时，不当作用户离开底部。
    const bottomResized =
      atBottomRef.current &&
      layout !== null &&
      layout.height > 0 &&
      layout.viewportHeight > 0 &&
      layout.revision === revision &&
      (layout.height !== scroll.scrollHeight || layout.viewportHeight !== scroll.clientHeight);
    const delta = scroll.scrollTop - lastScrollTopRef.current;
    lastScrollTopRef.current = scroll.scrollTop;
    if (bottom && atLatest) setShowBottomJump(false);
    else if (Math.abs(delta) > 1) setShowBottomJump(delta > 0);
    if (
      !bottomResized &&
      (!bottom || !initialReadingPosition || readGestureUntil.current > performance.now())
    ) {
      atBottomRef.current = bottom;
    }
    if (bottom && atLatest)
      bottomLayoutRef.current = {
        height: scroll.scrollHeight,
        viewportHeight: scroll.clientHeight,
        revision,
      };
    if (bottom && readGestureUntil.current > performance.now()) requestReadAtBottom();
    if (bottom && atLatest && newMessagePill > 0) {
      setNewMessagePill(0);
    }
  }

  // ── 未读跳转坞 ──────────────────────────────────────────────────────────
  // 打开会话时上层已经把未读/高亮读进内存并清了库，这里只负责按顺序引导：
  // 每点一下跳一个目标（高亮按 seq 从大到小，最后是首条未读），
  // 跳完自动消失。
  const nextDockIndex = unreadDock?.stops.findIndex((stop) => !isVisited(stop)) ?? -1;
  const dockIndex = nextDockIndex < 0 ? (unreadDock?.stops.length ?? 0) : nextDockIndex;
  const dockStop = unreadDock?.stops[dockIndex] ?? null;
  const dockRemaining = unreadDock?.stops.filter((stop) => !isVisited(stop)).length ?? 0;
  const dockImportantRemaining =
    unreadDock?.stops.filter((stop) => stop.kind !== 'unread' && !isVisited(stop)).length ?? 0;

  const dockTargets = useMemo(() => {
    const pending = unreadDock?.stops.filter((stop) => !isVisited(stop));
    if (!pending?.length) return undefined;
    const pendingBySeq = new Map(pending.map((stop) => [stop.seq, stop]));
    const idsBySeq = new Map<string, string>();
    for (const message of messages) {
      const stop = message.msgSeq ? pendingBySeq.get(message.msgSeq) : undefined;
      if (
        stop &&
        stop.kind !== 'unread' &&
        !idsBySeq.has(stop.seq) &&
        matchesUnreadMessage(message, stop.seq, stop.identity)
      )
        idsBySeq.set(stop.seq, message.id);
    }
    const unreadSeq = pending.find((stop) => stop.kind === 'unread')?.seq;
    if (unreadSeq) {
      const id = unreadTimelineBoundary(visibleMessages, unreadSeq);
      if (id) idsBySeq.set(unreadSeq, id);
    }
    const seqsById = new Map<string, string[]>();
    for (const [seq, id] of idsBySeq) {
      const seqs = seqsById.get(id);
      if (seqs) seqs.push(seq);
      else seqsById.set(id, [seq]);
    }
    return seqsById;
  }, [messages, visibleMessages, unreadDock, isVisited]);
  const interactionConversationId = conversation?.id;
  const interactionConversationType = conversation?.type;
  const interactionTargets = useMemo(() => {
    if (
      !pendingInteractions?.length ||
      !interactionConversationId ||
      interactionConversationType === 'merged'
    )
      return;
    const kind = interactionConversationType === 'group' ? 'group' : 'c2c';
    const pending = new Map(
      pendingInteractions
        .filter((event) => event.kind === kind && event.conv === interactionConversationId)
        .map((event) => [`${event.action}:${event.msgId}`, event]),
    );
    if (!pending.size) return;
    const targets = new Map<string, string[]>();
    for (const message of visibleMessages) {
      if (!message.msgId || message.conversationId !== interactionConversationId) continue;
      const recall = pending.get(`recall:${message.msgId}`);
      const poke = pending.get(`poke:${message.msgId}`);
      const seqless = pending.get(`seqless:${message.msgId}`);
      const ids: string[] = [];
      if (
        recall &&
        (message.recall || message.qqElements?.some(({ type }) => type === 'grayTipRevoke'))
      )
        ids.push(conversationInteractionId(recall));
      if (
        poke &&
        message.qqElements?.some(({ type }) => type === 'grayTipPoke' || type === 'grayTipXml')
      )
        ids.push(conversationInteractionId(poke));
      if (seqless) ids.push(conversationInteractionId(seqless));
      if (ids.length) targets.set(message.id, ids);
    }
    const knownLatestSeq =
      latestMessageSeq && /^[1-9]\d*$/.test(latestMessageSeq) ? BigInt(latestMessageSeq) : 0n;
    const latest =
      atLatest && !loadError
        ? visibleMessages.findLast(
            (message) =>
              message.conversationId === interactionConversationId &&
              message.msgId &&
              !message.optimistic &&
              (!message.source || message.ntSeqVerified) &&
              (knownLatestSeq === 0n ||
                (message.msgSeq &&
                  /^\d+$/.test(message.msgSeq) &&
                  BigInt(message.msgSeq) >= knownLatestSeq)),
          )
        : undefined;
    const banners = [...pending.values()]
      .filter((event) => event.bannerPending)
      .map(conversationInteractionId);
    return {
      targets,
      latestBannerTarget: latest && banners.length ? { id: latest.id, banners } : undefined,
    };
  }, [
    atLatest,
    interactionConversationId,
    interactionConversationType,
    latestMessageSeq,
    loadError,
    pendingInteractions,
    visibleMessages,
  ]);

  const entryPending = unreadDock === undefined && Boolean(onReadCurrentConversation);
  const observeMessageVisibility = useCallback((): TimelineVisibility | undefined => {
    const scroll = messageScrollRef.current;
    if (
      !tabActive ||
      !scroll ||
      !visibleMessages.length ||
      (!entryPending && (loading || loadingNewer))
    )
      return;
    const unreadSeq = unreadDock?.stops.find((stop) => stop.kind === 'unread')?.seq;
    if (dockTargets && unreadSeq)
      for (const [id, seqs] of dockTargets)
        if (entryVisibility.ids.has(id) && seqs.includes(unreadSeq)) {
          visitStops(navigationKey, [unreadSeq]);
          break;
        }
    const observeRead = viewportReadEnabled && !loading && !loadingNewer;
    if (
      !entryPending &&
      !observeRead &&
      !dockTargets?.size &&
      !interactionTargets?.targets.size &&
      !interactionTargets?.latestBannerTarget
    )
      return;
    let rows = new Map<Element, ObservedTimelineRow>();
    const clearVisibleRead = () => {
      viewportRead.visible.clear();
      viewportRead.scrollTop = undefined;
    };
    const sampleViewport = () => {
      const current = readContextRef.current;
      if (
        !current.tabActive ||
        !current.conversation ||
        current.conversation.id !== conversation?.id ||
        document.visibilityState === 'hidden' ||
        !document.hasFocus()
      ) {
        clearVisibleRead();
        return;
      }
      const bounds = scroll.getBoundingClientRect();
      if (bounds.height <= 0) return;
      const scrollTop = scroll.scrollTop;
      const forward =
        viewportRead.scrollTop !== undefined &&
        scrollTop > viewportRead.scrollTop &&
        readGestureUntil.current > performance.now();
      const atBottom =
        current.atLatest &&
        !loadError &&
        scroll.scrollHeight - scrollTop - scroll.clientHeight <= 2;
      const previous = viewportRead.visible;
      const visible = new Map<string, ViewportReadRow>();
      const { ready } = viewportRead;
      if (confirmedWatermark !== viewportRead.watermark) {
        if (
          viewportRead.watermark !== undefined &&
          confirmedWatermark !== undefined &&
          confirmedWatermark < viewportRead.watermark
        ) {
          ready.clear();
          previous.clear();
        } else if (confirmedWatermark !== undefined) {
          for (const seq of ready) if (BigInt(seq) <= confirmedWatermark) ready.delete(seq);
        }
        viewportRead.watermark = confirmedWatermark;
      }
      const confirm = (seq: string) => {
        if (
          confirmedWatermark === undefined ||
          BigInt(seq) > confirmedWatermark ||
          (seq === confirmedReadSeq &&
            seq === latestMessageSeq &&
            Boolean(current.conversation?.unreadCount))
        )
          ready.add(seq);
      };
      for (const [target, { id, seq, readable }] of rows) {
        if (!seq) continue;
        const rect = target.getBoundingClientRect();
        const shown = Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top);
        if (entryPending && shown > 0) {
          entryVisibility.ids.add(id);
          entryVisibility.sequences.add(seq);
        }
        if (!readable || !current.viewportReadEnabled) continue;
        const seen = previous.get(id)?.seq === seq;
        previous.delete(id);
        if (seen && forward && rect.bottom <= bounds.top) confirm(seq);
        // 看到足够内容后持续追踪，直到整条消息从视口上沿滑出。
        if (shown > 0 && (seen || shown >= Math.min(rect.height, bounds.height) / 2)) {
          visible.set(id, { seq, bottom: rect.bottom - bounds.top + scrollTop });
          if (atBottom) confirm(seq);
        }
      }
      if (!observeRead || !current.viewportReadEnabled) return;
      if (forward) {
        // 虚拟列表可能先卸载刚滑出的行，使用上一帧实际测得的下沿。
        for (const [id, row] of previous)
          if (
            row.bottom <= scrollTop &&
            visibleMessages.some((message) => message.id === id && message.msgSeq === row.seq)
          )
            confirm(row.seq);
      }
      viewportRead.visible = visible;
      viewportRead.scrollTop = scrollTop;
      if (!ready.size) return;
      const key = `${viewportReadVersion}:${ready.size}`;
      if (viewportRead.lastReport === key) return;
      viewportRead.lastReport = key;
      // 提交最早的已读候选，后续视口可补上跳转留下的缺口。
      const sequences = [...ready]
        .sort((a, b) => a.length - b.length || a.localeCompare(b))
        .slice(0, 512);
      current.onReadCurrentConversation?.(current.conversation, sequences);
    };
    let readFrame: number | undefined;
    const scheduleRead = () => {
      if ((!observeRead && !entryPending) || readFrame !== undefined) return;
      readFrame = window.requestAnimationFrame(() => {
        readFrame = undefined;
        sampleViewport();
      });
    };
    const onViewportScroll = () => {
      const now = performance.now();
      if (observeRead && readGestureUntil.current > now)
        readGestureUntil.current = now + READ_GESTURE_MS;
      scheduleRead();
    };
    const report = (rows: string[]) => {
      visitStops(
        navigationKey,
        rows.flatMap((id) => dockTargets?.get(id) ?? []),
      );
      if (!interactionTargets || document.visibilityState === 'hidden' || !document.hasFocus())
        return;
      const visible = rows.flatMap((id) => interactionTargets.targets.get(id) ?? []);
      if (visible.length) onSeeInteractions?.(visible);
      const latest = interactionTargets.latestBannerTarget;
      if (latest && rows.includes(latest.id)) {
        const banners = latest.banners.filter((id) => !visible.includes(id));
        if (banners.length) onSeeInteractions?.(banners, true);
      }
    };
    const probe = () => {
      if (entryPending) sampleViewport();
      else scheduleRead();
      if (!dockTargets?.size && !interactionTargets) return;
      const bounds = scroll.getBoundingClientRect();
      if (bounds.height <= 0) return;
      const seen: string[] = [];
      for (const [target, { id, report: shouldReport }] of rows) {
        if (!shouldReport) continue;
        const rect = target.getBoundingClientRect();
        if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom) seen.push(id);
      }
      report(seen);
    };
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? undefined
        : new IntersectionObserver(
            (entries) => {
              scheduleRead();
              report(
                entries.flatMap(({ target, intersectionRatio }) => {
                  const row = rows.get(target);
                  return intersectionRatio > 0 && row?.report ? [row.id] : [];
                }),
              );
            },
            {
              root: scroll,
              threshold: observeRead ? [Number.EPSILON, 0.5] : Number.EPSILON,
            },
          );
    let initialSync = true;
    const syncRows = () => {
      const next = new Map<Element, ObservedTimelineRow>();
      for (const target of scroll.querySelectorAll<HTMLElement>('[data-message-id]')) {
        const existing = rows.get(target);
        if (existing && existing.id === target.dataset.messageId) {
          next.set(target, existing);
          continue;
        }
        const id = target.dataset.messageId ?? '';
        const shouldReport = Boolean(
          dockTargets?.has(id) ||
            interactionTargets?.targets.has(id) ||
            interactionTargets?.latestBannerTarget?.id === id,
        );
        let seq: string | undefined;
        let readable = false;
        if (entryPending || observeRead) {
          const index = target.closest<HTMLElement>('.weq-virtual-timeline-row')?.dataset.index;
          const message = index === undefined ? undefined : visibleMessages[Number(index)];
          if (
            message?.id === id &&
            message.conversationId === conversation?.id &&
            !message.optimistic &&
            (!message.source || message.ntSeqVerified) &&
            message.msgSeq &&
            /^[1-9]\d{0,19}$/.test(message.msgSeq)
          ) {
            seq = message.msgSeq;
            readable =
              observeRead && Boolean(message.msgId) && target.classList.contains('message-line');
          }
        }
        if (shouldReport || seq) next.set(target, { id, report: shouldReport, seq, readable });
      }
      for (const target of rows.keys()) if (!next.has(target)) observer?.unobserve(target);
      for (const target of next.keys()) if (!rows.has(target)) observer?.observe(target);
      rows = next;
      // 预挂载不等于可见。首次及无观察器时直接检查，滚动时复用原有订阅。
      if (initialSync || !observer) probe();
      else if (entryPending) sampleViewport();
      else scheduleRead();
      initialSync = false;
    };
    if (observeRead || entryPending)
      scroll.addEventListener('scroll', onViewportScroll, { passive: true });
    if (interactionTargets || observeRead || entryPending) {
      window.addEventListener('focus', probe);
      window.addEventListener('blur', clearVisibleRead);
      document.addEventListener('visibilitychange', probe);
    }
    return {
      syncRows,
      dispose: () => {
        observer?.disconnect();
        observer?.takeRecords();
        scroll.removeEventListener('scroll', onViewportScroll);
        if (readFrame !== undefined) window.cancelAnimationFrame(readFrame);
        window.removeEventListener('focus', probe);
        window.removeEventListener('blur', clearVisibleRead);
        document.removeEventListener('visibilitychange', probe);
      },
    };
  }, [
    loading,
    loadingNewer,
    navigationKey,
    conversation?.id,
    confirmedReadSeq,
    confirmedWatermark,
    entryPending,
    entryVisibility,
    latestMessageSeq,
    loadError,
    tabActive,
    unreadDock,
    viewportRead,
    viewportReadEnabled,
    viewportReadVersion,
    dockTargets,
    interactionTargets,
    onSeeInteractions,
    visibleMessages,
    visitStops,
  ]);
  const dockVisible = Boolean(dockStop);

  async function jumpDockStop(): Promise<boolean> {
    if (!dockStop || !unreadDock || dockTask.current) return false;
    const task = {};
    dockTask.current = task;
    setDockJumping(true);
    try {
      const found = await jumpToSeq({
        seq: dockStop.seq,
        ...(dockStop.kind === 'unread'
          ? { mode: 'firstUnread' as const }
          : dockStop.identity
            ? { importantMessage: dockStop.identity }
            : {}),
      });
      return found && dockTask.current === task;
    } catch (err) {
      console.error('[unread-dock] jump failed', err);
      return false;
    } finally {
      if (dockTask.current === task) {
        dockTask.current = null;
        setDockJumping(false);
      }
    }
  }
  return {
    leaveBottom: () => {
      atBottomRef.current = false;
    },
    dockIndex,
    dockRemaining,
    dockImportantRemaining,
    locatedSeq,
    dockJumping,
    dockStop,
    dockVisible,
    endRef,
    handleMessageScroll,
    handleReadGesture,
    isScrolledToBottom,
    jumpAfterSuccessfulSend,
    jumpDockStop,
    jumpMissing,
    jumpToBottomAndRead,
    jumpToSeq,
    jumpingToLatest,
    messageScrollRef,
    newMessagePill,
    isActiveConversation: (id: string | undefined) =>
      readContextRef.current.conversation?.id === id && readContextRef.current.tabActive,
    resetReadGesture: () => {
      readGestureUntil.current = 0;
    },
    requestReadAtBottom,
    showBottomJump,
    timelineEnabled,
    timelineContentRef,
    observeMessageVisibility,
  };
}
