import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

export function visibleListRange(
  count: number,
  rowHeight: number,
  height: number,
  top: number,
  bufferScreens = 0,
) {
  if (!count) return { start: 0, end: 0 };
  const rows = Math.max(1, Math.ceil(height / rowHeight));
  const buffer = bufferScreens > 0 ? Math.max(8, Math.ceil(rows * bufferScreens)) : 5;
  const start = Math.max(0, Math.min(Math.floor(top / rowHeight) - buffer, count - 1));
  return { start, end: Math.min(count, start + rows + buffer * (bufferScreens > 0 ? 3 : 2)) };
}

/** 固定行高的会话选择器共用，DOM 数量只随可视区域增长。 */
export function WindowedList<T>({
  items,
  rowHeight,
  height,
  itemKey,
  renderItem,
  className,
  label,
  scrollToKey,
  scrollRevision,
  onNearEnd,
  resetKey,
  onVisibleItems,
  bufferScreens = 0,
  restoreScrollTop = 0,
  onScrollTopChange,
}: {
  items: readonly T[];
  rowHeight: number;
  height: number;
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  className?: string;
  label?: string;
  scrollToKey?: string | null;
  scrollRevision?: number;
  onNearEnd?: () => void;
  resetKey?: string;
  onVisibleItems?: (items: readonly T[]) => void;
  /** 主滚动列表可显式预留视口缓冲；选择器默认保留紧凑 DOM 预算。 */
  bufferScreens?: number;
  restoreScrollTop?: number;
  onScrollTopChange?: (top: number) => void;
}) {
  const [top, setTop] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const applied = useRef<string | null>(null);
  useLayoutEffect(() => {
    const viewport = root.current;
    if (!viewport) return;
    const syncTop = () => {
      if (viewport.clientHeight) setTop(viewport.scrollTop);
    };
    const observer = new ResizeObserver(syncTop);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (resetKey !== undefined && root.current) {
      root.current.scrollTop = restoreScrollTop;
      setTop(restoreScrollTop);
    }
  }, [resetKey, restoreScrollTop]);
  useLayoutEffect(() => {
    const request = `${scrollToKey}:${scrollRevision ?? 0}`;
    if (!scrollToKey || applied.current === request) return;
    const apply = () => {
      const viewport = root.current;
      if (!viewport) return false;
      const index = items.findIndex((item) => itemKey(item) === scrollToKey);
      if (index < 0) return false;
      const viewportHeight = viewport.clientHeight || height;
      const next = Math.max(0, index * rowHeight - viewportHeight / 2 + rowHeight / 2);
      viewport.scrollTop = next;
      setTop(viewport.clientHeight ? viewport.scrollTop : next);
      if (!viewport.clientHeight) return false;
      applied.current = request;
      return true;
    };
    if (apply()) return;
    const viewport = root.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      if (apply()) observer.disconnect();
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [items, itemKey, scrollToKey, scrollRevision, rowHeight, height]);
  const range = visibleListRange(items.length, rowHeight, height, top, bufferScreens);
  const renderedRangeRef = useRef(range);
  renderedRangeRef.current = range;
  useLayoutEffect(() => {
    const viewport = root.current;
    // 数据缩短或布局压缩会钳制原生滚动位置，在绘制前同步窗口。
    if (viewport?.clientHeight && viewport.scrollTop !== top) setTop(viewport.scrollTop);
  }, [items.length, rowHeight, height, top]);
  useEffect(() => {
    const viewport = root.current;
    if (!viewport || !onVisibleItems) return;
    const publish = () => {
      if (!viewport.clientHeight) {
        onVisibleItems([]);
        return;
      }
      const first = Math.max(0, Math.floor(viewport.scrollTop / rowHeight));
      const end = Math.min(
        items.length,
        Math.ceil((viewport.scrollTop + viewport.clientHeight) / rowHeight),
      );
      onVisibleItems(items.slice(first, end));
    };
    publish();
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(publish);
    observer?.observe(viewport);
    return () => observer?.disconnect();
  }, [items, rowHeight, top, onVisibleItems]);
  return (
    <div
      ref={root}
      data-weq-windowed-list=""
      className={className}
      aria-label={label}
      style={{ height: Math.min(height, items.length * rowHeight), overflowY: 'auto' }}
      onScroll={(event) => {
        const element = event.currentTarget;
        onScrollTopChange?.(element.scrollTop);
        const first = Math.floor(element.scrollTop / rowHeight);
        const last = Math.ceil((element.scrollTop + element.clientHeight) / rowHeight);
        const current = renderedRangeRef.current;
        const next = visibleListRange(
          items.length,
          rowHeight,
          height,
          element.scrollTop,
          bufferScreens,
        );
        // 仅在消耗缓冲时移动窗口；滚动事件内交付新行，不能等普通状态更新补画。
        if (
          (first < current.start + 4 || last > current.end - 4) &&
          (next.start !== current.start || next.end !== current.end)
        )
          flushSync(() => setTop(element.scrollTop));
        if (element.clientHeight && onVisibleItems)
          onVisibleItems(items.slice(Math.max(0, first), Math.min(items.length, last)));
        if (element.scrollTop + element.clientHeight >= element.scrollHeight - rowHeight * 8)
          onNearEnd?.();
      }}
    >
      <div style={{ height: items.length * rowHeight, position: 'relative' }}>
        {items.slice(range.start, range.end).map((item, offset) => (
          <div
            key={itemKey(item)}
            style={{
              position: 'absolute',
              top: (range.start + offset) * rowHeight,
              height: rowHeight,
              left: 0,
              right: 0,
            }}
          >
            {renderItem(item)}
          </div>
        ))}
      </div>
    </div>
  );
}
