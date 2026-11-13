import { useEffect, useSyncExternalStore, type RefObject } from 'react';
import { isSingleColumnLayout, subscribeResponsiveLayout } from '../lib/responsiveLayout';
import '../styles/responsive-layout.css';

/** Remote、Web 和桌面窄窗共用同一套单栏布局。 */
export function useMobileWebLayout() {
  return useSyncExternalStore(subscribeResponsiveLayout, isSingleColumnLayout, () => false);
}

/** 软键盘可能只缩小 visual viewport；双指缩放时不重排，以保留浏览器放大阅读。 */
export function observeMobileWebViewport(element: HTMLElement): () => void {
  const viewport = window.visualViewport;
  let leavingKeyboard = false;
  let keyboardOpen = false;
  let layoutWidth = window.innerWidth;
  let layoutHeight = window.innerHeight;
  const clear = () => {
    element.style.removeProperty('--weq-mobile-viewport-height');
    element.style.removeProperty('--weq-mobile-viewport-top');
    element.style.removeProperty('--weq-mobile-safe-bottom');
    keyboardOpen = false;
  };
  const update = () => {
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const editing = document.activeElement?.matches('input, textarea, [contenteditable="true"]');
    if (editing || (viewport?.height ?? window.innerHeight) >= window.innerHeight - 1)
      leavingKeyboard = false;
    const height = leavingKeyboard
      ? Math.max(viewport?.height ?? 0, window.innerHeight)
      : (viewport?.height ?? window.innerHeight);
    if (height <= 0) return;
    if (layoutWidth !== window.innerWidth || (!editing && !keyboardOpen)) {
      layoutWidth = window.innerWidth;
      layoutHeight = window.innerHeight;
    } else {
      // Android 可能连布局视口一起缩小，保留聚焦前的高度用于判断软键盘。
      layoutHeight = Math.max(layoutHeight, window.innerHeight);
    }
    keyboardOpen = !leavingKeyboard && !!(editing || keyboardOpen) && layoutHeight - height > 120;
    if (keyboardOpen) element.style.setProperty('--weq-mobile-safe-bottom', '0px');
    else element.style.removeProperty('--weq-mobile-safe-bottom');
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
  window.addEventListener('weq-mobile-navigate', navigate);
  element.addEventListener('focusin', update);
  return () => {
    viewport?.removeEventListener('resize', update);
    viewport?.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
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
