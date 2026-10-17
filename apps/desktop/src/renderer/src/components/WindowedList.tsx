import { useState, type ReactNode } from 'react';

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
}: {
  items: readonly T[];
  rowHeight: number;
  height: number;
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  className?: string;
  label?: string;
}) {
  const [top, setTop] = useState(0);
  const range = visibleListRange(items.length, rowHeight, height, top);
  return (
    <div
      className={className}
      aria-label={label}
      style={{ height: Math.min(height, items.length * rowHeight), overflowY: 'auto' }}
      onScroll={(event) => setTop(event.currentTarget.scrollTop)}
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
