import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import {
  messageElement,
  registerTimelineViewport,
  type TimelineGeometry,
} from '../lib/timelineViewport';
import {
  captureReadingPosition,
  restoreReadingPosition,
  type ConversationReadingPosition,
} from '../lib/conversationReadingPosition';
import '../styles/virtual-timeline.css';

export const TIMELINE_VIRTUAL_THRESHOLD = 150;
export const TIMELINE_OVERSCAN = 6;
const keepNativeScroll = () => false;
export function useVirtualTimeline({
  ids,
  scrollRef,
  scope,
  active = true,
  orderedIds,
}: {
  ids: string[];
  scrollRef: RefObject<HTMLDivElement | null>;
  scope: string;
  active?: boolean;
  orderedIds: readonly string[];
}) {
  const enabled = ids.length > TIMELINE_VIRTUAL_THRESHOLD;
  const previousMode = useRef({ scope, active });
  const suspendedAnchor = useRef<ConversationReadingPosition | undefined>(undefined);
  // 页面隐藏前只采集已挂载 DOM；阈值切换沿用同一份测量，不重建阅读位置。
  if (previousMode.current.scope !== scope) {
    suspendedAnchor.current = undefined;
  } else {
    if (previousMode.current.active && !active && scrollRef.current)
      suspendedAnchor.current = captureReadingPosition(scrollRef.current);
  }
  previousMode.current = { scope, active };
  const [margin, setMargin] = useState(26);
  const index = useMemo(() => {
    const result = new Map(ids.map((id, position) => [id, position]));
    let following: number | undefined;
    for (let position = orderedIds.length - 1; position >= 0; position--) {
      const id = orderedIds[position]!;
      const own = result.get(id);
      if (own !== undefined) following = own;
      else if (following !== undefined) result.set(id, following);
    }
    return result;
  }, [ids, orderedIds]);
  const key = useCallback((position: number) => ids[position]!, [ids]);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const rendered = new Set(defaultRangeExtractor(range));
      // 正在播放的语音／视频不因滚出视口而中断；其他离屏媒体随虚拟行释放。
      for (const media of scrollRef.current?.querySelectorAll<HTMLElement>(
        '.qq-media-voice.is-playing, video',
      ) ?? []) {
        if (media instanceof HTMLVideoElement && media.paused) continue;
        const id = media.closest<HTMLElement>('[data-message-id]')?.dataset.messageId;
        const position = id ? index.get(id) : undefined;
        if (position !== undefined) rendered.add(position);
      }
      return [...rendered].sort((a, b) => a - b);
    },
    [index, scrollRef],
  );
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: ids.length,
    enabled: ids.length > 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 96,
    // 保留子像素高度；逐行取整会在短列表切入虚拟布局时积累数像素误差。
    measureElement: (element, entry, instance) => {
      const index = instance.indexFromElement(element);
      if (!element.getClientRects().length) {
        // display:none 的零尺寸不是消息真实高度，不回灌阅读位置模型。
        return (
          instance.itemSizeCache.get(instance.options.getItemKey(index)) ??
          instance.options.estimateSize(index)
        );
      }
      return entry?.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height;
    },
    getItemKey: key,
    overscan: TIMELINE_OVERSCAN,
    gap: 18,
    scrollMargin: margin,
    anchorTo: enabled ? 'end' : 'start',
    followOnAppend: false,
    scrollEndThreshold: 48,
    rangeExtractor,
    useFlushSync: false,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = enabled ? undefined : keepNativeScroll;
  const context = useRef({ ids, index, orderedIds, virtualizer, scope, active, windowed: enabled });
  context.current = { ids, index, orderedIds, virtualizer, scope, active, windowed: enabled };
  const command = useRef(0);
  const frame = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const measurePadding = () =>
      setMargin(Number.parseFloat(getComputedStyle(scroll).paddingTop) || 0);
    measurePadding();
    const resize = new ResizeObserver(measurePadding);
    resize.observe(scroll);
    const cancel = () => {
      command.current++;
      context.current.virtualizer.cancelScroll();
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    };
    const keys = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key))
        cancel();
    };
    scroll.addEventListener('wheel', cancel, { passive: true });
    scroll.addEventListener('touchmove', cancel, { passive: true });
    scroll.addEventListener('keydown', keys);
    const position = (
      id: string,
      align: 'start' | 'center' | 'end',
      saved?: ConversationReadingPosition,
      flash = false,
      focus = false,
    ) => {
      const current = context.current;
      if (!current.active) return false;
      const target = current.index.get(id);
      if (target === undefined) return false;
      cancel();
      if (!current.windowed) {
        const line = messageElement(scroll, id);
        if (!line) return false;
        if (saved) {
          const rect = line.getBoundingClientRect(),
            bounds = scroll.getBoundingClientRect();
          scroll.scrollTop += saved.alignToEnd
            ? rect.bottom - bounds.top - scroll.clientHeight + (saved.bottomInset ?? 0)
            : rect.top - bounds.top - (saved.offset ?? 0);
        } else line.scrollIntoView({ block: align });
        if (focus) line.focus({ preventScroll: true });
        if (flash) {
          line.classList.add('weq-reply-target-flash');
          setTimeout(() => line.classList.remove('weq-reply-target-flash'), 1600);
        }
        return true;
      }
      const token = command.current,
        owner = current.scope;
      current.virtualizer.scrollToIndex(target, { align, behavior: 'auto' });
      let attempts = 0;
      const settle = () => {
        if (command.current !== token || context.current.scope !== owner || !scroll.isConnected)
          return;
        const line = messageElement(scroll, id);
        if (line) {
          const rect = line.getBoundingClientRect(),
            bounds = scroll.getBoundingClientRect();
          const delta = saved
            ? saved.alignToEnd
              ? rect.bottom - bounds.top - scroll.clientHeight + (saved.bottomInset ?? 0)
              : rect.top - bounds.top - (saved.offset ?? 0)
            : align === 'center'
              ? (rect.top + rect.bottom - bounds.top - bounds.bottom) / 2
              : align === 'end'
                ? rect.bottom - bounds.bottom
                : rect.top - bounds.top;
          context.current.virtualizer.scrollToOffset(Math.max(0, scroll.scrollTop + delta), {
            behavior: 'auto',
          });
          // 精确锚点已落地；结束索引追踪，后续高度变化交给引擎的阅读锚点补偿。
          context.current.virtualizer.cancelScroll();
          if (focus) line.focus({ preventScroll: true });
          if (flash) {
            line.classList.add('weq-reply-target-flash');
            setTimeout(() => line.classList.remove('weq-reply-target-flash'), 1600);
          }
          return;
        }
        if (++attempts < 12) frame.current = requestAnimationFrame(settle);
      };
      frame.current = requestAnimationFrame(settle);
      return true;
    };
    const release = registerTimelineViewport(scroll, {
      capture: () => (context.current.active ? undefined : suspendedAnchor.current),
      scrollTo: (id, options) =>
        position(id, options?.align ?? 'center', undefined, options?.flash, options?.focus),
      restore: (saved) => {
        if (!context.current.active) {
          suspendedAnchor.current = saved;
          return true;
        }
        return saved.anchorId
          ? position(saved.anchorId, saved.alignToEnd ? 'end' : 'start', saved)
          : false;
      },
      offset: (id) => {
        if (!context.current.windowed) return undefined;
        const current = context.current,
          target = current.index.get(id);
        if (target === undefined) return undefined;
        current.virtualizer.getTotalSize();
        return current.virtualizer.measurementsCache[target]?.start;
      },
      bottom: () => {
        if (!context.current.active) return;
        cancel();
        if (context.current.windowed) context.current.virtualizer.scrollToEnd({ behavior: 'auto' });
        else scroll.scrollTop = scroll.scrollHeight;
      },
      geometry: () => {
        if (!context.current.windowed) return [];
        const current = context.current;
        current.virtualizer.getTotalSize();
        const result: TimelineGeometry[] = [];
        let order = 0;
        for (const row of current.virtualizer.measurementsCache) {
          const id = String(row.key);
          // 缺口是独立的逻辑选择项；未挂载时使用该行顶部的估计位置，挂载后以 DOM 覆盖。
          while (order < current.orderedIds.length && current.orderedIds[order] !== id) {
            result.push({
              id: current.orderedIds[order++]!,
              top: row.start,
              bottom: row.start + 24,
            });
          }
          if (current.orderedIds[order] === id) order++;
          result.push({ id, top: row.start, bottom: row.end });
        }
        return result;
      },
    });
    return () => {
      cancel();
      release();
      resize.disconnect();
      scroll.removeEventListener('wheel', cancel);
      scroll.removeEventListener('touchmove', cancel);
      scroll.removeEventListener('keydown', keys);
    };
  }, [scope, scrollRef]);

  useLayoutEffect(() => {
    if (!active) {
      command.current++;
      virtualizer.cancelScroll();
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    } else if (suspendedAnchor.current && scrollRef.current) {
      restoreReadingPosition(scrollRef.current, suspendedAnchor.current);
      suspendedAnchor.current = undefined;
    }
  }, [active, scope, scrollRef, virtualizer]);

  return {
    enabled,
    virtualizer,
    margin,
    items: enabled
      ? virtualizer.getVirtualItems()
      : ids.map((id, index) => ({ key: id, index, start: 0 })),
    totalSize: enabled ? virtualizer.getTotalSize() : 0,
    measure: virtualizer.measureElement,
  };
}
