import { prefersReducedMotion, surfaceMotionTiming } from './surfaceMotion';
import { OVERLAY_BASE_LAYER } from './overlayStack';

/** 放在布局清理中调用，真正卸载后才接入不可交互的画面。 */
export function fadeRemovedSurface(
  element: HTMLElement | null,
  {
    prepare,
    canShow,
    pinToViewport = false,
  }: {
    prepare?: (source: HTMLElement, snapshot: HTMLElement) => void;
    canShow?: () => boolean;
    pinToViewport?: boolean;
  } = {},
) {
  const document = element?.ownerDocument;
  const view = document?.defaultView;
  const parent = pinToViewport ? document?.body : element?.parentElement;
  if (
    !element?.isConnected ||
    !parent ||
    !view ||
    typeof element.animate !== 'function' ||
    !element.offsetWidth ||
    !element.offsetHeight ||
    document.hidden ||
    prefersReducedMotion(element)
  )
    return;
  const style = view.getComputedStyle(element);
  const opacity = Number(style.opacity);
  if (!opacity || style.display === 'none') return;

  const snapshot = element.cloneNode(true) as HTMLElement;
  snapshot.inert = true;
  snapshot.setAttribute('aria-hidden', 'true');
  snapshot.removeAttribute('data-weq-surface-motion');
  snapshot.classList.add('weq-surface-exiting');
  if (pinToViewport) {
    const { left, top, width, height } = element.getBoundingClientRect();
    Object.assign(snapshot.style, {
      position: 'fixed',
      inset: `${top}px auto auto ${left}px`,
      width: `${width}px`,
      height: `${height}px`,
      maxWidth: 'none',
      maxHeight: 'none',
      boxSizing: 'border-box',
      transform: 'none',
      zIndex: String(OVERLAY_BASE_LAYER),
    });
  }
  const targets = snapshot.querySelectorAll<HTMLElement>('*');
  const scroll = [...element.querySelectorAll<HTMLElement>('*')].flatMap((node, index) => {
    const target = targets[index];
    return target && (node.scrollTop || node.scrollLeft)
      ? [{ target, top: node.scrollTop, left: node.scrollLeft }]
      : [];
  });
  prepare?.(element, snapshot);
  // 退出画面不可重启播放器，也不参与页面的 id 查找。
  snapshot.removeAttribute('id');
  for (const child of snapshot.querySelectorAll('[id]')) {
    if (child.namespaceURI === snapshot.namespaceURI) child.removeAttribute('id');
  }
  for (const child of snapshot.querySelectorAll('audio, video, iframe')) child.remove();

  queueMicrotask(() => {
    // StrictMode 的清理演练不会移除原节点。
    if (element.isConnected || !parent.isConnected || canShow?.() === false) return;
    const reduced = view.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches) return;
    parent.prepend(snapshot);
    for (const { target, top, left } of scroll) {
      target.scrollTop = top;
      target.scrollLeft = left;
    }
    const exit = snapshot.animate([{ opacity }, { opacity: 0 }], {
      duration: surfaceMotionTiming.exit,
      easing: 'ease-in',
      fill: 'both',
    });
    const remove = () => {
      snapshot.remove();
      reduced.removeEventListener('change', stopIfReduced);
    };
    const stopIfReduced = () => {
      if (reduced.matches) exit.cancel();
    };
    reduced.addEventListener('change', stopIfReduced);
    void exit.finished.then(remove, remove);
  });
}
