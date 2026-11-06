import { useVirtualTimeline } from '../../hooks/useVirtualTimeline';
import { timelineViewport } from '../../lib/timelineViewport';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReplyJumpTarget } from '../../components/QqMessageContent';
import { restoreReadingPosition } from '../../lib/conversationReadingPosition';
import type { Conversation, Message } from './types';
import type { ChatPaneProps } from './chatPane';
import {
  type UnreadJumpState,
  type UnreadJumpSeed,
  countAppendedMessages,
} from './chatTimelineModel';

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
  onReadCurrentConversation,
  parentJumpToSeq,
  selectionOrder,
  tabActive,
  unreadDock,
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
  onReadCurrentConversation: ChatPaneProps['onReadCurrentConversation'];
  parentJumpToSeq: (target: ReplyJumpTarget) => void | Promise<void>;
  selectionOrder: string[];
  tabActive: boolean;
  unreadDock: ChatPaneProps['unreadDock'];
  user: ChatPaneProps['user'];
  visibleMessages: Message[];
}) {
  const [jumpMissing, setJumpMissing] = useState(false);

  const locatedJump = useRef<typeof jumpRequest>(undefined);

  const [unreadJump, setUnreadJump] = useState<UnreadJumpState | null>(null);

  // 未读跳转坞：当前跳到第几个跳转点（越界即整串收起）。换了会话就归零。
  const [dockIndex, setDockIndex] = useState(0);

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

  const jumpToSeq = useCallback(
    (target: ReplyJumpTarget) => {
      // 滚动事件晚于消息刷新提交；先退出贴底，避免原消息刚定位就被刷新拉回末尾。
      atBottomRef.current = false;
      readGestureUntil.current = 0;
      return parentJumpToSeq(target);
    },
    [parentJumpToSeq],
  );

  const lastReadSignal = useRef({ key: '', at: 0 });

  const readContextRef = useRef({
    tabActive,
    atLatest,
    loading,
    conversation,
    onReadCurrentConversation,
    lastId: messages.at(-1)?.id,
  });

  readContextRef.current = {
    tabActive,
    atLatest,
    loading,
    conversation,
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

  const unreadSeedRef = useRef<UnreadJumpSeed | null>(null);

  const unreadConversationRef = useRef<string | null>(null);

  const unreadScrollFrameRef = useRef<number | null>(null);

  // 换会话（或上层重下了新的一份快照）时，跳转坞从第一个跳转点重新开始。
  useEffect(() => {
    setDockIndex(0);
  }, [conversation?.id, unreadDock]);

  const timelineIds = useMemo(
    () => visibleMessages.map((message) => message.id),
    [visibleMessages],
  );

  const timeline = useVirtualTimeline({
    ids: timelineIds,
    orderedIds: selectionOrder,
    scrollRef: messageScrollRef,
    // 数据源切换由宿主 ChatMainContent 的 messageScope key 重新挂载；不绑定按需加载的撤回资料。
    scope: `${user.id}:${conversation?.id}`,
    active: tabActive,
  });

  // 下面几个 effect 只该在会话/消息变化时跑，但正文里要调用这些每次渲染都重建的
  // 函数。用 ref 转发拿最新实现，避免把它们塞进依赖导致 effect 每次渲染重跑。
  const scrollMessagesToBottomRef = useRef<() => void>(() => {});

  const jumpToBottomAndReadRef = useRef<() => Promise<void>>(async () => {});

  const updateUnreadJumpRemainingRef = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const conversationId = conversation?.id ?? null;
    if (unreadConversationRef.current === conversationId) {
      return;
    }

    unreadConversationRef.current = conversationId;
    setUnreadJump(null);
    const total = Math.max(0, conversation?.unreadCount ?? 0);
    unreadSeedRef.current =
      conversationId && total > 0
        ? {
            conversationId,
            total,
          }
        : null;
  }, [conversation?.id, conversation?.unreadCount]);

  useLayoutEffect(() => {
    const seed = unreadSeedRef.current;
    if (
      !seed ||
      seed.conversationId !== conversation?.id ||
      loading ||
      visibleMessages.length === 0
    ) {
      return;
    }

    const total = Math.min(seed.total, visibleMessages.length);
    unreadSeedRef.current = null;
    setUnreadJump(
      total > 0
        ? {
            conversationId: seed.conversationId,
            remaining: total,
            total,
          }
        : null,
    );
  }, [conversation?.id, loading, visibleMessages]);

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
    const observer = new ResizeObserver(() => {
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
    });
    observer.observe(scroll);
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [tabActive, loading, conversation?.id, visibleMessages.length]);

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

  // updateUnreadJumpRemaining 会写回 unreadJump.remaining，所以这里只认「换会话 /
  // 换未读总数」这两个稳定信号，不能整体依赖 unreadJump，否则每次滚动都要多跑一轮。
  const unreadJumpKey = unreadJump ? `${unreadJump.conversationId}:${unreadJump.total}` : null;

  useLayoutEffect(() => {
    if (!tabActive || !unreadJumpKey) {
      return;
    }

    updateUnreadJumpRemainingRef.current();
    const frame = window.requestAnimationFrame(() => updateUnreadJumpRemainingRef.current());
    return () => window.cancelAnimationFrame(frame);
  }, [tabActive, unreadJumpKey, visibleMessages, loading]);

  useEffect(
    () => () => {
      if (unreadScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(unreadScrollFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!jumpRequest || loading || loadError) {
      setJumpMissing(false);
      if (!jumpRequest) locatedJump.current = undefined;
      return;
    }
    if (locatedJump.current === jumpRequest) return;
    const frame = requestAnimationFrame(() => {
      const target = [
        ...(messageScrollRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []),
      ].find((node) => node.dataset.messageId === jumpRequest.messageId);
      setJumpMissing(!target);
      if (target) locatedJump.current = jumpRequest;
      target?.scrollIntoView({ block: 'center', behavior: 'instant' });
    });
    return () => cancelAnimationFrame(frame);
  }, [jumpRequest, loading, loadError, messages]);

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
      readGestureUntil.current = performance.now() + 1000;
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

    if (!unreadJump || unreadScrollFrameRef.current !== null) {
      return;
    }

    unreadScrollFrameRef.current = window.requestAnimationFrame(() => {
      unreadScrollFrameRef.current = null;
      updateUnreadJumpRemaining();
    });
  }

  function updateUnreadJumpRemaining() {
    const scroll = messageScrollRef.current;
    if (!scroll || !unreadJump) {
      return;
    }

    const firstUnread = unreadMessageElements(unreadJump)[0];
    const unreadId = visibleMessages[Math.max(0, visibleMessages.length - unreadJump.total)]?.id;
    const virtualOffset = unreadId ? timelineViewport(scroll)?.offset(unreadId) : undefined;
    if (!firstUnread && virtualOffset === undefined) {
      setUnreadJump(null);
      return;
    }

    const scrollRect = scroll.getBoundingClientRect();
    const firstUnreadTop =
      virtualOffset !== undefined
        ? scrollRect.top + virtualOffset - scroll.scrollTop
        : (firstUnread?.getBoundingClientRect().top ?? scrollRect.top);
    const targetScrollTop =
      unreadJump.targetScrollTop ??
      Math.max(0, scroll.scrollTop + firstUnreadTop - scrollRect.top - 12);
    const startScrollTop = unreadJump.startScrollTop ?? scroll.scrollTop;

    if (targetScrollTop >= startScrollTop - 1 || scroll.scrollTop <= targetScrollTop + 1) {
      setUnreadJump(null);
      return;
    }

    const progress = (scroll.scrollTop - targetScrollTop) / (startScrollTop - targetScrollTop);
    const remaining = Math.max(1, Math.ceil(unreadJump.total * Math.min(1, progress)));

    setUnreadJump((current) => {
      if (!current || current.conversationId !== unreadJump.conversationId) {
        return current;
      }
      return current.remaining === remaining &&
        current.startScrollTop === startScrollTop &&
        current.targetScrollTop === targetScrollTop
        ? current
        : {
            ...current,
            remaining,
            startScrollTop,
            targetScrollTop,
          };
    });
  }

  updateUnreadJumpRemainingRef.current = updateUnreadJumpRemaining;

  function unreadMessageElements(state = unreadJump) {
    const scroll = messageScrollRef.current;
    if (!scroll || !state) {
      return [];
    }

    const ids = new Set(visibleMessages.slice(-state.total).map((message) => message.id));

    return Array.from(
      scroll.querySelectorAll<HTMLElement>('.message-line[data-message-id]'),
    ).filter((element) => ids.has(element.dataset.messageId ?? ''));
  }

  function jumpToFirstUnreadMessage() {
    const scroll = messageScrollRef.current;
    const id =
      unreadJump && visibleMessages[Math.max(0, visibleMessages.length - unreadJump.total)]?.id;
    if (scroll && id && timelineViewport(scroll)?.scrollTo(id, { align: 'start' })) {
      setUnreadJump(null);
      return;
    }
    const firstUnread = unreadMessageElements()[0];
    if (!firstUnread) {
      setUnreadJump(null);
      return;
    }

    firstUnread.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
    setUnreadJump(null);
  }

  // ── 未读跳转坞 ──────────────────────────────────────────────────────────
  // 打开会话时上层已经把未读/高亮读进内存并清了库，这里只负责按顺序引导：
  // 每点一下跳一个目标（高亮按 seq 从大到小，最后是「新的 N 条未读消息」），
  // 跳完自动消失。
  const dockStop = unreadDock?.stops[dockIndex] ?? null;

  const dockVisible = Boolean(dockStop);

  async function jumpDockStop(): Promise<void> {
    if (!dockStop || !unreadDock) return;
    const nextIndex = dockIndex + 1;
    // 先推进游标再跳：跳转要走「快慢路径」（可能要重建窗口、异步），期间用户
    // 再点应该是下一条，而不是重跳当前这条。
    setDockIndex(nextIndex);
    try {
      await jumpToSeq({ seq: dockStop.seq });
    } catch (err) {
      console.error('[unread-dock] jump failed', err);
    }
  }
  return {
    leaveBottom: () => {
      atBottomRef.current = false;
    },
    dockIndex,
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
    jumpToFirstUnreadMessage,
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
    clearUnreadJump: () => setUnreadJump(null),
    showBottomJump,
    timeline,
    timelineContentRef,
    unreadJump,
  };
}
