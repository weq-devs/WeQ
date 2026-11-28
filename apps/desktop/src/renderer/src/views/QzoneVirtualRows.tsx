import {
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  defaultRangeExtractor,
  measureElement,
  observeElementOffset,
  observeElementRect,
  useVirtualizer,
} from '@tanstack/react-virtual';
import type { MultiSelectionItemProps } from '../hooks/useMultiSelection';
import { PageDataCache } from '../lib/pageDataCache';
import { FeedCardData, FeedRowKey, PinFeedCard } from './qzoneCardState';
import { QzoneRefreshScrollContext } from './qzoneRefresh';

// 切到其他栏目时容器会隐藏，保留最后一次可见尺寸和已测的行高。
const observeFeedRect: typeof observeElementRect = (instance, update) =>
  observeElementRect(instance, (rect) => {
    if (rect.height > 0) update(rect);
  });
const observeFeedOffset: typeof observeElementOffset = (instance, update) =>
  observeElementOffset(instance, (offset, scrolling) => {
    if (!instance.scrollElement?.hasAttribute('hidden')) update(offset, scrolling);
  });

interface VirtualFeedRow {
  key: string;
  selectionId?: string;
}

export function QzoneVirtualRows<Row extends VirtualFeedRow>({
  rows,
  active,
  selectionMode,
  selected,
  focusRequest,
  itemProps,
  renderRow,
}: {
  rows: readonly Row[];
  active: boolean;
  selectionMode: boolean;
  selected?: ReadonlySet<string>;
  focusRequest: { id: string; revision: number } | null;
  itemProps?: (id: string) => MultiSelectionItemProps;
  renderRow: (row: Row) => ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  const refreshScroll = useContext(QzoneRefreshScrollContext);
  const getScrollElement = useCallback(
    () => content.current?.closest<HTMLDivElement>('.weq-qzn-scroll') ?? null,
    [],
  );
  const appliedFocus = useRef<typeof focusRequest>(null);
  const [offset, setOffset] = useState(0);
  const [focused, setFocused] = useState<string>();
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set());
  const [cardData] = useState(() => new PageDataCache(128));
  const indices = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const visible = defaultRangeExtractor(range);
      if (!pinned.size && !focused) return visible;
      const retained = new Set(visible);
      for (const key of pinned) {
        const index = indices.get(key);
        if (index !== undefined) retained.add(index);
      }
      const focusedIndex = focused === undefined ? undefined : indices.get(focused);
      if (focusedIndex !== undefined) retained.add(focusedIndex);
      return [...retained].sort((a, b) => a - b);
    },
    [pinned, focused, indices],
  );
  const list = useVirtualizer({
    count: rows.length,
    getScrollElement,
    getItemKey: useCallback((index: number) => rows[index]!.key, [rows]),
    estimateSize: () => 180,
    overscan: 4,
    initialRect: { width: 0, height: 900 },
    observeElementRect: observeFeedRect,
    observeElementOffset: observeFeedOffset,
    useAnimationFrameWithResizeObserver: true,
    measureElement: (element, entry, instance) => {
      const actual = measureElement(element, entry, instance);
      if (actual > 0) return actual;
      const index = instance.indexFromElement(element);
      return (
        instance.itemSizeCache.get(rows[index]?.key ?? '') ?? instance.options.estimateSize(index)
      );
    },
    rangeExtractor,
    scrollMargin: offset,
    anchorTo: 'end',
  });
  useLayoutEffect(() => {
    if (!active || !refreshScroll) return;
    // 告知虚拟列表这是主动滚动，行高测量时才不会用位置补偿打断动画。
    refreshScroll.current = (top, behavior) => list.scrollToOffset(top, { behavior });
    return () => {
      refreshScroll.current = null;
    };
  }, [active, list, refreshScroll]);
  useLayoutEffect(() => {
    const scroll = getScrollElement();
    const element = content.current;
    if (!active || !scroll || !element) return;
    const update = () =>
      setOffset(
        element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop,
      );
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(scroll);
    for (
      let branch: Element | null = element;
      branch && branch !== scroll;
      branch = branch.parentElement
    ) {
      for (
        let sibling = branch.previousElementSibling;
        sibling;
        sibling = sibling.previousElementSibling
      )
        observer.observe(sibling);
    }
    return () => observer.disconnect();
  }, [active, getScrollElement, selectionMode]);
  useLayoutEffect(() => {
    if (!active || !focusRequest || appliedFocus.current === focusRequest) return;
    const index = rows.findIndex((row) => row.selectionId === focusRequest.id);
    if (index >= 0) {
      appliedFocus.current = focusRequest;
      list.scrollToIndex(index, { align: 'auto' });
    }
  }, [active, focusRequest, rows, list]);
  const setPinnedRow = useCallback((key: string, keep: boolean) => {
    setPinned((current) => {
      if (keep === current.has(key)) return current;
      const next = new Set(current);
      if (keep) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  return (
    <div
      className="weq-qzn-feed-rows"
      ref={content}
      style={{ height: list.getTotalSize() }}
      onFocusCapture={(event) => {
        const row = event.target.closest<HTMLElement>('[data-qzone-feed-row]');
        if (row) setFocused(row.dataset.qzoneFeedRow);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(undefined);
      }}
    >
      <FeedCardData.Provider value={cardData}>
        {list.getVirtualItems().map((virtual) => {
          const row = rows[virtual.index]!;
          return (
            <div
              key={row.key}
              {...(row.selectionId ? itemProps?.(row.selectionId) : {})}
              ref={list.measureElement}
              data-index={virtual.index}
              data-qzone-feed-row={row.key}
              className={`weq-reference-item${row.selectionId && selected?.has(row.selectionId) ? ' is-selected' : ''}`}
              style={{ transform: `translateY(${virtual.start - offset}px)` }}
            >
              <QzoneFeedRow keyId={row.key} retain={setPinnedRow}>
                {renderRow(row)}
              </QzoneFeedRow>
            </div>
          );
        })}
      </FeedCardData.Provider>
    </div>
  );
}

function QzoneFeedRow({
  keyId,
  retain,
  children,
}: {
  keyId: string;
  retain: (key: string, keep: boolean) => void;
  children: ReactNode;
}) {
  const pin = useCallback((keep: boolean) => retain(keyId, keep), [keyId, retain]);
  return (
    <FeedRowKey.Provider value={keyId}>
      <PinFeedCard.Provider value={pin}>{children}</PinFeedCard.Provider>
    </FeedRowKey.Provider>
  );
}
