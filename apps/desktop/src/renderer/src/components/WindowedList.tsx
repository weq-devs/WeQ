import {
  Component,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { flushSync } from 'react-dom';
import { allowsLayoutMotion, RowLayoutMotion, visibleLayoutRows } from '../lib/layoutMotion';
import { visibleListRange } from './WindowedList.shared';

const motionRowSelector = '[data-weq-layout-row]';
const motionRowKey = (row: HTMLElement) => row.dataset.weqLayoutRow;

type ListMotionProps<T> = {
  root: RefObject<HTMLDivElement | null>;
  items: readonly T[];
  itemKey: (item: T) => string;
  scope: string | undefined;
  rowHeight: number;
  locate: string;
  paused: boolean;
  children: ReactNode;
};

class WindowedListMotion<T> extends Component<ListMotionProps<T>> {
  private readonly motion = new RowLayoutMotion();

  stop = () => this.motion.stop();

  private reset(previous: ListMotionProps<T>) {
    const { scope, rowHeight, locate, paused } = this.props;
    return (
      paused ||
      previous.paused ||
      scope !== previous.scope ||
      rowHeight !== previous.rowHeight ||
      locate !== previous.locate
    );
  }

  override getSnapshotBeforeUpdate(previous: ListMotionProps<T>) {
    const { root, items, itemKey } = this.props;
    const list = root.current;
    if (this.reset(previous) || !list?.clientHeight || !allowsLayoutMotion(list)) return null;
    if (items === previous.items || !previous.items.length) return null;
    if (
      items.length === previous.items.length &&
      items.every((item, index) => itemKey(item) === itemKey(previous.items[index]!))
    )
      return null;
    return { top: list.scrollTop, rows: visibleLayoutRows(list, motionRowSelector, motionRowKey) };
  }

  override componentDidUpdate(
    previous: ListMotionProps<T>,
    _state: unknown,
    snapshot: ReturnType<WindowedListMotion<T>['getSnapshotBeforeUpdate']>,
  ) {
    const { root, itemKey, rowHeight } = this.props;
    const list = root.current;
    if (this.reset(previous) || (list && !allowsLayoutMotion(list))) this.stop();
    if (!snapshot || !list) return;
    this.stop();
    if (Math.abs(list.scrollTop - snapshot.top) > 1) return;
    const rows = visibleLayoutRows(list, motionRowSelector, motionRowKey);
    for (const [key, { element, top }] of rows) {
      const old = snapshot.rows.get(key);
      if (old && Math.abs(old.top - top) > rowHeight * 4) this.motion.reveal(element);
      else if (old) this.motion.shift(element, old.top - top, rowHeight * 4);
      else if (!previous.items.some((item) => itemKey(item) === key)) this.motion.reveal(element);
    }
  }

  override componentWillUnmount() {
    this.stop();
  }

  override render() {
    return this.props.children;
  }
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
  scrollAlign = 'center',
  onNearEnd,
  nearEndOffset = rowHeight * 8,
  resetKey,
  onVisibleItems,
  bufferScreens = 0,
  restoreScrollTop = 0,
  onScrollTopChange,
  layoutMotion,
}: {
  items: readonly T[];
  rowHeight: number;
  height: number;
  itemKey: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  className?: string;
  label?: string;
  scrollToKey?: string | null;
  scrollRevision?: number;
  scrollAlign?: 'start' | 'center' | 'nearest';
  onNearEnd?: () => void;
  nearEndOffset?: number;
  resetKey?: string;
  onVisibleItems?: (items: readonly T[]) => void;
  /** 主滚动列表可显式预留视口缓冲；选择器默认保留紧凑 DOM 预算。 */
  bufferScreens?: number;
  restoreScrollTop?: number;
  onScrollTopChange?: (top: number) => void;
  /** 只为业务增删、移位启用；加载、定位及更换查询范围保持即时。 */
  layoutMotion?: { paused: boolean };
}) {
  const [top, setTop] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const applied = useRef<string | null>(null);
  const restoredKey = useRef<string | undefined>(undefined);
  const motion = useRef<WindowedListMotion<T>>(null);
  useLayoutEffect(() => {
    // 滚动记录是下次切回列表的恢复值，不在当前手势中反复写回原生滚动位置。
    const changed = restoredKey.current !== resetKey;
    restoredKey.current = resetKey;
    if (changed && resetKey !== undefined && root.current) {
      const next = Math.max(0, restoreScrollTop);
      root.current.scrollTop = next;
      setTop(root.current.clientHeight ? Math.max(0, root.current.scrollTop) : next);
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
      const rowTop = index * rowHeight;
      let next = Math.max(0, rowTop - viewportHeight / 2 + rowHeight / 2);
      if (scrollAlign === 'start')
        next = Math.min(rowTop, Math.max(0, items.length * rowHeight - viewportHeight));
      if (scrollAlign === 'nearest')
        next = Math.max(rowTop + rowHeight - viewportHeight, Math.min(viewport.scrollTop, rowTop));
      viewport.scrollTop = next;
      setTop(viewport.clientHeight ? Math.max(0, viewport.scrollTop) : next);
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
  }, [items, itemKey, scrollToKey, scrollRevision, scrollAlign, rowHeight, height]);
  const range = visibleListRange(items.length, rowHeight, height, top, bufferScreens);
  const renderedRangeRef = useRef(range);
  renderedRangeRef.current = range;
  const published = useRef<{
    items: readonly T[];
    callback: NonNullable<typeof onVisibleItems>;
    first: number;
    end: number;
  } | null>(null);
  const publishVisible = (offset: number, viewportHeight: number) => {
    if (!onVisibleItems) {
      published.current = null;
      return;
    }
    const first = viewportHeight ? Math.min(items.length, Math.floor(offset / rowHeight)) : 0;
    const end = viewportHeight
      ? Math.min(items.length, Math.ceil((offset + viewportHeight) / rowHeight))
      : 0;
    const previous = published.current;
    if (
      previous?.items === items &&
      previous.callback === onVisibleItems &&
      previous.first === first &&
      previous.end === end
    )
      return;
    published.current = { items, callback: onVisibleItems, first, end };
    onVisibleItems(items.slice(first, end));
  };
  const publishRef = useRef(publishVisible);
  publishRef.current = publishVisible;
  useLayoutEffect(() => {
    const viewport = root.current;
    if (!viewport) return;
    const sync = () => {
      const viewportHeight = viewport.clientHeight;
      const offset = Math.max(0, viewport.scrollTop);
      if (viewportHeight) setTop(offset);
      publishRef.current(offset, viewportHeight);
    };
    const observer = new ResizeObserver(sync);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const viewport = root.current;
    // 数据缩短会钳制原生滚动位置，在绘制前同步窗口。
    if (viewport?.clientHeight) setTop(Math.max(0, viewport.scrollTop));
  }, [items.length, rowHeight, height]);
  useEffect(() => {
    const viewport = root.current;
    if (viewport) publishRef.current(Math.max(0, viewport.scrollTop), viewport.clientHeight);
  }, [items, rowHeight, onVisibleItems, scrollToKey, scrollRevision, resetKey]);
  const content = (
    <div
      ref={root}
      data-weq-windowed-list=""
      className={className}
      aria-label={label}
      style={{ height: Math.min(height, items.length * rowHeight), overflowY: 'auto' }}
      onScroll={(event) => {
        motion.current?.stop();
        const element = event.currentTarget;
        // Safari 顶部回弹的负值不属于内容坐标；保留原生回弹，只归一化窗口和记录。
        const offset = Math.max(0, element.scrollTop);
        onScrollTopChange?.(offset);
        const viewportHeight = element.clientHeight;
        const first = Math.floor(offset / rowHeight);
        const last = Math.ceil((offset + viewportHeight) / rowHeight);
        const current = renderedRangeRef.current;
        const next = visibleListRange(items.length, rowHeight, height, offset, bufferScreens);
        // 仅在消耗缓冲时移动窗口；滚动事件内交付新行，不能等普通状态更新补画。
        if (
          (first < current.start + 4 || last > current.end - 4) &&
          (next.start !== current.start || next.end !== current.end)
        )
          flushSync(() => setTop(offset));
        if (viewportHeight) publishVisible(offset, viewportHeight);
        if (onNearEnd && offset + viewportHeight >= items.length * rowHeight - nearEndOffset)
          onNearEnd();
      }}
    >
      <div style={{ height: items.length * rowHeight, position: 'relative' }}>
        {items.slice(range.start, range.end).map((item, offset) => {
          const key = itemKey(item);
          return (
            <div
              key={key}
              data-weq-layout-row={layoutMotion ? key : undefined}
              style={{
                position: 'absolute',
                top: (range.start + offset) * rowHeight,
                height: rowHeight,
                left: 0,
                right: 0,
              }}
            >
              {renderItem(item, range.start + offset)}
            </div>
          );
        })}
      </div>
    </div>
  );
  return (
    <WindowedListMotion
      ref={motion}
      root={root}
      items={items}
      itemKey={itemKey}
      scope={resetKey}
      rowHeight={rowHeight}
      locate={`${scrollToKey}:${scrollRevision ?? 0}`}
      paused={!layoutMotion || layoutMotion.paused}
    >
      {content}
    </WindowedListMotion>
  );
}
