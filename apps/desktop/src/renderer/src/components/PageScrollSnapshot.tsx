import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { z } from 'zod';
import { captureReadingPosition, restoreReadingPosition } from '../lib/conversationReadingPosition';
import { pageSnapshots } from '../lib/pageSnapshots';
import { usePageSnapshotKey } from './PageSnapshots.shared';

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
  useLayoutEffect(() => {
    const container = root.current;
    if (!container || !key) return;
    const owner = container.ownerDocument.defaultView ?? window;
    let positions: Position[] = [];
    try {
      positions = pageSnapshots.read(key, positionSchema) ?? [];
    } catch {
      /* 失效的坐标不影响正文。 */
    }
    const expandedKey = `${key}:details`;
    const expandedSchema = z
      .array(z.object({ path: z.array(z.number().int().nonnegative()).max(32), open: z.boolean() }))
      .max(64);
    try {
      for (const item of pageSnapshots.read(expandedKey, expandedSchema) ?? []) {
        let element: Element | undefined = container;
        for (const index of item.path) element = element?.children[index];
        if (
          element instanceof HTMLDetailsElement &&
          !element.hasAttribute('data-snapshot-skip-details')
        )
          element.open = item.open;
      }
    } catch {
      /* 失效的展开坐标不影响正文。 */
    }
    const pending = new Set(positions);
    let finished = false;
    let frame = 0;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const scrolled = new Map<HTMLElement, Position>();
    const find = (item: Position): HTMLElement | null => {
      let node: Element | undefined = container;
      for (const index of item.path) node = node?.children[index];
      if (item.reading && !(node instanceof HTMLElement && node.matches('.message-scroll')))
        return container.querySelector('.message-scroll');
      return node instanceof HTMLElement ? node : null;
    };
    const save = (resample = false) => {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      const recent = new Map(positions.map((item) => [item.path.join('.'), item]));
      for (const [target, item] of scrolled) {
        const path = pathOf(container, target);
        if (path && (target.clientHeight || target.scrollTop || target.scrollLeft)) {
          item.path = path;
          item.top = Math.max(0, target.scrollTop);
          item.left = Math.max(0, target.scrollLeft);
          if (target.matches('.message-scroll')) item.reading = captureReadingPosition(target);
        }
        const id = item.path.join('.');
        recent.delete(id);
        recent.set(id, item);
      }
      scrolled.clear();
      positions = [...recent.values()].slice(-64);
      if (!positions.length) return;
      if (resample) {
        for (const item of positions) {
          if (pending.has(item)) continue;
          const element = find(item);
          if (!element?.clientHeight) continue;
          item.top = Math.max(0, element.scrollTop);
          item.left = Math.max(0, element.scrollLeft);
          if (item.reading) item.reading = captureReadingPosition(element);
        }
      }
      try {
        pageSnapshots.write(key, positions);
      } catch {
        /* 坐标不影响正文草稿保存。 */
      }
    };
    const onScroll = (event: Event) => {
      const target = event.target;
      if (
        pending.size ||
        !(target instanceof HTMLElement) ||
        target.closest('[data-page-snapshot]') !== container
      )
        return;
      const current = scrolled.get(target);
      const path = current?.path ?? pathOf(container, target);
      if (!path) return;
      if (current) scrolled.delete(target);
      const position = current ?? { path, top: 0, left: 0 };
      position.top = Math.max(0, target.scrollTop);
      position.left = Math.max(0, target.scrollLeft);
      scrolled.set(target, position);
      clearTimeout(saveTimer);
      // 滚动停稳后才查消息锚点和写缓存，避免滚动期间强制布局和同步存储。
      saveTimer = setTimeout(save, 150);
    };
    const onPageHide = () => {
      if (scrolled.size) save();
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
            if (
              element.scrollTop !== item.top &&
              element.scrollHeight - element.clientHeight >= item.top
            )
              element.scrollTop = item.top;
            continue;
          }
          restoreReadingPosition(element, item.reading);
        } else {
          if (
            element.scrollHeight - element.clientHeight < item.top ||
            element.scrollWidth - element.clientWidth < item.left
          )
            continue;
          element.scrollTop = item.top;
          element.scrollLeft = item.left;
        }
        pending.delete(item);
      }
      if (!pending.size) finish();
    };
    const schedule = () => {
      if (!finished && !frame) frame = owner.requestAnimationFrame(restore);
    };
    const observer = new MutationObserver(schedule);
    const resize = new ResizeObserver(schedule);
    function finish() {
      if (finished) return;
      finished = true;
      pending.clear();
      observer.disconnect();
      resize.disconnect();
      if (frame) owner.cancelAnimationFrame(frame);
      frame = 0;
    }
    const timer = setTimeout(finish, 5000);
    if (pending.size) {
      observer.observe(container, { subtree: true, childList: true });
      resize.observe(container);
      restore();
    }
    container.addEventListener('wheel', finish, { passive: true });
    container.addEventListener('touchstart', finish, { passive: true });
    container.addEventListener('pointerdown', finish);
    container.addEventListener('keydown', finish);
    container.addEventListener('weq-page-navigation', finish);
    container.addEventListener('load', schedule, true);
    container.addEventListener('scroll', onScroll, { capture: true, passive: true });
    owner.addEventListener('pagehide', onPageHide);
    return () => {
      const details = [...container.querySelectorAll('details')]
        .filter(
          (element) =>
            element.closest('[data-page-snapshot]') === container &&
            !element.hasAttribute('data-snapshot-skip-details'),
        )
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
      save(true);
      finish();
      clearTimeout(timer);
      container.removeEventListener('wheel', finish);
      container.removeEventListener('touchstart', finish);
      container.removeEventListener('pointerdown', finish);
      container.removeEventListener('keydown', finish);
      container.removeEventListener('weq-page-navigation', finish);
      container.removeEventListener('load', schedule, true);
      container.removeEventListener('scroll', onScroll, true);
      owner.removeEventListener('pagehide', onPageHide);
    };
  }, [key]);
  return (
    <div
      ref={root}
      data-page-snapshot=""
      data-retained-panel={panel ? '' : undefined}
      className={className}
      style={style}
    >
      {children}
    </div>
  );
}
