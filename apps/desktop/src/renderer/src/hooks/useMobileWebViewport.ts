import { useEffect, type RefObject } from 'react';

/** 软键盘可能只缩小 visual viewport；双指缩放时不重排，以保留浏览器放大阅读。 */
export function observeMobileWebViewport(element: HTMLElement): () => void {
  const viewport = window.visualViewport;
  const mobile = window.matchMedia('(max-width: 760px)');
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
    const height = viewport?.height ?? window.innerHeight;
    if (height <= 0) return;
    element.style.setProperty('--weq-mobile-viewport-height', `${height}px`);
    element.style.setProperty('--weq-mobile-viewport-top', `${viewport?.offsetTop ?? 0}px`);
  };
  update();
  viewport?.addEventListener('resize', update);
  viewport?.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  mobile.addEventListener('change', update);
  return () => {
    viewport?.removeEventListener('resize', update);
    viewport?.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
    mobile.removeEventListener('change', update);
    clear();
  };
}

export function useMobileWebViewport(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    if (enabled && ref.current) return observeMobileWebViewport(ref.current);
    return undefined;
  }, [enabled, ref]);
}
