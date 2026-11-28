import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { z } from 'zod/v3';
import { captureReadingPosition, restoreReadingPosition } from '../lib/conversationReadingPosition';
import { pageSnapshots } from '../lib/pageSnapshots';
import {
  messageElement,
  timelineViewport,
  TIMELINE_MESSAGE_LOCATED,
} from '../lib/timelineViewport';
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
      conversation: z.string().optional(),
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
  snapshotKey = 'scroll',
  scrollRef,
}: {
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
  panel?: boolean;
  snapshotKey?: string;
  scrollRef?: RefObject<HTMLDivElement | null>;
}) {
  const key = usePageSnapshotKey(snapshotKey);
  const internalRef = useRef<HTMLDivElement>(null);
  const root = scrollRef ?? internalRef;
  useLayoutEffect(() => {
    const container = root.current;
    if (!container || !key) return;
    const owner = container.ownerDocument.defaultView ?? window;
    let positions: Position[] = [];
    try {
      // 旧版聊天快照没有会话身份，不能判断锚点属于哪个聊天。
      positions = (pageSnapshots.read(key, positionSchema) ?? []).filter(
        (item) => !item.reading || (item.conversation && item.reading.anchorId),
      );
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
          element instanceof owner.HTMLDetailsElement &&
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
      const byPath =
        node instanceof owner.HTMLElement &&
        node.closest('[data-page-snapshot]') === container &&
        (!item.reading || node.matches('.message-scroll'))
          ? node
          : null;
      if (!item.reading || byPath?.dataset.snapshotConversation === item.conversation)
        return byPath;
      return (
        [...container.querySelectorAll<HTMLElement>('.message-scroll')].find(
          (scroll) =>
            scroll.dataset.snapshotConversation === item.conversation &&
            scroll.closest('[data-page-snapshot]') === container,
        ) ?? byPath
      );
    };
    const save = (resample = false) => {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      const recent = new Map(positions.map((item) => [item.path.join('.'), item]));
      for (const [target, item] of scrolled) {
        // 防止防抖期间切换会话后，把新会话的消息写到旧会话名下。
        if (item.conversation !== target.dataset.snapshotConversation) continue;
        const path = pathOf(container, target);
        if (path && (target.clientHeight || target.scrollTop || target.scrollLeft)) {
          item.path = path;
          item.top = Math.max(0, target.scrollTop);
          item.left = Math.max(0, target.scrollLeft);
          if (item.conversation) item.reading = captureReadingPosition(target);
        }
        const id = item.path.join('.');
        recent.delete(id);
        if (!item.conversation || item.reading?.anchorId) recent.set(id, item);
      }
      scrolled.clear();
      positions = [...recent.values()].slice(-64);
      if (!positions.length) return;
      if (resample) {
        for (const item of positions) {
          if (pending.has(item)) continue;
          const element = find(item);
          if (!element?.clientHeight || item.conversation !== element.dataset.snapshotConversation)
            continue;
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
        !(target instanceof owner.HTMLElement) ||
        target.closest('[data-page-snapshot]') !== container
      )
        return;
      const conversation = target.dataset.snapshotConversation;
      if (target.matches('.message-scroll') && !conversation) return;
      const recorded = scrolled.get(target);
      const current = recorded?.conversation === conversation ? recorded : undefined;
      const path = current?.path ?? pathOf(container, target);
      if (!path) return;
      if (current) scrolled.delete(target);
      const position = current ?? { path, top: 0, left: 0, conversation };
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
    const onMessageLocated = (event: Event) => {
      const scroll = event.target;
      if (
        !(scroll instanceof owner.HTMLElement) ||
        scroll.closest('[data-page-snapshot]') !== container
      )
        return;
      // 定位接管聊天视口，该页其他滚动区继续恢复。
      for (const item of pending) {
        if (find(item) === scroll) pending.delete(item);
      }
      if (!pending.size) finish();
    };
    const restore = () => {
      frame = 0;
      for (const item of pending) {
        const element = find(item);
        if (!element) continue;
        if (item.conversation !== element.dataset.snapshotConversation) {
          pending.delete(item);
          continue;
        }
        if (item.reading) {
          const anchor = item.reading.anchorId;
          if (
            !anchor ||
            (!messageElement(element, anchor) &&
              timelineViewport(element)?.offset(anchor) === undefined)
          )
            continue;
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
      observer.observe(container, {
        subtree: true,
        childList: true,
        attributeFilter: ['data-snapshot-conversation'],
      });
      resize.observe(container);
      restore();
    }
    container.addEventListener('wheel', finish, { passive: true });
    container.addEventListener('touchstart', finish, { passive: true });
    container.addEventListener('pointerdown', finish);
    container.addEventListener('keydown', finish);
    container.addEventListener('weq-page-navigation', finish);
    container.addEventListener(TIMELINE_MESSAGE_LOCATED, onMessageLocated);
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
      container.removeEventListener(TIMELINE_MESSAGE_LOCATED, onMessageLocated);
      container.removeEventListener('load', schedule, true);
      container.removeEventListener('scroll', onScroll, true);
      owner.removeEventListener('pagehide', onPageHide);
    };
  }, [key, root]);
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
