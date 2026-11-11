export function reportSwipeDirection(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dy) < 48 || Math.abs(dy) < Math.abs(dx) * 1.5) return 0;
  return dy < 0 ? 1 : -1;
}

export function reportGestureTarget(target: EventTarget | null): target is HTMLElement {
  return (
    target instanceof Element &&
    !target.closest(
      'button, a, input, textarea, select, [contenteditable="true"], [role="slider"], canvas, svg, [data-no-report-swipe]',
    )
  );
}

/** 使用手势开始时的边缘状态，滚到底的同一次滑动不能接着翻页。 */
export function reportCanTurn(target: Element, host: HTMLElement, direction: 1 | -1): boolean {
  for (let node: Element | null = target; node && node !== host; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    const overflow = node.ownerDocument.defaultView?.getComputedStyle(node).overflowY;
    if (!/auto|scroll/.test(overflow ?? '') || node.scrollHeight <= node.clientHeight + 1) continue;
    if (
      direction === 1
        ? node.scrollTop + node.clientHeight < node.scrollHeight - 1
        : node.scrollTop > 1
    )
      return false;
  }
  return true;
}
