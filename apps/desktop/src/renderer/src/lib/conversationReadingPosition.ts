import {
  timelineViewport,
  TIMELINE_MESSAGE_SELECTOR,
  type ReadingRestoreOptions,
  type TimelineViewport,
} from './timelineViewport';

export interface ConversationReadingPosition {
  scrollTop: number;
  anchorId?: string;
  anchorSeq?: string;
  offset?: number;
  alignToEnd?: boolean;
  bottomInset?: number;
}

/** 只有会话的最新一页才有可清除阅读位置的真正底部。 */
export function atConversationBottom(scroll: HTMLElement, atLatest: boolean): boolean {
  return atLatest && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 4;
}

// 临时布局补偿不能越过新的滚动意图；切会话保存的位置不附带此守卫。
const transientPositions = new WeakMap<
  ConversationReadingPosition,
  { viewport: TimelineViewport | undefined; revision: number | undefined }
>();

export function captureReadingPosition(
  scroll: HTMLElement,
  options?: { transient?: boolean; acceptAnchor?: (id: string) => boolean },
): ConversationReadingPosition {
  const viewport = timelineViewport(scroll);
  const position =
    viewport?.capture?.() ?? captureMountedReadingPosition(scroll, options?.acceptAnchor);
  if (!options?.transient) return position;
  const pending = { ...position };
  transientPositions.set(pending, { viewport, revision: viewport?.scrollRevision?.() });
  return pending;
}

function captureMountedReadingPosition(
  scroll: HTMLElement,
  acceptAnchor?: (id: string) => boolean,
): ConversationReadingPosition {
  const { top, bottom } = scroll.getBoundingClientRect();
  const scrollTop = scroll.scrollTop;
  const rows = scroll.querySelectorAll<HTMLElement>(TIMELINE_MESSAGE_SELECTOR);
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rows[mid]!.getBoundingClientRect().bottom <= top) low = mid + 1;
    else high = mid;
  }
  // 快滚后 DOM 可能仍是上一个范围。只用与当前视口相交的正文做锚点。
  for (let index = low; index < rows.length; index++) {
    const anchor = rows[index]!;
    const rect = anchor.getBoundingClientRect();
    if (rect.top >= bottom) break;
    const anchorId = anchor.dataset.messageId;
    if (rect.height > 0 && anchorId && (!acceptAnchor || acceptAnchor(anchorId)))
      return { scrollTop, anchorId, offset: rect.top - top };
  }
  return { scrollTop };
}

export function restoreReadingPosition(
  scroll: HTMLElement,
  position: ConversationReadingPosition,
  options?: ReadingRestoreOptions,
): void {
  const pending = transientPositions.get(position);
  if (
    pending &&
    (pending.viewport !== timelineViewport(scroll) ||
      pending.revision !== pending.viewport?.scrollRevision?.())
  )
    return;
  if (timelineViewport(scroll)?.restore(position, options)) return;
  const anchor = Array.from(scroll.querySelectorAll<HTMLElement>(TIMELINE_MESSAGE_SELECTOR)).find(
    (row) => row.dataset.messageId === position.anchorId,
  );
  scroll.scrollTop = anchor
    ? scroll.scrollTop +
      (position.alignToEnd
        ? anchor.getBoundingClientRect().bottom - scroll.clientHeight + (position.bottomInset ?? 0)
        : anchor.getBoundingClientRect().top - (position.offset ?? 0)) -
      scroll.getBoundingClientRect().top
    : position.scrollTop;
}

export function restoreReadingPositionAfterPrepend(
  scroll: HTMLElement,
  position: ConversationReadingPosition,
): void {
  // 普通布局也持续测量行高，进入虚拟列表时沿用同一份锚定。
  if (position.anchorId && timelineViewport(scroll)?.offset(position.anchorId) !== undefined)
    return;
  restoreReadingPosition(scroll, position, { ease: true });
}
