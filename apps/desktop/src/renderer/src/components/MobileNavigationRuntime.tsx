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
    let tabDirection = 0;
    const contentTarget = () =>
      element.querySelector<HTMLElement>('.weq-mobile-more') ??
      (element.hasAttribute('data-mobile-workspace')
        ? element.querySelector<HTMLElement>('.chat-main')
        : element.querySelector<HTMLElement>('.sidebar-body, .sidebar'));
    const adjacentTab = (direction: number) => {
      const tabs = [...element.querySelectorAll<HTMLButtonElement>('.weq-mobile-tabs > button')];
      const current = tabs.findIndex((tab) => tab.getAttribute('aria-current') === 'page');
      return current < 0 ? undefined : tabs[current + direction];
    };
    let swipe:
      | {
          x: number;
          y: number;
          distance: number;
          started: number;
          target: HTMLElement;
          dragging: boolean;
          kind: 'back' | 'tab';
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
          direction === 'root' ? contentTarget() : (mobileBackTarget() ?? contentTarget());
        if (!target) return;
        const horizontal = direction === 'root' ? tabDirection : direction === 'back' ? -1 : 1;
        tabDirection = 0;
        animate(
          target,
          reduced.matches || !horizontal
            ? [{ opacity: 0.65 }, { opacity: 1 }]
            : [
                {
                  transform: `translateX(${horizontal * 12}%)`,
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
      const backTarget = mobileBackTarget();
      const navigation = element.querySelector('.weq-mobile-navigation');
      const rootPage =
        navigation &&
        !navigation.hasAttribute('hidden') &&
        !element.hasAttribute('data-mobile-detail');
      const kind = backTarget && touch.clientX <= 24 ? 'back' : rootPage ? 'tab' : null;
      const target = kind === 'back' ? backTarget : contentTarget();
      if (!kind || !target) return;
      let origin = event.target instanceof Element ? event.target : null;
      if (
        origin?.closest(
          'input, textarea, select, [contenteditable="true"], [role="slider"], [data-no-swipe-back], .weq-mobile-header, .weq-mobile-tabs',
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
        kind,
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
        if (dy > 10 || (swipe.kind === 'back' && dx < -8)) {
          clearSwipe();
          return;
        }
        if (Math.abs(dx) < 8 || Math.abs(dx) <= dy) return;
        if (swipe.kind === 'tab' && !adjacentTab(dx < 0 ? 1 : -1)) {
          clearSwipe();
          return;
        }
        swipe.dragging = true;
        element.dataset.mobileSwiping = 'true';
      }
      if (!event.cancelable) {
        clearSwipe();
        return;
      }
      event.preventDefault();
      swipe.distance = Math.max(
        swipe.kind === 'back' ? 0 : -element.clientWidth,
        Math.min(dx, element.clientWidth),
      );
      if (reduced.matches)
        swipe.target.style.opacity = String(
          1 - (Math.abs(swipe.distance) / Math.max(element.clientWidth, 1)) * 0.4,
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
          Math.abs(current.distance),
          performance.now() - current.started,
          element.clientWidth,
        );
      const sign = current.distance < 0 ? -1 : 1;
      const next = current.kind === 'tab' ? adjacentTab(-sign) : undefined;
      const accepted = commit && (current.kind === 'back' || Boolean(next));
      const endDistance = accepted ? sign * element.clientWidth : 0;
      const frames = reduced.matches
        ? [{ opacity: current.target.style.opacity || 1 }, { opacity: accepted ? 0.6 : 1 }]
        : [
            { transform: `translateX(${current.distance}px)` },
            { transform: `translateX(${endDistance}px)` },
          ];
      completing = accepted;
      if (reduced.matches) current.target.style.opacity = accepted ? '0.6' : '1';
      else current.target.style.transform = `translateX(${endDistance}px)`;
      animate(current.target, frames, 200, () => {
        if (accepted && current.kind === 'tab' && next) {
          tabDirection = -sign;
          completing = false;
          clearSwipe();
          next.click();
          return;
        }
        if (accepted && mobileBack()) return;
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
