import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { prefersReducedMotion, surfaceMotionTiming } from '../lib/surfaceMotion';
import { TIMELINE_MESSAGE_SELECTOR } from '../lib/timelineViewport';
import { useClosingContent } from './useClosingContent';

/**
 * 切会话的「等待」过渡。
 *
 * 背景：切换会话时消息窗口要等新会话的首屏回来才替换正文（慢的时候接近一秒），
 * 这段时间消息区里还是上一个会话的内容，之后新正文一次性铺满 —— 观感就是
 * 「画面卡住 → 内容突然出现」。
 *
 * 做法：换会话后先观察 100ms。多数会话在此之前就换上新正文，什么都不做；超过
 * 观察窗还没换，就把旧正文淡出、铺一层骨架，等新正文落位再淡回来。整个过程只动
 * `.message-scroll` 的 opacity，不参与布局，也不影响虚拟列表测量和阅读位置恢复。
 */

const WATCH_MS = 100;
const ROW_SELECTOR = TIMELINE_MESSAGE_SELECTOR;
type FadeRef = RefObject<Animation | undefined>;

type Watch = { scope: string | undefined; ids: Set<string>; timer?: ReturnType<typeof setTimeout> };

function rowIds(scroll: HTMLElement | null): Set<string> {
  const ids = new Set<string>();
  for (const element of scroll?.querySelectorAll<HTMLElement>(ROW_SELECTOR) ?? []) {
    const id = element.dataset.messageId;
    if (id) ids.add(id);
  }
  return ids;
}

/** 消息区里渲染出来的行是否全部换成了 `previousIds` 之外的（新会话的正文已落位）。 */
function rowsReplaced(scroll: HTMLElement | null, previousIds: Set<string>): boolean {
  const rows = scroll?.querySelectorAll<HTMLElement>(ROW_SELECTOR);
  if (!rows?.length) return false;
  for (const element of rows) {
    const id = element.dataset.messageId;
    if (!id || previousIds.has(id)) return false;
  }
  return true;
}

function cancelContentFade(fade: FadeRef) {
  fade.current?.cancel();
  fade.current = undefined;
}

function slideContent(
  scroll: HTMLElement | null,
  fade: FadeRef,
  from: number,
  to: number,
  fill: boolean,
) {
  cancelContentFade(fade);
  if (!scroll || prefersReducedMotion(scroll)) return;
  fade.current = scroll.animate([{ opacity: from }, { opacity: to }], {
    duration: fill ? surfaceMotionTiming.switch : surfaceMotionTiming.enter,
    easing: fill ? 'ease-out' : surfaceMotionTiming.easing,
    fill: fill ? 'forwards' : undefined,
  });
}

export function useConversationSwitchVeil({
  scope,
  scrollRef,
  hasMessages,
  loading,
}: {
  scope: string | undefined;
  scrollRef: { current: HTMLDivElement | null };
  hasMessages: boolean;
  loading: boolean;
}): { veil: boolean; leaving: boolean } {
  const watch = useRef<Watch>({ scope, ids: new Set() });
  const contentFade = useRef<Animation | undefined>(undefined);
  const [veiled, setVeiled] = useState(false);

  // 渲染期抓「切换前」的正文 id：等提交时消息区可能已经换成新会话的了。
  if (watch.current.scope !== scope) {
    watch.current = { scope, ids: rowIds(scrollRef.current) };
  }

  // 换会话：重置观察窗。已经换上新正文（内存里还留着这个会话的窗口）就不铺骨架。
  useLayoutEffect(() => {
    const current = watch.current;
    if (current.scope !== scope) return;
    cancelContentFade(contentFade);
    setVeiled(false);
    if (rowsReplaced(scrollRef.current, current.ids)) return;
    current.timer = setTimeout(() => {
      if (watch.current !== current) return;
      setVeiled(true);
      slideContent(scrollRef.current, contentFade, 1, 0, true);
    }, WATCH_MS);
    return () => {
      if (current.timer) clearTimeout(current.timer);
      current.timer = undefined;
    };
  }, [scope, scrollRef]);

  // 新正文落位（或确认这个会话没有消息）时收起骨架，把正文淡回来。
  useLayoutEffect(() => {
    const current = watch.current;
    if (current.scope !== scope) return;
    const replaced = rowsReplaced(scrollRef.current, current.ids);
    if (!replaced && !(hasMessages === false && !loading)) return;
    if (current.timer) {
      clearTimeout(current.timer);
      current.timer = undefined;
    }
    if (veiled) {
      setVeiled(false);
      slideContent(scrollRef.current, contentFade, 0, 1, false);
    } else {
      cancelContentFade(contentFade);
    }
  }, [hasMessages, loading, veiled, scope, scrollRef]);

  const waiting = veiled || (loading && !hasMessages);
  const retained = useClosingContent(waiting ? true : null, scope);
  return { veil: Boolean(retained), leaving: Boolean(retained) && !waiting };
}
