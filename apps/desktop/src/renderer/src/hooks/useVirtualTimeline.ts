import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { flushSync } from 'react-dom';
import {
  observeElementOffset,
  observeElementRect,
  useVirtualizer,
  type Range,
  type Virtualizer,
} from '@tanstack/react-virtual';
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
import { useMobileWebLayout } from './useMobileWebViewport';
import { timelineViewportRange } from '../lib/timelinePreload';

export const TIMELINE_VIRTUAL_THRESHOLD = 40;
export const TIMELINE_OVERSCAN = 6;
const keepNativeScroll = () => false;
const observeTimelineRect: typeof observeElementRect = (instance, callback) =>
  observeElementRect(instance, (rect) => {
    // 隐藏视口的零尺寸不回灌范围；重新显示时继续交付真实宽高。
    if (rect.width > 0 && rect.height > 0) callback(rect);
  });

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
  const mobileWeb = useMobileWebLayout();
  const enabled = ids.length > TIMELINE_VIRTUAL_THRESHOLD;
  const activeRef = useRef(active);
  activeRef.current = active;
  const deliveringOffset = useRef(false);
  const committingScroll = useRef(false);
  const mountedIndexes = useRef<ReadonlySet<number>>(new Set());
  const [, commitScrollRange] = useReducer((version: number) => version + 1, 0);
  const observeTimelineOffset: typeof observeElementOffset = useCallback(
    (instance, callback) =>
      observeElementOffset(instance, (offset, scrolling) => {
        if (!activeRef.current) return;
        deliveringOffset.current = true;
        try {
          callback(offset, scrolling);
        } finally {
          deliveringOffset.current = false;
        }
      }),
    [],
  );
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
  const instanceRef = useRef<Virtualizer<HTMLDivElement, HTMLDivElement> | null>(null);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const instance = instanceRef.current;
      const rendered = new Set(
        timelineViewportRange(
          range,
          instance?.scrollRect?.height ?? 0,
          (position) => instance?.itemSizeCache.get(ids[position]!),
          instance?.scrollDirection ?? null,
        ),
      );
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
    [ids, index, scrollRef],
  );
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: ids.length,
    enabled: ids.length > 0,
    getScrollElement: () => scrollRef.current,
    observeElementRect: observeTimelineRect,
    observeElementOffset: observeTimelineOffset,
    // 桌面行高与位置在绘制前直接交付，不在尺寸回调里同步挂载新行。
    directDomUpdates: true,
    directDomUpdatesMode: 'position',
    useFlushSync: false,
    useAnimationFrameWithResizeObserver: mobileWeb,
    onChange: (instance, sync) => {
      if (
        !enabled ||
        !sync ||
        !deliveringOffset.current ||
        committingScroll.current ||
        !instance.range
      )
        return;
      const { startIndex, endIndex } = instance.range;
      for (let index = startIndex; index <= endIndex; index++) {
        if (mountedIndexes.current.has(index)) continue;
        // 缓冲能覆盖当前视口时，让普通更新补充下一批行。只有跨出缓冲才同步挂载。
        committingScroll.current = true;
        try {
          flushSync(commitScrollRange);
        } finally {
          committingScroll.current = false;
        }
        break;
      }
    },
    estimateSize: () => 96,
    // 保留子像素高度；逐行取整会在短列表切入虚拟布局时积累数像素误差。
    measureElement: (element, entry, instance) => {
      const observed = entry?.borderBoxSize?.[0]?.blockSize;
      // RO 已交付正高度时不重新触发布局；首次挂载仍同步测量，不延后一帧。
      if (observed !== undefined && observed > 0) return observed;
      const rects = element.getClientRects();
      if (!rects.length) {
        // display:none 的零尺寸不是消息真实高度，不回灌阅读位置模型。
        const index = instance.indexFromElement(element);
        return (
          instance.itemSizeCache.get(instance.options.getItemKey(index)) ??
          instance.options.estimateSize(index)
        );
      }
      return (
        observed ?? (rects.length === 1 ? rects[0]!.height : element.getBoundingClientRect().height)
      );
    },
    getItemKey: key,
    overscan: TIMELINE_OVERSCAN,
    gap: 18,
    scrollMargin: margin,
    anchorTo: enabled ? 'end' : 'start',
    followOnAppend: false,
    scrollEndThreshold: 48,
    rangeExtractor,
  });
  instanceRef.current = virtualizer;
  const virtualItems = enabled ? virtualizer.getVirtualItems() : null;
  useLayoutEffect(() => {
    mountedIndexes.current = new Set(virtualItems?.map(({ index }) => index));
  }, [virtualItems]);
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = enabled ? undefined : keepNativeScroll;
  const context = useRef({ ids, index, orderedIds, virtualizer, scope, active, windowed: enabled });
  context.current = { ids, index, orderedIds, virtualizer, scope, active, windowed: enabled };
  const command = useRef(0);
  const scrollRevision = useRef(0);
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
    const interrupt = () => {
      scrollRevision.current++;
      cancel();
    };
    const keys = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key))
        interrupt();
    };
    scroll.addEventListener('wheel', interrupt, { passive: true });
    scroll.addEventListener('touchmove', interrupt, { passive: true });
    scroll.addEventListener('pointerdown', interrupt, { passive: true });
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
      scrollRevision: () => scrollRevision.current,
      cancelScroll: interrupt,
      capture: () => (context.current.active ? undefined : suspendedAnchor.current),
      scrollTo: (id, options) => {
        scrollRevision.current++;
        return position(id, options?.align ?? 'center', undefined, options?.flash, options?.focus);
      },
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
        scrollRevision.current++;
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
      scroll.removeEventListener('wheel', interrupt);
      scroll.removeEventListener('touchmove', interrupt);
      scroll.removeEventListener('pointerdown', interrupt);
      scroll.removeEventListener('keydown', keys);
    };
  }, [scope, scrollRef]);

  useLayoutEffect(() => {
    if (!active) {
      scrollRevision.current++;
      command.current++;
      virtualizer.cancelScroll();
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    } else if (suspendedAnchor.current && scrollRef.current) {
      restoreReadingPosition(scrollRef.current, suspendedAnchor.current);
      suspendedAnchor.current = undefined;
    }
  }, [active, scope, scrollRef, virtualizer]);

  const containerRef = useCallback(
    (node: HTMLDivElement | null) => {
      virtualizer.containerRef(enabled ? node : null);
      if (node && !enabled) {
        node.style.height = '';
        for (const row of node.children) {
          if (row instanceof HTMLElement) row.style.top = '';
        }
      }
    },
    [enabled, virtualizer],
  );

  return {
    enabled,
    virtualizer,
    margin,
    items: virtualItems ?? ids.map((id, index) => ({ key: id, index, start: 0 })),
    totalSize: enabled ? virtualizer.getTotalSize() : 0,
    measure: virtualizer.measureElement,
    containerRef,
  };
}
