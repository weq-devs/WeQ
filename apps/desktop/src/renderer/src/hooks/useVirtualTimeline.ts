import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
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
  timelineViewport,
  type TimelineGeometry,
} from '../lib/timelineViewport';
import {
  captureReadingPosition,
  restoreReadingPosition,
  type ConversationReadingPosition,
} from '../lib/conversationReadingPosition';
import { IS_ELECTRON } from '../lib/target.shared';
import { scheduleBackgroundLoad } from '../lib/backgroundLoad';
import { timelineViewportRange } from '../lib/timelinePreload';
import { advanceTimelinePrewarm, TIMELINE_PREWARM_BUDGET } from '../lib/timelinePrewarm';
import '../styles/virtual-timeline.css';
import { useMobileWebLayout } from './useMobileWebViewport';

export const TIMELINE_VIRTUAL_THRESHOLD = 40;
export const TIMELINE_OVERSCAN = 6;
const EMPTY_WARM_ROWS: readonly string[] = [];
const observeTimelineRect: typeof observeElementRect = (instance, callback) =>
  observeElementRect(instance, (rect) => {
    // 隐藏视口的零尺寸不回灌范围；重新显示时继续交付真实宽高。
    if (rect.width > 0 && rect.height > 0) callback(rect);
  });

function createScrollRangeStore() {
  let version = 0;
  let listener: (() => void) | undefined;
  return {
    subscribe(callback: () => void) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    getSnapshot: () => version,
    requestCommit() {
      version++;
      listener?.();
    },
  };
}

