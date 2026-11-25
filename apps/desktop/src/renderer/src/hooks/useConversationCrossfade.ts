import { useLayoutEffect, useRef } from 'react';
import { prefersReducedMotion } from '../lib/surfaceMotion';
import { TIMELINE_MESSAGE_SELECTOR } from '../lib/timelineViewport';

/**
 * 切会话的交叉淡出淡入。
 *
 * 切换会话时消息区不会先清空：新会话的窗口要等首屏查回来才替换正文，这段时间还挂着
 * 上一个会话的内容。以前是一次硬切；这里在替换发生的同一帧，把旧正文的 DOM 快照铺在
 * 上面淡出，同时把新正文淡入，形成交叉过渡。
 *
 * 三个前提：
 * - 快照必须在 DOM 被替换前拍下，所以换会话后延迟 `SNAPSHOT_DELAY_MS` 才拍；更快的
 *   切换（内存里已有该会话窗口）直接保持瞬时，不做动效，连续浏览不会被拖慢。
 * - 快照层铺满消息区并带 `.chat-main` 同款底色，避免两层文字互相透出。
 * - 全程只动 opacity，不参与布局，不影响虚拟列表测量与阅读位置恢复。
 */

/** 超过这个时长才值得为一次切换拍快照、做交叉过渡。 */
const SNAPSHOT_DELAY_MS = 120;
const CROSSFADE_MS = 200;
const ROW_SELECTOR = TIMELINE_MESSAGE_SELECTOR;

type Snapshot = { node: HTMLElement; scrollTop: number };

type Pending = {
  scope: string | undefined;
  ids: Set<string>;
  snapshot?: Snapshot;
  timer?: ReturnType<typeof setTimeout>;
};

function rowIds(scroll: HTMLElement | null): Set<string> {
  const ids = new Set<string>();
  for (const element of scroll?.querySelectorAll<HTMLElement>(ROW_SELECTOR) ?? []) {
    const id = element.dataset.messageId;
    if (id) ids.add(id);
  }
  return ids;
}

/** 消息区里渲染出来的行是否全部换成了 `previousIds` 之外的（新会话正文已落位）。 */
function rowsReplaced(scroll: HTMLElement | null, previousIds: Set<string>): boolean {
  const rows = scroll?.querySelectorAll<HTMLElement>(ROW_SELECTOR);
  if (!rows?.length) return false;
  for (const element of rows) {
    const id = element.dataset.messageId;
    if (!id || previousIds.has(id)) return false;
  }
  return true;
}

function takeSnapshot(scroll: HTMLElement | null): Snapshot | undefined {
  if (!scroll?.querySelectorAll(ROW_SELECTOR).length) return undefined;
  const node = scroll.cloneNode(true) as HTMLElement;
  node.removeAttribute('id');
  for (const element of node.querySelectorAll<HTMLElement>('*')) {
    element.removeAttribute('id');
    element.removeAttribute('tabindex');
    element.removeAttribute('contenteditable');
  }
  // 快照是静态画面：不接媒体播放，也不让懒加载拖慢首帧。
  for (const media of node.querySelectorAll('video, audio, iframe, canvas')) media.remove();
  for (const image of node.querySelectorAll<HTMLImageElement>('img')) image.loading = 'eager';
  return { node, scrollTop: scroll.scrollTop };
}

/** 把快照铺在消息区上淡出，同时把新正文淡入；结束后移除快照层。 */
function playCrossfade(scroll: HTMLElement, snapshot: Snapshot) {
  const doc = scroll.ownerDocument;
  const pane = scroll.closest<HTMLElement>('.chat-pane');
  if (!pane || prefersReducedMotion(scroll)) return;

  const rect = scroll.getBoundingClientRect();
  const paneRect = pane.getBoundingClientRect();
  const layer = doc.createElement('div');
  layer.className = 'weq-chat-crossfade-layer';
  layer.inert = true;
  layer.setAttribute('aria-hidden', 'true');
  layer.style.left = `${rect.left - paneRect.left}px`;
  layer.style.top = `${rect.top - paneRect.top}px`;
  layer.style.width = `${rect.width}px`;
  layer.style.height = `${rect.height}px`;
  layer.append(snapshot.node);
  pane.append(layer);
  snapshot.node.scrollTop = snapshot.scrollTop;

  const timing = { duration: CROSSFADE_MS, easing: 'ease-out' } as const;
  const fadingOut = layer.animate([{ opacity: 1 }, { opacity: 0 }], {
    ...timing,
    fill: 'both',
  });
  scroll.animate([{ opacity: 0 }, { opacity: 1 }], timing);

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    layer.remove();
  };
  void fadingOut.finished.then(remove, remove);
  // 兜底：窗口在动画期间隐藏或被中断时，finished 可能不触发。
  setTimeout(remove, CROSSFADE_MS + 400);
}

/**
 * 换会话时在正文替换的那一帧做交叉过渡；滚动容器由调用方传入。
 * 返回值为空，副作用都在 layout effect 里，避免多一次渲染。
 */
export function useConversationCrossfade({
  scope,
  scrollRef,
  content,
}: {
  scope: string | undefined;
  scrollRef: { current: HTMLDivElement | null };
  /** 消息数组（只用作“正文已变化”的依赖，不读内容）。 */
  content: unknown;
}): void {
  const pending = useRef<Pending | undefined>(undefined);

  // 换会话：记下当前正文的消息 id，超过观察窗还没换新正文就拍快照备用。
  useLayoutEffect(() => {
    const current: Pending = { scope, ids: rowIds(scrollRef.current) };
    pending.current = current;
    current.timer = setTimeout(() => {
      if (pending.current !== current) return;
      if (rowsReplaced(scrollRef.current, current.ids)) return;
      current.snapshot = takeSnapshot(scrollRef.current);
    }, SNAPSHOT_DELAY_MS);
    return () => {
      if (current.timer) clearTimeout(current.timer);
    };
  }, [scope, scrollRef]);

  // 新正文落位：在同一帧把旧快照淡出、新正文淡入。
  useLayoutEffect(() => {
    const current = pending.current;
    if (!current || current.scope !== scope) return;
    const scroll = scrollRef.current;
    if (!scroll || !rowsReplaced(scroll, current.ids)) return;
    pending.current = undefined;
    if (current.timer) clearTimeout(current.timer);
    if (current.snapshot) {
      playCrossfade(scroll, current.snapshot);
      current.snapshot = undefined;
      return;
    }
    // 没有可承接的旧正文（切进来时消息区本来就是空的）：只让新正文淡入。
    if (!prefersReducedMotion(scroll))
      scroll.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: CROSSFADE_MS,
        easing: 'ease-out',
      });
  }, [scope, scrollRef, content]);
}
