export interface ConversationReadingPosition {
  scrollTop: number;
  anchorId?: string;
  anchorSeq?: string;
  offset?: number;
  alignToEnd?: boolean;
  bottomInset?: number;
}

export function captureReadingPosition(scroll: HTMLElement): ConversationReadingPosition {
  const top = scroll.getBoundingClientRect().top;
  const rows = scroll.querySelectorAll<HTMLElement>('.message-line[data-message-id]');
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rows[mid]!.getBoundingClientRect().bottom <= top) low = mid + 1;
    else high = mid;
  }
  const anchor = rows[Math.min(low, rows.length - 1)];
  return {
    scrollTop: scroll.scrollTop,
    anchorId: anchor?.dataset.messageId,
    offset: anchor ? anchor.getBoundingClientRect().top - top : undefined,
  };
}

export function restoreReadingPosition(
  scroll: HTMLElement,
  position: ConversationReadingPosition,
): void {
  const anchor = Array.from(
    scroll.querySelectorAll<HTMLElement>('.message-line[data-message-id]'),
  ).find((row) => row.dataset.messageId === position.anchorId);
  scroll.scrollTop = anchor
    ? scroll.scrollTop +
      (position.alignToEnd
        ? anchor.getBoundingClientRect().bottom - scroll.clientHeight + (position.bottomInset ?? 0)
        : anchor.getBoundingClientRect().top - (position.offset ?? 0)) -
      scroll.getBoundingClientRect().top
    : position.scrollTop;
}