export function useVirtualTimeline({
  ids,
  keys = ids,
  scrollRef,
  scope,
  active = true,
  orderedIds,
  estimateSize,
  warmBytesAt,
  warmBudgetBytes = TIMELINE_PREWARM_BUDGET,
}: {
  ids: string[];
  keys?: string[];
  scrollRef: RefObject<HTMLDivElement | null>;
  scope: string;
  active?: boolean;
  orderedIds: readonly string[];
  estimateSize: (index: number) => number;
  warmBytesAt?: (index: number) => number;
  warmBudgetBytes?: number;
}) {
  const mobileWeb = useMobileWebLayout();
  const enabled = ids.length > TIMELINE_VIRTUAL_THRESHOLD;
  const activeRef = useRef(active);
  activeRef.current = active;
  const deliveringOffset = useRef(false);
  const reportTimelineOffset = useRef<((offset: number, scrolling: boolean) => void) | null>(null);
  const touching = useRef(false);
  const touchMomentum = useRef(false);
  const mountedIndexes = useRef<ReadonlySet<number>>(new Set());
  const motion = useRef<{ scope: string; direction: -1 | 0 | 1; velocity: number; at: number }>({
    scope,
    direction: 0,
    velocity: 0,
    at: 0,
  });
  if (motion.current.scope !== scope) motion.current = { scope, direction: 0, velocity: 0, at: 0 };
  const [scrollRange] = useState(createScrollRangeStore);
  useSyncExternalStore(scrollRange.subscribe, scrollRange.getSnapshot);
  const observeTimelineOffset: typeof observeElementOffset = useCallback((instance, callback) => {
    const report = (offset: number, scrolling: boolean) => {
      if (!activeRef.current) return;
      const previous = instance.scrollOffset;
      if (scrolling && previous !== null && offset !== previous) {
        const now = performance.now();
        motion.current.direction = offset < previous ? -1 : 1;
        motion.current.velocity =
          Math.abs(offset - previous) / Math.max(8, Math.min(64, now - motion.current.at));
        motion.current.at = now;
      }
      if (!scrolling && !touching.current) touchMomentum.current = false;
      deliveringOffset.current = true;
      try {
        callback(offset, scrolling);
      } finally {
        deliveringOffset.current = false;
      }
    };
    reportTimelineOffset.current = report;
    const release = observeElementOffset(instance, report);
    return () => {
      reportTimelineOffset.current = null;
      release?.();
    };
  }, []);
  const previousMode = useRef({ scope, active, windowed: enabled });
  const suspendedAnchor = useRef<ConversationReadingPosition | undefined>(undefined);
  const thresholdAnchor = useRef<ConversationReadingPosition | undefined>(undefined);
  // 页面隐藏或切换普通／虚拟布局前，采集真实可见行的位置。
  if (previousMode.current.scope !== scope) {
    suspendedAnchor.current = undefined;
    thresholdAnchor.current = undefined;
  } else if (previousMode.current.active && scrollRef.current) {
    if (!active) suspendedAnchor.current = captureReadingPosition(scrollRef.current);
    else if (previousMode.current.windowed !== enabled) {
      const remaining = new Set(ids);
      thresholdAnchor.current = captureReadingPosition(scrollRef.current, {
        transient: true,
        acceptAnchor: (id) => remaining.has(id),
      });
    }
  }
  previousMode.current = { scope, active, windowed: enabled };
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
  const key = useCallback((position: number) => keys[position]!, [keys]);
  const instanceRef = useRef<Virtualizer<HTMLDivElement, HTMLDivElement> | null>(null);
  const canPrewarm = IS_ELECTRON && enabled && active && !!warmBytesAt && warmBudgetBytes > 0;
  const [warm, setWarm] = useState<{ scope: string; rows: readonly string[] }>({
    scope,
    rows: EMPTY_WARM_ROWS,
  });
  const warmRows = canPrewarm && warm.scope === scope ? warm.rows : EMPTY_WARM_ROWS;
  const warmIndex = useMemo(() => new Map(keys.map((id, position) => [id, position])), [keys]);
  const warmPositions = useMemo(() => {
    const positions = new Set<number>();
    for (const id of warmRows) {
      const position = warmIndex.get(id);
      if (position !== undefined) positions.add(position);
    }
    return positions;
  }, [warmIndex, warmRows]);
  const nearRows = useCallback(
    (range: Range, instance: Virtualizer<HTMLDivElement, HTMLDivElement> | null) => {
      const height = instance?.scrollRect?.height ?? 0;
      // 快滚时把方向上的完整消息提前覆盖，额外最多两屏，仍受预挂载行数限制。
      const ahead =
        canPrewarm && instance?.isScrolling && height > 0
          ? 2 + Math.min(2, Math.floor((motion.current.velocity * 80) / height))
          : 2;
      return timelineViewportRange(
        range,
        height,
        (position) => instance?.itemSizeCache.get(key(position)),
        instance?.scrollDirection ?? null,
        (position) => instance?.measurementsCache[position]?.size ?? estimateSize(position),
        ahead,
      );
    },
    [canPrewarm, estimateSize, key],
  );
  const rangeExtractor = useCallback(
    (range: Range) => {
      const near = nearRows(range, instanceRef.current);
      const rendered = new Set(near);
      // 只复用紧邻当前缓冲的完整行。大幅跳转后旧区块不参与新视口渲染。
      if (warmPositions.size && near.length) {
        const extend = (start: number, step: -1 | 1) => {
          let gap = 0;
          for (
            let position = start;
            position >= 0 && position < keys.length && gap < TIMELINE_OVERSCAN;
            position += step
          ) {
            if (warmPositions.has(position)) {
              rendered.add(position);
              gap = 0;
            } else gap++;
          }
        };
        extend(near[0]! - 1, -1);
        extend(near[near.length - 1]! + 1, 1);
      }
      const anchorId = thresholdAnchor.current?.anchorId;
      const anchorIndex = anchorId ? index.get(anchorId) : undefined;
      if (anchorIndex !== undefined) rendered.add(anchorIndex);
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
    [index, keys.length, nearRows, scrollRef, warmPositions],
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
      if (!enabled || !sync || !deliveringOffset.current || !instance.range) return;
      const { startIndex, endIndex } = instance.range;
      for (let index = startIndex; index <= endIndex; index++) {
        if (mountedIndexes.current.has(index)) continue;
        // 跨出缓冲时以同步优先级补齐范围，但让原生滚动回调先返回。
        scrollRange.requestCommit();
        break;
      }
    },
    estimateSize,
    // 保留子像素高度；逐行取整会在短列表切入虚拟布局时积累数像素误差。
    measureElement: (element, entry, instance) => {
      const observed = entry?.borderBoxSize?.[0]?.blockSize;
      // RO 已交付正高度时不重新触发布局。
      if (observed !== undefined && observed > 0) return observed;
      const index = instance.indexFromElement(element);
      const cached = instance.itemSizeCache.get(instance.options.getItemKey(index));
      const range = instance.range;
      // 空闲预挂载的离屏行先登记观察，避免 React 提交时逐行强制布局。
      if (
        !entry &&
        range &&
        warmPositions.has(index) &&
        (index < range.startIndex || index > range.endIndex)
      )
        return cached ?? instance.options.estimateSize(index);
      const rects = element.getClientRects();
      if (!rects.length) {
        // display:none 的零尺寸不是消息真实高度，不回灌阅读位置模型。
        return cached ?? instance.options.estimateSize(index);
      }
      return (
        observed ?? (rects.length === 1 ? rects[0]!.height : element.getBoundingClientRect().height)
      );
    },
    getItemKey: key,
    overscan: TIMELINE_OVERSCAN,
    scrollMargin: margin,
    anchorTo: enabled ? 'end' : 'start',
    followOnAppend: false,
    // 贴底由聊天导航按真实滚动容器判断；虚拟高度不包含外部留白和页脚。
    scrollEndThreshold: -1,
    rangeExtractor,
  });
  instanceRef.current = virtualizer;
  const virtualItems = enabled ? virtualizer.getVirtualItems() : null;
  const visibleStart = virtualizer.range?.startIndex;
  const visibleEnd = virtualizer.range?.endIndex;
  const isScrolling = virtualizer.isScrolling;
  useEffect(() => {
    if (!canPrewarm) {
      if (warm.rows.length) setWarm({ scope, rows: EMPTY_WARM_ROWS });
      return;
    }
    if (!warmBytesAt || isScrolling || visibleStart === undefined || visibleEnd === undefined)
      return;
    let disposed = false;
    const cancel = scheduleBackgroundLoad(() => {
      if (disposed || !virtualizer.range || virtualizer.isScrolling) return;
      const range = virtualizer.range;
      const near = nearRows(
        { ...range, count: keys.length, overscan: TIMELINE_OVERSCAN },
        virtualizer,
      );
      if (!near.length) return;
      const { at, direction, velocity } = motion.current;
      const rows = advanceTimelinePrewarm({
        keys,
        index: warmIndex,
        bytesAt: warmBytesAt,
        geometry: virtualizer.measurementsCache,
        visibleStart: range.startIndex,
        visibleEnd: range.endIndex,
        nearStart: near[0]!,
        nearEnd: near[near.length - 1]!,
        direction,
        velocity,
        current: warmRows,
        budget: warmBudgetBytes,
      });
      if (rows)
        startTransition(() => {
          setWarm((previous) =>
            !disposed &&
            activeRef.current &&
            motion.current.scope === scope &&
            motion.current.at === at
              ? { scope, rows }
              : previous,
          );
        });
    }, 32);
    return () => {
      disposed = true;
      cancel();
    };
  }, [
    canPrewarm,
    isScrolling,
    keys,
    nearRows,
    scope,
    virtualizer,
    visibleEnd,
    visibleStart,
    warm,
    warmBudgetBytes,
    warmBytesAt,
    warmIndex,
    warmRows,
  ]);
  useLayoutEffect(() => {
    mountedIndexes.current = new Set(virtualItems?.map(({ index }) => index));
  }, [virtualItems]);
  const resizedAnchorIndex = useRef(-1);
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if (!enabled) return false;
    // 缺口条在锚点正文之前，即使两者位于同一虚拟行也需要补偿。
    if (item.index === resizedAnchorIndex.current) return true;
    const offset = instance.scrollOffset ?? 0;
    // 已经完全滚过的行增高时，连同位置一起补偿，向上滚动时也保住正在读的消息。
    return instance.itemSizeCache.has(item.key) ? item.end <= offset : item.start < offset;
  };
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
    let lastInputAt = -Infinity;
    const cancel = () => {
      command.current++;
      context.current.virtualizer.cancelScroll();
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
    };
    const stopScroll = () => {
      scrollRevision.current++;
      cancel();
    };
    const interrupt = () => {
      lastInputAt = performance.now();
      stopScroll();
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.target === scroll) interrupt();
      else stopScroll();
    };
    const keys = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key))
        interrupt();
    };
    const touchStart = () => {
      touching.current = true;
    };
    const touchMove = () => {
      touchMomentum.current = true;
      interrupt();
    };
    const touchEnd = (event: TouchEvent) => {
      if (!event.touches.length) touching.current = false;
    };
    const touchOptions = { capture: true, passive: true };
    scroll.addEventListener('wheel', interrupt, { passive: true });
    scroll.addEventListener('touchstart', touchStart, touchOptions);
    scroll.addEventListener('touchmove', touchMove, touchOptions);
    scroll.addEventListener('touchend', touchEnd, touchOptions);
    scroll.addEventListener('touchcancel', touchEnd, touchOptions);
    scroll.addEventListener('pointerdown', pointerDown, { passive: true });
    scroll.addEventListener('keydown', keys);
    const position = (
      id: string,
      align: 'start' | 'center' | 'end',
      {
        saved,
        flash,
        focus,
        ease,
      }: { saved?: ConversationReadingPosition; flash?: boolean; focus?: boolean; ease?: boolean },
    ) => {
      const current = context.current;
      if (!current.active) return false;
      const target = current.index.get(id);
      if (target === undefined) return false;
      const mounted = saved ? messageElement(scroll, id) : undefined;
      if (saved && mounted) {
        const rect = mounted.getBoundingClientRect();
        const bounds = scroll.getBoundingClientRect();
        const start = scroll.scrollTop;
        const delta = saved.alignToEnd
          ? rect.bottom - bounds.top - scroll.clientHeight + (saved.bottomInset ?? 0)
          : rect.top - bounds.top - (saved.offset ?? 0);
        const destination = Math.max(
          0,
          Math.min(start + delta, scroll.scrollHeight - scroll.clientHeight),
        );
        const distance = Math.abs(destination - start);
        if (distance < 1) return true;
        cancel();
        if (
          ease &&
          distance >= 12 &&
          distance <= 72 &&
          rect.bottom > bounds.top &&
          rect.top < bounds.bottom &&
          !current.virtualizer.isScrolling &&
          performance.now() - lastInputAt >= 180 &&
          scroll.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: no-preference)')
            .matches
        ) {
          // 可见的小幅剩余偏移才用缓动，手势、离屏定位和较大位移由原路径直接处理。
          const startedAt = performance.now();
          let previous = start;
          const step = (now: number) => {
            frame.current = undefined;
            if (Math.abs(scroll.scrollTop - previous) > 1) return;
            const progress = Math.min(1, (now - startedAt) / 120);
            scroll.scrollTop = start + (destination - start) * (1 - (1 - progress) ** 3);
            previous = scroll.scrollTop;
            if (progress < 1) frame.current = requestAnimationFrame(step);
          };
          frame.current = requestAnimationFrame(step);
        } else if (current.windowed) {
          current.virtualizer.scrollToOffset(destination, { behavior: 'auto' });
        } else {
          scroll.scrollTop = destination;
        }
        return true;
      }
      cancel();
      if (!current.windowed) {
        const line = messageElement(scroll, id);
        if (!line) return false;
        line.scrollIntoView({ block: align });
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
      isUserScrolling: () =>
        touching.current ||
        (context.current.virtualizer.isScrolling &&
          (touchMomentum.current || performance.now() - lastInputAt < 180)),
      measureRows: (rows, anchor) => {
        const { virtualizer } = context.current;
        const sizes: [number, number][] = [];
        for (const row of rows) {
          const index = virtualizer.indexFromElement(row);
          sizes.push([index, row.getBoundingClientRect().height]);
        }
        resizedAnchorIndex.current = anchor ? virtualizer.indexFromElement(anchor) : -1;
        try {
          virtualizer.resizeItems(sizes.filter(([, height]) => height > 0));
        } finally {
          resizedAnchorIndex.current = -1;
        }
      },
      cancelScroll: interrupt,
      capture: () => (context.current.active ? undefined : suspendedAnchor.current),
      scrollTo: (id, options) => {
        scrollRevision.current++;
        return position(id, options?.align ?? 'center', {
          flash: options?.flash,
          focus: options?.focus,
        });
      },
      restore: (saved, options) => {
        if (!context.current.active) {
          suspendedAnchor.current = saved;
          return true;
        }
        return saved.anchorId
          ? position(saved.anchorId, saved.alignToEnd ? 'end' : 'start', {
              saved,
              ease: options?.ease,
            })
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
        if (context.current.windowed) {
          const previousOffset = scroll.scrollTop;
          context.current.virtualizer.scrollToEnd({ behavior: 'auto' });
          const offset = scroll.scrollTop;
          // 贴底可能发生在 rAF 或提交阶段，原生 scroll 回调要到下一帧才会补齐新视口。
          if (offset !== previousOffset) reportTimelineOffset.current?.(offset, true);
        } else scroll.scrollTop = scroll.scrollHeight;
      },
      geometry: () => {
        if (!context.current.windowed) return [];
        const current = context.current;
        current.virtualizer.getTotalSize();
        const result: TimelineGeometry[] = [];
        let order = 0;
        for (const row of current.virtualizer.measurementsCache) {
          const id = current.ids[row.index]!;
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
      touching.current = false;
      touchMomentum.current = false;
      scroll.removeEventListener('wheel', interrupt);
      scroll.removeEventListener('touchstart', touchStart, touchOptions);
      scroll.removeEventListener('touchmove', touchMove, touchOptions);
      scroll.removeEventListener('touchend', touchEnd, touchOptions);
      scroll.removeEventListener('touchcancel', touchEnd, touchOptions);
      scroll.removeEventListener('pointerdown', pointerDown);
      scroll.removeEventListener('keydown', keys);
    };
  }, [scope, scrollRef]);

  useLayoutEffect(() => {
    if (!active) {
      touching.current = false;
      touchMomentum.current = false;
      scrollRevision.current++;
      command.current++;
      virtualizer.cancelScroll();
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    } else if (suspendedAnchor.current && scrollRef.current) {
      restoreReadingPosition(scrollRef.current, suspendedAnchor.current);
      suspendedAnchor.current = undefined;
    }
  }, [active, scope, scrollRef, virtualizer]);

  useLayoutEffect(() => {
    const saved = thresholdAnchor.current;
    thresholdAnchor.current = undefined;
    const scroll = scrollRef.current;
    if (!active || !saved?.anchorId || !scroll) return;
    // 等本次布局的同步提交落地，仍在第一次绘制前按实际正文坐标恢复。
    queueMicrotask(() => {
      if (scrollRef.current !== scroll || context.current.scope !== scope || !activeRef.current)
        return;
      if (enabled) timelineViewport(scroll)?.measureRows?.(virtualizer.elementsCache.values());
      restoreReadingPosition(scroll, saved);
    });
  }, [enabled, active, scope, scrollRef, virtualizer]);

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

  const pendingScrollMeasurements = useRef(
    new Map<ReturnType<typeof virtualizer.options.getItemKey>, HTMLDivElement>(),
  );
  const detachedRows = useRef(false);
  useLayoutEffect(() => {
    if (detachedRows.current) {
      detachedRows.current = false;
      // refs 在 DOM 移除前逐个清空，提交完成后一次性取消离屏行的观察。
      virtualizer.measureElement(null);
    }
    const pending = pendingScrollMeasurements.current;
    if (!pending.size) return;
    // 先读完本次提交的高度，再让虚拟列表更新行位置和阅读锚点。
    const measurements: [index: number, height: number][] = [];
    for (const [id, element] of pending) {
      if (
        element.isConnected &&
        virtualizer.elementsCache.get(id) === element &&
        !virtualizer.itemSizeCache.has(id)
      ) {
        measurements.push([
          virtualizer.indexFromElement(element),
          virtualizer.options.measureElement(element, undefined, virtualizer),
        ]);
      }
    }
    pending.clear();
    virtualizer.resizeItems(measurements);
  });

  const measure = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) {
        detachedRows.current = true;
        return;
      }
      virtualizer.measureElement(element);
      const range = virtualizer.range;
      if (!element.isConnected || !enabled || !virtualizer.isScrolling || !range) return;
      const index = virtualizer.indexFromElement(element);
      // 运行在桌面宽窗时，RO 会在绘制前交付其余行；移动布局仍使用原有主动测量。
      if (
        index < range.startIndex ||
        index > range.endIndex ||
        (IS_ELECTRON && !mobileWeb && index !== range.startIndex)
      )
        return;
      const id = virtualizer.options.getItemKey(index);
      if (virtualizer.itemSizeCache.has(id)) return;
      // 当前首行决定阅读锚点，继续集中读高并批量修正位置。
      pendingScrollMeasurements.current.set(id, element);
    },
    [enabled, mobileWeb, virtualizer],
  );

  return {
    enabled,
    prewarmEnabled: canPrewarm,
    virtualizer,
    margin,
    items: virtualItems ?? keys.map((key, index) => ({ key, index, start: 0 })),
    totalSize: enabled ? virtualizer.getTotalSize() : 0,
    measure,
    containerRef,
  };
}
