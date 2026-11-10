import { useEffect, type RefObject } from 'react';
import { attachMobileHistory, mobileBack, mobileBackTarget } from '../hooks/useMobileNavigation';
import { shouldCompleteMobileSwipe } from '../lib/mobileNavigation';
import { topSurface } from '../lib/surfaceEscape';
import { setMobileNavigationBusy } from '../lib/mobilePageLoading';
import { createMobileRootTransition, mobileRootTab } from '../lib/mobileRootTransition';
import '../styles/mobile-navigation.css';

export function MobileNavigationRuntime({ root }: { root: RefObject<HTMLElement | null> }) {
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const mobile = window.matchMedia('(max-width: 760px)');
    const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let detach: (() => void) | undefined;
    let frame = 0;
    let animation: Animation | undefined;
    let completing = false;
    let rootTransition: ReturnType<typeof createMobileRootTransition>;
    let skipRootClick = false;
    const removeRootTransition = () => {
      rootTransition?.destroy();
      rootTransition = undefined;
    };
    const contentTarget = () =>
      element.querySelector<HTMLElement>('.weq-mobile-navigation > .weq-mobile-more') ??
      (element.hasAttribute('data-mobile-workspace')
        ? element.querySelector<HTMLElement>('.app-shell > .chat-main')
        : element.querySelector<HTMLElement>(
            '.app-shell > .sidebar .sidebar-body, .app-shell > .sidebar',
          ));
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
          direction?: number;
        }
      | undefined;
    const clearSwipe = () => {
      if (swipe) {
        swipe.target.style.removeProperty('transform');
        swipe.target.style.removeProperty('opacity');
      }
      swipe = undefined;
      delete element.dataset.mobileSwiping;
      delete element.dataset.mobileAnimating;
      if (!rootTransition) setMobileNavigationBusy(false);
    };
    const completeRootTransition = async (
      distance: number,
      accepted: boolean,
      next?: HTMLButtonElement,
    ) => {
      const current = rootTransition;
      if (!current) return;
      completing = true;
      element.dataset.mobileAnimating = 'true';
      await current.finish(distance, accepted);
      if (rootTransition !== current) return;
      if (accepted && next) {
        skipRootClick = true;
        next.click();
        skipRootClick = false;
      }
      // 保留到 React 提交后的绘制帧，不能先露出尚未切换的旧页。
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (rootTransition !== current) return;
          removeRootTransition();
          completing = false;
          clearSwipe();
        });
      });
    };
    const animate = (
      target: HTMLElement,
      frames: Keyframe[],
      duration: number,
      done?: () => void,
    ) => {
      animation?.cancel();
      setMobileNavigationBusy(true);
      if (!target.animate) {
        setMobileNavigationBusy(false);
        done?.();
        return;
      }
      animation = target.animate(frames, {
        duration: reduced() ? 100 : duration,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      });
      animation.finished.then(
        () => {
          setMobileNavigationBusy(false);
          done?.();
        },
        () => {},
      );
    };
    const navigate = (event: Event) => {
      if (rootTransition) return;
      if (completing) {
        completing = false;
        clearSwipe();
        return;
      }
      if (topSurface(document)) return;
      const direction = (event as CustomEvent<string>).detail;
      setMobileNavigationBusy(true);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const target =
          direction === 'root' ? contentTarget() : (mobileBackTarget() ?? contentTarget());
        if (!target) {
          setMobileNavigationBusy(false);
          return;
        }
        const horizontal = direction === 'root' ? 0 : direction === 'back' ? -1 : 1;
        animate(
          target,
          reduced() || !horizontal
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
    const clickTab = (event: MouseEvent) => {
      if (
        !mobile.matches ||
        skipRootClick ||
        element.hasAttribute('data-mobile-detail') ||
        topSurface(document)
      )
        return;
      const button =
        event.target instanceof Element
          ? event.target.closest<HTMLButtonElement>('.weq-mobile-tabs > button')
          : null;
      const from = mobileRootTab(element.dataset.mobileRootView);
      const to = mobileRootTab(button?.dataset.mobileTab);
      if (!from || !to || from === to) return;
      removeRootTransition();
      completing = false;
      clearSwipe();
      animation?.cancel();
      rootTransition = createMobileRootTransition(element, from, to, reduced());
      if (!rootTransition) return;
      setMobileNavigationBusy(true);
      void completeRootTransition(0, true);
    };
    const start = (event: TouchEvent) => {
      if (!mobile.matches || event.touches.length !== 1 || completing || topSurface(document))
        return;
      const touch = event.touches[0]!;
      const backTarget = mobileBackTarget();
      const navigation = element.querySelector('.weq-mobile-navigation');
      const rootPage =
        mobileRootTab(element.dataset.mobileRootView) &&
        navigation &&
        navigation.getAttribute('aria-hidden') !== 'true' &&
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
        finish(true);
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
        if (swipe.kind === 'tab') {
          const direction = dx < 0 ? 1 : -1;
          const from = mobileRootTab(element.dataset.mobileRootView);
          const to = mobileRootTab(adjacentTab(direction)?.dataset.mobileTab);
          if (!from || !to) {
            clearSwipe();
            return;
          }
          rootTransition = createMobileRootTransition(element, from, to, reduced());
          if (!rootTransition) {
            clearSwipe();
            return;
          }
          swipe.direction = direction;
        }
        swipe.dragging = true;
        setMobileNavigationBusy(true);
        element.dataset.mobileSwiping = 'true';
      }
      if (!event.cancelable) {
        finish(true);
        return;
      }
      event.preventDefault();
      swipe.distance = Math.max(
        swipe.kind === 'back' ? 0 : -element.clientWidth,
        Math.min(dx, element.clientWidth),
      );
      if (swipe.kind === 'tab') {
        swipe.distance =
          swipe.direction === 1 ? Math.min(0, swipe.distance) : Math.max(0, swipe.distance);
        rootTransition?.move(swipe.distance);
        return;
      }
      if (reduced())
        swipe.target.style.opacity = String(
          1 - (Math.abs(swipe.distance) / Math.max(element.clientWidth, 1)) * 0.4,
        );
      else swipe.target.style.transform = `translateX(${swipe.distance}px)`;
    };
    const finish = (cancelled: boolean) => {
      if (!swipe || completing) return;
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
      if (current.kind === 'tab') {
        void completeRootTransition(current.distance, accepted, next);
        return;
      }
      const endDistance = accepted ? sign * element.clientWidth : 0;
      const frames = reduced()
        ? [{ opacity: current.target.style.opacity || 1 }, { opacity: accepted ? 0.6 : 1 }]
        : [
            { transform: `translateX(${current.distance}px)` },
            { transform: `translateX(${endDistance}px)` },
          ];
      completing = accepted;
      if (reduced()) current.target.style.opacity = accepted ? '0.6' : '1';
      else current.target.style.transform = `translateX(${endDistance}px)`;
      animate(current.target, frames, 200, () => {
        if (accepted && mobileBack()) return;
        completing = false;
        clearSwipe();
      });
    };
    const end = () => finish(false);
    const cancel = () => finish(true);
    const resize = () => {
      completing = false;
      removeRootTransition();
      animation?.cancel();
      clearSwipe();
      if (mobile.matches && !detach) detach = attachMobileHistory();
      else if (!mobile.matches && detach) {
        detach();
        detach = undefined;
      }
    };
    const visibility = () => {
      if (document.hidden) resize();
    };
    resize();
    document.addEventListener('visibilitychange', visibility);
    mobile.addEventListener('change', resize);
    window.addEventListener('resize', resize);
    window.addEventListener('weq-mobile-navigate', navigate);
    element.addEventListener('click', clickTab, true);
    element.addEventListener('touchstart', start, { passive: true, capture: true });
    element.addEventListener('touchmove', move, { passive: false, capture: true });
    element.addEventListener('touchend', end, true);
    element.addEventListener('touchcancel', cancel, true);
    return () => {
      detach?.();
      removeRootTransition();
      animation?.cancel();
      cancelAnimationFrame(frame);
      clearSwipe();
      mobile.removeEventListener('change', resize);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', resize);
      window.removeEventListener('weq-mobile-navigate', navigate);
      element.removeEventListener('click', clickTab, true);
      element.removeEventListener('touchstart', start, true);
      element.removeEventListener('touchmove', move, true);
      element.removeEventListener('touchend', end, true);
      element.removeEventListener('touchcancel', cancel, true);
    };
  }, [root]);
  return null;
}
