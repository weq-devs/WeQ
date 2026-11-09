import { useEffect, type RefObject } from 'react';
import { attachMobileHistory, mobileBack, mobileBackTarget } from '../hooks/useMobileNavigation';
import { shouldCompleteMobileSwipe } from '../lib/mobileNavigation';
import { topSurface } from '../lib/surfaceEscape';
import '../styles/mobile-navigation.css';

export function MobileNavigationRuntime({ root }: { root: RefObject<HTMLElement | null> }) {
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const mobile = window.matchMedia('(max-width: 760px)');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let detach: (() => void) | undefined;
    let frame = 0;
    let animation: Animation | undefined;
    let completing = false;
    let swipe:
      | {
          x: number;
          y: number;
          distance: number;
          started: number;
          target: HTMLElement;
          dragging: boolean;
        }
      | undefined;
    const clearSwipe = () => {
      if (swipe) {
        swipe.target.style.removeProperty('transform');
        swipe.target.style.removeProperty('opacity');
      }
      swipe = undefined;
      delete element.dataset.mobileSwiping;
    };
    const animate = (
      target: HTMLElement,
      frames: Keyframe[],
      duration: number,
      done?: () => void,
    ) => {
      animation?.cancel();
      if (!target.animate) {
        done?.();
        return;
      }
      animation = target.animate(frames, {
        duration: reduced.matches ? 100 : duration,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      });
      animation.finished.then(
        () => done?.(),
        () => {},
      );
    };
    const navigate = (event: Event) => {
      if (completing) {
        completing = false;
        clearSwipe();
        return;
      }
      if (topSurface(document)) return;
      const direction = (event as CustomEvent<string>).detail;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const target =
          direction === 'root'
            ? element.querySelector<HTMLElement>('.app-shell')
            : (mobileBackTarget() ?? element.querySelector<HTMLElement>('.app-shell'));
        if (!target) return;
        animate(
          target,
          reduced.matches || direction === 'root'
            ? [{ opacity: 0.65 }, { opacity: 1 }]
            : [
                {
                  transform: `translateX(${direction === 'back' ? '-12%' : '12%'})`,
                  opacity: 0.75,
                },
                { transform: 'translateX(0)', opacity: 1 },
              ],
          direction === 'root' ? 120 : 200,
        );
      });
    };
    const start = (event: TouchEvent) => {
      if (!mobile.matches || event.touches.length !== 1 || completing || topSurface(document))
        return;
      const touch = event.touches[0]!;
      const target = mobileBackTarget();
      if (!target || touch.clientX > 24) return;
      let origin = event.target instanceof Element ? event.target : null;
      if (
        origin?.closest(
          'input, textarea, select, [contenteditable="true"], [role="slider"], [data-no-swipe-back]',
        )
      )
        return;
      while (origin && origin !== element) {
        if (
          origin.scrollWidth > origin.clientWidth + 1 &&
          /auto|scroll/.test(getComputedStyle(origin).overflowX)
        )
          return;
        origin = origin.parentElement;
      }
      animation?.cancel();
      swipe = {
        x: touch.clientX,
        y: touch.clientY,
        distance: 0,
        started: performance.now(),
        target,
        dragging: false,
      };
    };
    const move = (event: TouchEvent) => {
      if (!swipe) return;
      if (event.touches.length !== 1) {
        clearSwipe();
        return;
      }
      const touch = event.touches[0]!;
      const dx = touch.clientX - swipe.x,
        dy = Math.abs(touch.clientY - swipe.y);
      if (!swipe.dragging) {
        if (dy > 10 || dx < -8) {
          clearSwipe();
          return;
        }
        if (dx < 8 || dx <= dy) return;
        swipe.dragging = true;
        element.dataset.mobileSwiping = 'true';
      }
      if (!event.cancelable) {
        clearSwipe();
        return;
      }
      event.preventDefault();
      swipe.distance = Math.max(0, Math.min(dx, element.clientWidth));
      if (reduced.matches)
        swipe.target.style.opacity = String(
          1 - (swipe.distance / Math.max(element.clientWidth, 1)) * 0.4,
        );
      else swipe.target.style.transform = `translateX(${swipe.distance}px)`;
    };
    const finish = (cancelled: boolean) => {
      if (!swipe) return;
      const current = swipe;
      if (!current.dragging) {
        clearSwipe();
        return;
      }
      const commit =
        !cancelled &&
        shouldCompleteMobileSwipe(
          current.distance,
          performance.now() - current.started,
          element.clientWidth,
        );
      const frames = reduced.matches
        ? [{ opacity: current.target.style.opacity || 1 }, { opacity: commit ? 0.6 : 1 }]
        : [
            { transform: `translateX(${current.distance}px)` },
            { transform: `translateX(${commit ? element.clientWidth : 0}px)` },
          ];
      completing = commit;
      if (reduced.matches) current.target.style.opacity = commit ? '0.6' : '1';
      else current.target.style.transform = `translateX(${commit ? element.clientWidth : 0}px)`;
      animate(current.target, frames, 200, () => {
        if (commit && mobileBack()) return;
        completing = false;
        clearSwipe();
      });
    };
    const end = () => finish(false);
    const cancel = () => finish(true);
    const resize = () => {
      completing = false;
      animation?.cancel();
      clearSwipe();
      if (mobile.matches && !detach) detach = attachMobileHistory();
      else if (!mobile.matches && detach) {
        detach();
        detach = undefined;
      }
    };
    resize();
    mobile.addEventListener('change', resize);
    window.addEventListener('weq-mobile-navigate', navigate);
    element.addEventListener('touchstart', start, { passive: true, capture: true });
    element.addEventListener('touchmove', move, { passive: false, capture: true });
    element.addEventListener('touchend', end, true);
    element.addEventListener('touchcancel', cancel, true);
    return () => {
      detach?.();
      animation?.cancel();
      cancelAnimationFrame(frame);
      clearSwipe();
      mobile.removeEventListener('change', resize);
      window.removeEventListener('weq-mobile-navigate', navigate);
      element.removeEventListener('touchstart', start, true);
      element.removeEventListener('touchmove', move, true);
      element.removeEventListener('touchend', end, true);
      element.removeEventListener('touchcancel', cancel, true);
    };
  }, [root]);
  return null;
}
