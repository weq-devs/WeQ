function visible(element: Element, root: Element): boolean {
  if (!root.isConnected || !element.isConnected) return false;
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    if (current.hasAttribute('hidden') || style.display === 'none' || style.visibility === 'hidden')
      return false;
    if (current === root) return true;
  }
  return false;
}

/** 只确认界面提交和绘制，不等待列表、消息等业务数据。 */
export function observeRemoteStartupSurface(
  root: Element,
  selector: string,
  ready: () => void,
  progress?: (message: string) => void,
  pendingSelector = '[data-weq-startup-pending]',
): () => void {
  let frame = 0;
  let closed = false;
  let lastStage = '';
  const prepared = () => {
    const surface = [...root.querySelectorAll(selector)].some((element) => visible(element, root));
    const pending = [...root.querySelectorAll(pendingSelector)].some((element) =>
      visible(element, root),
    );
    const stage = pending
      ? '正在加载界面模块'
      : surface
        ? '正在绘制 WeQ 界面'
        : '正在挂载 WeQ 界面';
    if (stage !== lastStage) {
      lastStage = stage;
      progress?.(stage);
    }
    return surface && !pending;
  };
  const check = () => {
    if (closed) return;
    if (!prepared()) {
      window.cancelAnimationFrame(frame);
      frame = 0;
      return;
    }
    // 无关业务更新不重置已安排的绘制确认；只有界面隐藏或整页占位恢复才撤销。
    if (frame) return;
    // 给布局及首帧一次绘制机会，下一帧重新核对，避免查询回调早于 DOM 提交。
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (!closed && prepared()) {
          closed = true;
          observer.disconnect();
          ready();
        }
      });
    });
  };
  const observer = new MutationObserver(check);
  observer.observe(root, { subtree: true, childList: true, attributes: true });
  check();
  return () => {
    closed = true;
    observer.disconnect();
    window.cancelAnimationFrame(frame);
  };
}
