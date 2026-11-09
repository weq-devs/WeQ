import { useEffect, useSyncExternalStore, type RefObject } from 'react';
import { IS_WEB } from '../lib/target';

const mobileWebQuery = '(max-width: 760px)';
const subscribeMobileWeb = (notify: () => void) => {
  if (!IS_WEB) return () => {};
  const media = window.matchMedia(mobileWebQuery);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};
const mobileWebSnapshot = () => IS_WEB && window.matchMedia(mobileWebQuery).matches;

export function useMobileWebLayout() {
  return useSyncExternalStore(subscribeMobileWeb, mobileWebSnapshot, () => false);
}

/** 软键盘可能只缩小 visual viewport；双指缩放时不重排，以保留浏览器放大阅读。 */
export function observeMobileWebViewport(element: HTMLElement): () => void {
  const viewport = window.visualViewport;
  const mobile = window.matchMedia('(max-width: 760px)');
  let leavingKeyboard = false;
  const clear = () => {
    element.style.removeProperty('--weq-mobile-viewport-height');
    element.style.removeProperty('--weq-mobile-viewport-top');
  };
  const update = () => {
    if (!mobile.matches) {
      clear();
      return;
    }
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const editing = document.activeElement?.matches('input, textarea, [contenteditable="true"]');
    if (editing || (viewport?.height ?? window.innerHeight) >= window.innerHeight - 1)
      leavingKeyboard = false;
    const height = leavingKeyboard
      ? Math.max(viewport?.height ?? 0, window.innerHeight)
      : (viewport?.height ?? window.innerHeight);
    if (height <= 0) return;
    element.style.setProperty('--weq-mobile-viewport-height', `${height}px`);
    element.style.setProperty(
      '--weq-mobile-viewport-top',
      `${leavingKeyboard ? 0 : (viewport?.offsetTop ?? 0)}px`,
    );
  };
  const navigate = () => {
    if (!element.classList.contains('app-shell-root')) return;
    // 离开编辑页时键盘的 viewport 事件可能晚于页面切换，不把短暂的小视口带回列表。
    leavingKeyboard = !document.activeElement?.matches('input, textarea, [contenteditable="true"]');
    update();
  };
  update();
  viewport?.addEventListener('resize', update);
  viewport?.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  mobile.addEventListener('change', update);
  window.addEventListener('weq-mobile-navigate', navigate);
  element.addEventListener('focusin', update);
  return () => {
    viewport?.removeEventListener('resize', update);
    viewport?.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
    mobile.removeEventListener('change', update);
    window.removeEventListener('weq-mobile-navigate', navigate);
    element.removeEventListener('focusin', update);
    clear();
  };
}

export function useMobileWebViewport(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    if (enabled && ref.current) return observeMobileWebViewport(ref.current);
    return undefined;
  }, [enabled, ref]);
}
