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
  observeMessageVisibility: () => TimelineVisibility | undefined;
  children: (
    timeline: Pick<ReturnType<typeof useVirtualTimeline>, 'enabled' | 'items' | 'measure'>,
    captureContent: (element: HTMLDivElement | null) => void,
    rowSpacing: (index: number) => number,
  ) => ReactNode;
};

function visibleTimelineRows(scroll: HTMLElement, bounds: DOMRect) {
  const rows = new Map<string, { element: HTMLElement; top: number }>();
  for (const element of scroll.querySelectorAll<HTMLElement>(TIMELINE_MESSAGE_SELECTOR)) {
    const rect = element.getBoundingClientRect();
    if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom)
      rows.set(element.dataset.messageId!, { element, top: rect.top - bounds.top });
  }
  return rows;
}

// 抓取 React 改动 DOM 前的真实气泡位置；虚拟行的顶部还包括缺口条，不一定等于正文位置。
class ChatTimelineGapTransition extends Component<ChatTimelineProps> {
  private animations = new Set<Animation>();

  override getSnapshotBeforeUpdate(previous: ChatTimelineProps) {
    const { active, scope, gaps, scrollRef } = this.props;
    const scroll = scrollRef.current;
    if (!active || !previous.active || scope !== previous.scope || !scroll?.clientHeight)
      return null;
    if (gaps === previous.gaps || (!gaps.size && !previous.gaps.size)) return null;
    const changed = new Set<string>();
    const changedGapIds = new Set<string>();
    for (const [id, gap] of previous.gaps) {
      if (gaps.get(id)?.id === gap.id) continue;
      changed.add(id);
      changedGapIds.add(gap.id);
    }
    for (const [id, gap] of gaps) if (previous.gaps.get(id)?.id !== gap.id) changed.add(id);
    if (!changed.size) return null;
    const bounds = scroll.getBoundingClientRect();
    const rows = visibleTimelineRows(scroll, bounds);
    const removedVisibleGap = [
      ...scroll.querySelectorAll<HTMLElement>('.weq-gap-band-button'),
    ].some((button) => {
      const id = button.closest<HTMLElement>('[data-message-id]')?.dataset.messageId;
      if (!id || !changedGapIds.has(id)) return false;
      const rect = button.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    });
    return {
      rows,
      changed,
      removedVisibleGap,
      revision: timelineViewport(scroll)?.scrollRevision?.(),
      atEnd: scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 2,
    };
  }

  override componentDidUpdate(
    previous: ChatTimelineProps,
    _state: unknown,
    snapshot: ReturnType<ChatTimelineGapTransition['getSnapshotBeforeUpdate']>,
  ) {
    if (!this.props.active || previous.scope !== this.props.scope) this.stopAnimations();
    const scroll = this.props.scrollRef.current;
    if (!snapshot || !scroll) return;
    this.stopAnimations();
    const viewport = timelineViewport(scroll);
    const anchor = [...snapshot.rows].find(([, row]) => scroll.contains(row.element));
    const affectedRows = new Set<HTMLDivElement>();
    const mounted = scroll.querySelectorAll<HTMLElement>(TIMELINE_MESSAGE_SELECTOR);
    for (const element of mounted) {
      if (!snapshot.changed.has(element.dataset.messageId!)) continue;
      const wrapper = element.closest<HTMLDivElement>('.weq-virtual-timeline-row');
      if (wrapper) affectedRows.add(wrapper);
    }
    // 同一帧更新复用行的高度与位置，不把提示条高度留到下一轮 ResizeObserver。
    viewport?.measureRows?.(
      affectedRows,
      !snapshot.atEnd && anchor && snapshot.changed.has(anchor[0])
        ? anchor[1].element.closest<HTMLDivElement>('.weq-virtual-timeline-row')
        : null,
    );
    if (snapshot.revision !== viewport?.scrollRevision?.()) return;
    const bounds = scroll.getBoundingClientRect();
    if (anchor && !snapshot.atEnd && !viewport?.isUserScrolling?.()) {
      const [anchorId, { top: offset }] = anchor;
      restoreReadingPosition(scroll, { anchorId, offset, scrollTop: scroll.scrollTop });
    }
    if (scroll.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches)
      return;
    const oldIds = snapshot.removedVisibleGap
      ? new Set(previous.messages.map(({ id }) => id))
      : null;
    const visible = visibleTimelineRows(scroll, bounds);
    const fillsGap = oldIds && [...visible.keys()].some((id) => !oldIds.has(id));
    for (const [id, { element, top }] of visible) {
      const old = snapshot.rows.get(id);
      const shift = old ? old.top - top : 0;
      // 填入大段历史时不让旧消息滑过新内容；小幅重排只平移正文外层，不改变行高。
      const frames =
        old && Math.abs(shift) >= 1 && Math.abs(shift) <= 72 && !fillsGap
          ? [{ transform: `translateY(${shift}px)` }, { transform: 'none' }]
          : oldIds && !oldIds.has(id)
            ? [{ opacity: 0.75 }, { opacity: 1 }]
            : null;
      if (!frames || !element.animate) continue;
      const animation = element.animate(frames, {
        duration: 160,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      });
      this.animations.add(animation);
      animation.onfinish = () => this.animations.delete(animation);
    }
  }

  override componentWillUnmount() {
    this.stopAnimations();
  }

  private stopAnimations() {
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
  }

  override render() {
    return <ChatTimelineContent {...this.props} />;
  }
}

export function ChatTimeline(props: ChatTimelineProps) {
  return <ChatTimelineGapTransition {...props} />;
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
  const keys = useMemo(() => messages.map(({ id, outgoingId }) => outgoingId ?? id), [messages]);
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
