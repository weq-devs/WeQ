/** 隐藏容器的滚动尺寸为零，不能把它当作同时到达上下边缘。 */
export function isConversationPagingVisible(scroll: HTMLElement): boolean {
  return (
    scroll.isConnected &&
    scroll.ownerDocument.visibilityState !== 'hidden' &&
    !scroll.closest('[hidden], [inert]') &&
    scroll.clientHeight > 0 &&
    scroll.clientWidth > 0 &&
    scroll.getClientRects().length > 0
  );
}

export function observeConversationPaging(
  scroll: HTMLElement,
  older: (scroll: HTMLElement) => void,
  newer: (scroll: HTMLElement) => void,
): () => void {
  let frame: number | null = null;
  let stopped = false;
  function check(): void {
    frame = null;
    if (stopped || !isConversationPagingVisible(scroll)) return;
    const threshold = Math.max(32, scroll.clientHeight / 5);
    if (scroll.scrollTop <= threshold || scroll.scrollHeight <= scroll.clientHeight + 32)
      older(scroll);
    if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= threshold) newer(scroll);
  }
  function schedule(): void {
    if (!stopped && frame === null) frame = window.requestAnimationFrame(check);
  }
  scroll.addEventListener('scroll', schedule, { passive: true });
  scroll.ownerDocument.addEventListener('visibilitychange', schedule);
  // 工作区返回不改变 shell.view；尺寸恢复时重新检查，而非在隐藏期间轮询。
  const resize = new ResizeObserver(schedule);
  resize.observe(scroll);
  schedule();
  return () => {
    stopped = true;
    scroll.removeEventListener('scroll', schedule);
    scroll.ownerDocument.removeEventListener('visibilitychange', schedule);
    resize.disconnect();
    if (frame !== null) window.cancelAnimationFrame(frame);
  };
}
