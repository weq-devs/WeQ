import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { z } from 'zod';
import { captureReadingPosition, restoreReadingPosition } from '../lib/conversationReadingPosition';
import { pageSnapshots } from '../lib/pageSnapshots';
import { usePageSnapshotKey } from './PageSnapshots';

const reading = z.object({
  scrollTop: z.number(),
  anchorId: z.string().optional(),
  anchorSeq: z.string().optional(),
  offset: z.number().optional(),
  alignToEnd: z.boolean().optional(),
  bottomInset: z.number().optional(),
});
const positionSchema = z
  .array(
    z.object({
      path: z.array(z.number().int().nonnegative()).max(32),
      top: z.number().finite().nonnegative(),
      left: z.number().finite().nonnegative(),
      reading: reading.optional(),
    }),
  )
  .max(64);
type Position = z.infer<typeof positionSchema>[number];

function pathOf(root: HTMLElement, target: HTMLElement): number[] | null {
  const path: number[] = [];
  let node: Element | null = target;
  while (node && node !== root && path.length < 32) {
    const parent: Element | null = node.parentElement;
    if (!parent) return null;
    path.unshift(Array.from(parent.children).indexOf(node));
    node = parent;
  }
  return node === root ? path : null;
}

/** 卸载时只留下坐标和消息锚点；异步内容就绪后恢复，不缓存节点。 */
export function PageScrollSnapshot({
  children,
  style,
  className,
  panel = false,
}: {
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
  panel?: boolean;
}) {
  const key = usePageSnapshotKey('scroll');
  const root = useRef<HTMLDivElement>(null);
  const positions = useRef<Position[]>([]);
  const restoring = useRef(false);
  const flush = useRef(() => {});
  const capture = (target: HTMLElement) => {
    const container = root.current;
    if (!container || restoring.current) return;
    const path = pathOf(container, target);
    if (!path) return;
    const id = path.join('.');
    const value: Position = { path, top: target.scrollTop, left: target.scrollLeft };
    if (target.matches('.message-scroll')) value.reading = captureReadingPosition(target);
    positions.current = [
      ...positions.current.filter((item) => item.path.join('.') !== id),
      value,
    ].slice(-64);
  };
  useLayoutEffect(() => {
    const container = root.current;
    if (!container || !key) return;
    try {
      positions.current = pageSnapshots.read(key, positionSchema) ?? [];
    } catch {
      positions.current = [];
    }
    const expandedKey = `${key}:details`;
    const expandedSchema = z
      .array(z.object({ path: z.array(z.number().int().nonnegative()).max(32), open: z.boolean() }))
      .max(64);
    try {
      for (const item of pageSnapshots.read(expandedKey, expandedSchema) ?? []) {
        let element: Element | undefined = container;
        for (const index of item.path) element = element?.children[index];
        if (element instanceof HTMLDetailsElement) element.open = item.open;
      }
    } catch {
      /* 失效的展开坐标不影响正文。 */
    }
    const pending = new Set(positions.current);
    restoring.current = pending.size > 0;
    let finished = false;
    let frame = 0;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const find = (item: Position): HTMLElement | null => {
      let node: Element | undefined = container;
      for (const index of item.path) node = node?.children[index];
      if (item.reading && !(node instanceof HTMLElement && node.matches('.message-scroll')))
        return container.querySelector('.message-scroll');
      return node instanceof HTMLElement ? node : null;
    };
    const save = () => {
      if (!positions.current.length) return;
      try {
        pageSnapshots.write(key, positions.current);
      } catch {
        /* 坐标不影响正文草稿保存。 */
      }
    };
    flush.current = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 150);
    };
    const restore = () => {
      frame = 0;
      for (const item of pending) {
        const element = find(item);
        if (!element) continue;
        if (item.reading) {
          if (!element.querySelector('[data-message-id]')) continue;
          if (
            item.reading.anchorId &&
            ![...element.querySelectorAll<HTMLElement>('[data-message-id]')].some(
              (row) => row.dataset.messageId === item.reading?.anchorId,
            )
          ) {
            element.scrollTop = item.top;
            continue;
          }
          restoreReadingPosition(element, item.reading);
        } else {
          if (element.scrollHeight - element.clientHeight < item.top) continue;
          element.scrollTop = item.top;
          element.scrollLeft = item.left;
        }
        pending.delete(item);
      }
      if (!pending.size) finish();
    };
    const schedule = () => {
      if (!finished && !frame) frame = requestAnimationFrame(restore);
    };
    const observer = new MutationObserver(schedule);
    const resize = new ResizeObserver(schedule);
    function finish() {
      finished = true;
      restoring.current = false;
      pending.clear();
      observer.disconnect();
      resize.disconnect();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }
    const timer = setTimeout(finish, 5000);
    if (pending.size) {
      observer.observe(container, { subtree: true, childList: true });
      resize.observe(container);
      schedule();
    }
    container.addEventListener('wheel', finish, { passive: true });
    container.addEventListener('touchstart', finish, { passive: true });
    container.addEventListener('pointerdown', finish);
    container.addEventListener('keydown', finish);
    container.addEventListener('weq-page-navigation', finish);
    container.addEventListener('load', schedule, true);
    return () => {
      const details = [...container.querySelectorAll('details')]
        .filter((element) => element.closest('[data-page-snapshot]') === container)
        .slice(0, 64)
        .flatMap((element) => {
          const path = pathOf(container, element);
          return path ? [{ path, open: element.open }] : [];
        });
      if (details.length) {
        try {
          pageSnapshots.write(expandedKey, details);
        } catch {
          /* 不影响草稿。 */
        }
      }
      for (const item of positions.current) {
        if (restoring.current && pending.has(item)) continue;
        const element = find(item);
        if (element) {
          item.top = element.scrollTop;
          item.left = element.scrollLeft;
          if (item.reading) item.reading = captureReadingPosition(element);
        }
      }
      finish();
      clearTimeout(timer);
      if (saveTimer) clearTimeout(saveTimer);
      save();
      flush.current = () => {};
      container.removeEventListener('wheel', finish);
      container.removeEventListener('touchstart', finish);
      container.removeEventListener('pointerdown', finish);
      container.removeEventListener('keydown', finish);
      container.removeEventListener('weq-page-navigation', finish);
      container.removeEventListener('load', schedule, true);
    };
  }, [key]);
  return (
    <div
      ref={root}
      data-page-snapshot=""
      data-retained-panel={panel ? '' : undefined}
      className={className}
      style={style}
      onScrollCapture={(event) => {
        if (
          event.target instanceof HTMLElement &&
          event.target.closest('[data-page-snapshot]') === event.currentTarget
        ) {
          capture(event.target);
          flush.current();
        }
      }}
    >
      {children}
    </div>
  );
}
