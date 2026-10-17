import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export function visibleListRange(count: number, rowHeight: number, height: number, top: number) {
  const start = Math.max(0, Math.min(Math.floor(top / rowHeight) - 5, count - 1));
  return { start, end: Math.min(count, start + Math.ceil(height / rowHeight) + 10) };
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
}) {
  const [top, setTop] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const applied = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (resetKey !== undefined && root.current) {
      root.current.scrollTop = 0;
      setTop(0);
    }
  }, [resetKey]);
  useLayoutEffect(() => {
    const request = `${scrollToKey}:${scrollRevision ?? 0}`;
    if (!scrollToKey || applied.current === request) return;
    const index = items.findIndex((item) => itemKey(item) === scrollToKey);
    if (index < 0 || !root.current) return;
    const next = Math.max(0, index * rowHeight - height / 2 + rowHeight / 2);
    root.current.scrollTop = next;
    setTop(next);
    applied.current = request;
  }, [items, itemKey, scrollToKey, scrollRevision, rowHeight, height]);
  const range = visibleListRange(items.length, rowHeight, height, top);
  return (
    <div
      ref={root}
      className={className}
      aria-label={label}
      style={{ height: Math.min(height, items.length * rowHeight), overflowY: 'auto' }}
      onScroll={(event) => {
        const element = event.currentTarget;
        setTop(element.scrollTop);
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
