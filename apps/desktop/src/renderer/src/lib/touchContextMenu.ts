/** 在整个 Web 文档（包括 portal）复用桌面右键入口，不依赖视口宽度或浏览器原生长按。 */
export function installTouchContextMenu(document: Document): () => void {
  const view = document.defaultView;
  if (!view) return () => {};
  let hold: { id: number; target: Element; x: number; y: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let synthetic: Event | undefined;
  let suppressUntil = 0;
  const editable = (target: EventTarget | null) =>
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    hold = undefined;
  };
  const start = (event: PointerEvent) => {
    cancel();
    suppressUntil = 0;
    if (
      event.pointerType !== 'touch' ||
      !event.isPrimary ||
      event.button !== 0 ||
      !(event.target instanceof Element) ||
      editable(event.target)
    )
      return;
    const current = {
      id: event.pointerId,
      target: event.target,
      x: event.clientX,
      y: event.clientY,
    };
    hold = current;
    timer = setTimeout(() => {
      timer = undefined;
      if (!current.target.isConnected) return cancel();
      suppressUntil = Number.POSITIVE_INFINITY;
      synthetic = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        composed: true,
        view,
        button: 2,
        buttons: 2,
        clientX: current.x,
        clientY: current.y,
      });
      current.target.dispatchEvent(synthetic);
      synthetic = undefined;
    }, 460);
  };
  const move = (event: PointerEvent) => {
    if (
      timer !== undefined &&
      hold?.id === event.pointerId &&
      Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 10
    )
      cancel();
  };
  const end = (event: PointerEvent) => {
    if (hold?.id !== event.pointerId) return;
    if (suppressUntil) {
      event.preventDefault();
      suppressUntil = Date.now() + 800;
    }
    cancel();
  };
  const context = (event: MouseEvent) => {
    if (event === synthetic || editable(event.target)) return;
    // 某些 WebView 会在自定义计时器前后另发原生 contextmenu，统一消费以免菜单开两次。
    if (hold || Date.now() < suppressUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const click = (event: MouseEvent) => {
    if (Date.now() >= suppressUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const selection = (event: Event) => {
    if (hold && !editable(event.target)) event.preventDefault();
  };
  const interrupt = () => {
    cancel();
    if (suppressUntil) suppressUntil = Date.now() + 800;
  };
  const scroll = () => {
    if (timer !== undefined) cancel();
  };
  const leave = (event: PointerEvent) => {
    if (!event.relatedTarget) interrupt();
  };
  document.documentElement.classList.add('weq-touch-context-menu');
  document.addEventListener('pointerdown', start, true);
  document.addEventListener('pointermove', move, { capture: true, passive: true });
  document.addEventListener('pointerup', end, true);
  document.addEventListener('pointercancel', end, true);
  document.addEventListener('lostpointercapture', end, true);
  document.addEventListener('pointerout', leave, true);
  document.addEventListener('contextmenu', context, true);
  document.addEventListener('click', click, true);
  document.addEventListener('selectstart', selection, true);
  document.addEventListener('scroll', scroll, true);
  document.addEventListener('visibilitychange', interrupt);
  view.addEventListener('blur', interrupt);
  return () => {
    cancel();
    document.documentElement.classList.remove('weq-touch-context-menu');
    document.removeEventListener('pointerdown', start, true);
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', end, true);
    document.removeEventListener('pointercancel', end, true);
    document.removeEventListener('lostpointercapture', end, true);
    document.removeEventListener('pointerout', leave, true);
    document.removeEventListener('contextmenu', context, true);
    document.removeEventListener('click', click, true);
    document.removeEventListener('selectstart', selection, true);
    document.removeEventListener('scroll', scroll, true);
    document.removeEventListener('visibilitychange', interrupt);
    view.removeEventListener('blur', interrupt);
  };
}
