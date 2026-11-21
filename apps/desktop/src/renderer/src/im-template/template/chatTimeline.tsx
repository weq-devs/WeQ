import { useCallback, useLayoutEffect, useMemo, type ReactNode, type RefObject } from 'react';
import { useVirtualTimeline } from '../../hooks/useVirtualTimeline';
import { estimateTimelineRowHeight } from '../../lib/timelinePreload';
import type { Message } from './types';
import type { MessageGroupPosition } from './chatTimelineModel';

export function ChatTimeline({
  messages,
  groupPositions,
  orderedIds,
  scrollRef,
  contentRef,
  scope,
  active,
  observeMessageVisibility,
  children,
}: {
  messages: Message[];
  groupPositions?: readonly (MessageGroupPosition | undefined)[];
  orderedIds: string[];
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  scope: string;
  active: boolean;
  observeMessageVisibility: () => (() => void) | undefined;
  children: (
    timeline: Pick<ReturnType<typeof useVirtualTimeline>, 'enabled' | 'items' | 'measure'>,
    captureContent: (element: HTMLDivElement | null) => void,
    rowSpacing: (index: number) => number,
  ) => ReactNode;
}) {
  const ids = useMemo(() => messages.map(({ id }) => id), [messages]);
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
  const timeline = useVirtualTimeline({ ids, orderedIds, scrollRef, scope, active, estimateSize });
  const { containerRef } = timeline;
  const captureContent = useCallback(
    (element: HTMLDivElement | null) => {
      contentRef.current = element;
      containerRef(element);
    },
    [contentRef, containerRef],
  );
  const renderedItems = timeline.enabled ? timeline.items : null;
  useLayoutEffect(() => {
    // 父层布局 effect 可能会先定位到底部或恢复阅读位置，再据此报告可见消息。
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    queueMicrotask(() => {
      if (!cancelled) cleanup = observeMessageVisibility();
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [observeMessageVisibility, renderedItems]);
  return children(timeline, captureContent, rowSpacing);
}
