import {
  Component,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { useVirtualTimeline } from '../../hooks/useVirtualTimeline';
import { estimateTimelineRowHeight } from '../../lib/timelinePreload';
import type { Message } from './types';
import type { MessageGroupPosition } from './chatTimelineModel';
import { timelineViewport, TIMELINE_MESSAGE_SELECTOR } from '../../lib/timelineViewport';
import { restoreReadingPosition } from '../../lib/conversationReadingPosition';
import { allowsLayoutMotion, RowLayoutMotion, visibleLayoutRows } from '../../lib/layoutMotion';

export type TimelineVisibility = {
  syncRows: () => void;
  dispose: () => void;
};

type ChatTimelineProps = {
  messages: Message[];
  gaps: ReadonlyMap<string, { id: string }>;
  groupPositions?: readonly (MessageGroupPosition | undefined)[];
  orderedIds: string[];
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  scope: string;
  active: boolean;
  live: boolean;
  followLive: boolean;
  loading: boolean;
  jumpRevision?: number;
  deleted: ReadonlySet<string>;
  isHidden: (id: string) => boolean;
  unreadBoundary?: string;
  observeMessageVisibility: () => TimelineVisibility | undefined;
  children: (
    timeline: Pick<ReturnType<typeof useVirtualTimeline>, 'enabled' | 'items' | 'measure'>,
    captureContent: (element: HTMLDivElement | null) => void,
    rowSpacing: (index: number) => number,
  ) => ReactNode;
};

const messageKey = (message: Message) => message.outgoingId ?? message.id;
const timelineRow = (element: HTMLElement) =>
  element.closest<HTMLDivElement>('.weq-virtual-timeline-row');
const timelineKey = (element: HTMLElement) => timelineRow(element)?.dataset.weqMotionKey;

// 抓取正文而不是虚拟行顶；同一行内部的缺口和未读分隔也会推移正文。
class ChatTimelineTransition extends Component<ChatTimelineProps> {
  private readonly motion = new RowLayoutMotion();

  override getSnapshotBeforeUpdate(previous: ChatTimelineProps) {
    const {
      active,
      scope,
      gaps,
      scrollRef,
      messages,
      loading,
      live,
      followLive,
      jumpRevision,
      deleted,
      isHidden,
      unreadBoundary,
    } = this.props;
    const scroll = scrollRef.current;
    if (!active || !previous.active || scope !== previous.scope || !scroll?.clientHeight)
      return null;
    const edits =
      !loading &&
      !previous.loading &&
      jumpRevision === previous.jumpRevision &&
      (messages !== previous.messages ||
        deleted !== previous.deleted ||
        isHidden !== previous.isHidden ||
        unreadBoundary !== previous.unreadBoundary);
    const changed = new Set<string>();
    const changedGapIds = new Set<string>();
    if (gaps !== previous.gaps) {
      for (const [id, gap] of previous.gaps) {
        if (gaps.get(id)?.id === gap.id) continue;
        changed.add(id);
        changedGapIds.add(gap.id);
      }
      for (const [id, gap] of gaps) if (previous.gaps.get(id)?.id !== gap.id) changed.add(id);
    }
    if (!changed.size && !edits) return null;
    const bounds = scroll.getBoundingClientRect();
    const rows = visibleLayoutRows(scroll, TIMELINE_MESSAGE_SELECTOR, timelineKey, bounds);
    const states = new Map(
      [...rows].map(([key, { element }]) => [key, timelineRow(element)?.dataset.weqMotionState]),
    );
    const removed =
      edits &&
      [...rows.values()].some(
        ({ element }) =>
          isHidden(element.dataset.messageId!) && !previous.isHidden(element.dataset.messageId!),
      );
    const removedVisibleGap =
      changedGapIds.size > 0 &&
      visibleLayoutRows(
        scroll,
        '.weq-gap-band-button',
        (button) => {
          const id = button.closest<HTMLElement>('[data-message-id]')?.dataset.messageId;
          return id && changedGapIds.has(id) ? id : undefined;
        },
        bounds,
      ).size > 0;
    const atEnd = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 2;
    const viewport = timelineViewport(scroll);
    let tail: readonly Message[] = [];
    if (
      edits &&
      live &&
      previous.live &&
      followLive &&
      atEnd &&
      !viewport?.isUserScrolling?.() &&
      allowsLayoutMotion(scroll) &&
      messages !== previous.messages
    ) {
      const last = previous.messages.at(-1);
      const index = last
        ? messages.findLastIndex((message) => messageKey(message) === messageKey(last))
        : -1;
      const appended = messages.length - index - 1;
      // 不把大批同步、整窗切换或解除隐藏当作新的实时气泡。
      if ((!last || index >= 0) && appended > 0 && appended <= 3)
        tail = messages.slice(index + 1).filter(({ id }) => !previous.isHidden(id));
    }
    return {
      rows,
      states,
      edits,
      removed,
      changed,
      removedVisibleGap,
      tail,
      revision: viewport?.scrollRevision?.(),
      atEnd,
    };
  }

  override componentDidUpdate(
    previous: ChatTimelineProps,
    _state: unknown,
    snapshot: ReturnType<ChatTimelineTransition['getSnapshotBeforeUpdate']>,
  ) {
    const { active, scope, loading, live, jumpRevision, scrollRef, unreadBoundary } = this.props;
    const scroll = scrollRef.current;
    if (
      !active ||
      scope !== previous.scope ||
      jumpRevision !== previous.jumpRevision ||
      loading ||
      (scroll && !allowsLayoutMotion(scroll))
    )
      this.motion.stop();
    if (!snapshot || !scroll) return;
    const viewport = timelineViewport(scroll);
    const mounted = new Map<string, HTMLElement>();
    const affectedRows = new Set<HTMLDivElement>();
    const reveal = new Map<string, HTMLElement>();
    let edited = snapshot.removed;
    for (const element of scroll.querySelectorAll<HTMLElement>(TIMELINE_MESSAGE_SELECTOR)) {
      const wrapper = timelineRow(element);
      const key = wrapper?.dataset.weqMotionKey;
      if (!wrapper || key === undefined) continue;
      mounted.set(key, element);
      const id = element.dataset.messageId!;
      if (snapshot.changed.has(id)) affectedRows.add(wrapper);
      if (!snapshot.edits) continue;
      const state = wrapper.dataset.weqMotionState;
      const old = snapshot.rows.get(key);
      if (
        (old && snapshot.states.get(key) !== state) ||
        (!old &&
          (previous.isHidden(id) ||
            (state === 'recall-tip' &&
              live &&
              previous.live &&
              !previous.messages.some((message) => messageKey(message) === key))))
      ) {
        edited = true;
        affectedRows.add(wrapper);
        const hint =
          state === 'deleted'
            ? element.querySelector<HTMLElement>('.weq-msg-deleted-veil')
            : state === 'recalled'
              ? element.querySelector<HTMLElement>('.weq-msg-recall-tag')
              : null;
        if (hint || state === 'recall-tip' || !old || snapshot.states.get(key) === 'deleted')
          reveal.set(key, hint ?? element);
      }
      if (
        unreadBoundary !== previous.unreadBoundary &&
        (id === unreadBoundary || id === previous.unreadBoundary)
      ) {
        edited = true;
        affectedRows.add(wrapper);
        const divider = wrapper.querySelector<HTMLElement>('.weq-unread-divider');
        if (divider && !reveal.has(key)) reveal.set(key, divider);
      }
    }
    const reflow = snapshot.changed.size > 0 || edited;
    if (reflow) {
      this.motion.stop();
      const anchor = [...snapshot.rows].find(([key]) => mounted.has(key));
      const anchorElement = anchor && mounted.get(anchor[0]);
      // 同帧交付新行高，别等下一轮 ResizeObserver 才补偿阅读位置。
      if (edited) {
        for (const key of snapshot.rows.keys()) {
          const element = mounted.get(key);
          const wrapper = element && timelineRow(element);
          if (wrapper) affectedRows.add(wrapper);
        }
      }
      const anchorRow = anchorElement && timelineRow(anchorElement);
      viewport?.measureRows?.(
        affectedRows,
        !snapshot.atEnd && anchorElement && snapshot.changed.has(anchorElement.dataset.messageId!)
          ? anchorRow
          : null,
      );
      if (snapshot.revision !== viewport?.scrollRevision?.()) return;
      if (anchor && anchorElement && !snapshot.atEnd && !viewport?.isUserScrolling?.()) {
        restoreReadingPosition(scroll, {
          anchorId: anchorElement.dataset.messageId,
          offset: anchor[1].top,
          scrollTop: scroll.scrollTop,
        });
      }
    }
    if (snapshot.revision !== viewport?.scrollRevision?.()) return;
    if (
      loading ||
      jumpRevision !== previous.jumpRevision ||
      !allowsLayoutMotion(scroll) ||
      viewport?.isUserScrolling?.()
    )
      return;
    const oldIds = snapshot.removedVisibleGap ? new Set(previous.messages.map(messageKey)) : null;
    const tailKeys = new Set(snapshot.tail.map(messageKey));
    if (reflow) {
      const visible = visibleLayoutRows(scroll, TIMELINE_MESSAGE_SELECTOR, timelineKey);
      const fillsGap = oldIds && [...visible.keys()].some((key) => !oldIds.has(key));
      const shiftLimit = snapshot.removed
        ? Math.max(72, Math.min(144, scroll.clientHeight / 4))
        : 72;
      let fadedAfterRemoval = 0;
      for (const [key, { element, top }] of visible) {
        const old = snapshot.rows.get(key);
        const hint = reveal.get(key);
        // 补回大段历史时不让旧消息滑过新内容，也不反复量动画中的行高。
        if (old && !fillsGap && hint !== element) {
          const shift = old.top - top;
          this.motion.shift(element, shift, shiftLimit);
          if (snapshot.removed && !hint && shift > shiftLimit && fadedAfterRemoval < 2) {
            this.motion.reveal(element);
            fadedAfterRemoval++;
          }
        }
        if (hint) this.motion.reveal(hint);
        else if (oldIds && !oldIds.has(key)) this.motion.reveal(element);
        if (hint || (oldIds && !oldIds.has(key))) tailKeys.delete(key);
      }
    }
    // 父层在本次布局末尾跟随下沿；此时新行可能还在视口下面的缓冲内。
    for (const key of tailKeys) {
      const element = mounted.get(key);
      if (element && !snapshot.rows.has(key)) this.motion.reveal(element);
    }
  }

  override componentWillUnmount() {
    this.motion.stop();
  }

  override render() {
    return <ChatTimelineContent {...this.props} />;
  }
}

export function ChatTimeline(props: ChatTimelineProps) {
  return <ChatTimelineTransition {...props} />;
}

function ChatTimelineContent({
  messages,
  groupPositions,
  orderedIds,
  scrollRef,
  contentRef,
  scope,
  active,
  observeMessageVisibility,
  children,
}: ChatTimelineProps) {
  const ids = useMemo(() => messages.map(({ id }) => id), [messages]);
  const keys = useMemo(() => messages.map(messageKey), [messages]);
  const rowSpacing = useCallback(
    (index: number) => {
      if (index === messages.length - 1) return 0;
      const position = groupPositions?.[index];
      return position === 'first' || position === 'middle' ? 4 : 18;
    },
    [groupPositions, messages.length],
  );
  const estimateSize = useCallback(
    (index: number) => estimateTimelineRowHeight(messages[index]) + rowSpacing(index),
    [messages, rowSpacing],
  );
  const timeline = useVirtualTimeline({
    ids,
    keys,
    orderedIds,
    scrollRef,
    scope,
    active,
    estimateSize,
  });
  const { containerRef } = timeline;
  const captureContent = useCallback(
    (element: HTMLDivElement | null) => {
      contentRef.current = element;
      containerRef(element);
    },
    [contentRef, containerRef],
  );
  const renderedItems = timeline.enabled ? timeline.items : null;
  const visibility = useRef<TimelineVisibility | undefined>(undefined);
  useLayoutEffect(
    () => () => {
      visibility.current?.dispose();
      visibility.current = undefined;
    },
    [observeMessageVisibility],
  );
  useLayoutEffect(() => {
    // 父层布局 effect 可能会先定位到底部或恢复阅读位置，再据此报告可见消息。
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (!visibility.current) visibility.current = observeMessageVisibility();
      visibility.current?.syncRows();
    });
    return () => {
      cancelled = true;
    };
  }, [observeMessageVisibility, renderedItems]);
  return children(timeline, captureContent, rowSpacing);
}
