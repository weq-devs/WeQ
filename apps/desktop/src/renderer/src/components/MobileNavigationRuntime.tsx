import { useEffect, useLayoutEffect, type RefObject } from 'react';
import {
  attachMobileHistory,
  isMobileNavigation,
  mobileBack,
  mobileBackEntry,
  mobileBackTarget,
} from '../hooks/useMobileNavigation';
import { isSingleColumnLayout, subscribeResponsiveLayout } from '../lib/responsiveLayout';
import { shouldCompleteMobileSwipe, type MobileNavigationChange } from '../lib/mobileNavigation';
import { containingSurface, topSurface } from '../lib/surfaceEscape';
import { setMobileNavigationBusy } from '../lib/mobilePageLoading';
import { createMobileRootTransition, mobileRootTab } from '../lib/mobileRootTransition';
import { createMobileBackPreview } from '../lib/mobileBackPreview';
import '../styles/mobile-navigation.css';
import { observeRemoteWindowLayout } from '../lib/remoteWindowLayout';
import '../styles/remote-window-layout.css';

export function MobileNavigationRuntime({ root }: { root: RefObject<HTMLElement | null> }) {
  useLayoutEffect(() => observeRemoteWindowLayout(root.current?.ownerDocument ?? document), [root]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let detach: (() => void) | undefined;
    let frame = 0;
    let animation: Animation | undefined;
    let completing = false;
    let backCommitted = false;
    let removeBackPreview: (() => void) | undefined;
    const cancelAnimation = () => {
      const current = animation;
      animation = undefined;
      current?.cancel();
    };
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
          origin: Element;
          target: HTMLElement;
          dragging: boolean;
          kind: 'back' | 'tab';
          direction?: number;
          entryId?: string;
          identifier: number;
          width: number;
          reduced: boolean;
          style: { transform: string; opacity: string; willChange: string };
        }
      | undefined;
    const clearSwipe = () => {
      removeBackPreview?.();
      removeBackPreview = undefined;
      if (swipe) {
        Object.assign(swipe.target.style, swipe.style);
      }
      swipe = undefined;
      backCommitted = false;
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
      cancelAnimation();
      setMobileNavigationBusy(true);
      if (!target.animate) {
        setMobileNavigationBusy(false);
        done?.();
        return;
      }
      const current = target.animate(frames, {
        duration: reduced() ? 100 : duration,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      });
      animation = current;
      current.finished.then(
        () => {
          if (animation !== current) return;
          animation = undefined;
          if (!done) setMobileNavigationBusy(false);
          done?.();
        },
        () => {},
      );
    };
    const navigate = (event: Event) => {
      if (rootTransition) return;
      if (completing && backCommitted) {
        // 等页面提交并绘制后再还原被拖动节点，避免先闪回退出前的页面。
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            completing = false;
            clearSwipe();
          });
        });
        return;
      }
      cancelAnimation();
      cancelAnimationFrame(frame);
      completing = false;
      clearSwipe();
      const { direction, source } = (event as CustomEvent<MobileNavigationChange>).detail;
      // 浮层或已卸载页面的退栈不应让背后的会话重播进入动画。
      const canAnimate = () =>
        !topSurface(document) && !(source && (!source.isConnected || containingSurface(source)));
      if (!canAnimate()) return;
      setMobileNavigationBusy(true);
      frame = requestAnimationFrame(() => {
        if (!canAnimate()) {
          setMobileNavigationBusy(false);
          return;
        }
        const target =
          direction === 'root' ? contentTarget() : (mobileBackTarget() ?? contentTarget());
        if (!target) {
          setMobileNavigationBusy(false);
          return;
        }
        // 子页可能已经绘制，晚到的返回栈通知不能让它先横移再滑回。
        animate(target, [{ opacity: 0.9 }, { opacity: 1 }], 120);
      });
    };
    const clickTab = (event: MouseEvent) => {
      if (
        !isSingleColumnLayout() ||
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
      cancelAnimation();
      rootTransition = createMobileRootTransition(element, from, to, reduced());
      if (!rootTransition) return;
      setMobileNavigationBusy(true);
      void completeRootTransition(0, true);
    };
    const start = (event: TouchEvent) => {
      if (swipe) {
        if (event.touches.length !== 1) finish(true);
        return;
      }
      if (!isSingleColumnLayout() || event.touches.length !== 1 || completing) return;
      const touch = event.touches[0]!;
      const entry = mobileBackEntry();
      const backTarget = mobileBackTarget();
      const surface = topSurface(document);
      const origin = event.target instanceof Element ? event.target : null;
      // Portal 和主页面共用手势入口，但只能操作当前最上层，不能穿过不可关闭的弹窗。
      if (surface) {
        if (!backTarget || !surface.contains(backTarget) || !origin || !surface.contains(origin))
          return;
      } else if (!origin || !element.contains(origin)) return;
      const navigation = element.querySelector('.weq-mobile-navigation');
      const rootPage =
        mobileRootTab(element.dataset.mobileRootView) &&
        navigation &&
        navigation.getAttribute('aria-hidden') !== 'true' &&
        !element.hasAttribute('data-mobile-detail');
      const kind = backTarget && touch.clientX <= 24 ? 'back' : !surface && rootPage ? 'tab' : null;
      const target = kind === 'back' ? backTarget : contentTarget();
      if (!kind || !target) return;
      if (
        document.getSelection()?.isCollapsed === false ||
        origin.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], video[controls], audio[controls], [data-no-swipe-back], .weq-mobile-header, .weq-mobile-tabs',
        )
      )
        return;
      cancelAnimationFrame(frame);
      cancelAnimation();
      swipe = {
        x: touch.clientX,
        y: touch.clientY,
        distance: 0,
        started: performance.now(),
        origin,
        target,
        dragging: false,
        kind,
        entryId: entry?.id,
        identifier: touch.identifier,
        width: element.clientWidth,
        reduced: reduced(),
        style: {
          transform: target.style.transform,
          opacity: target.style.opacity,
          willChange: target.style.willChange,
        },
      };
    };
    const move = (event: TouchEvent) => {
      if (!swipe || completing) return;
      if (event.touches.length !== 1 || event.touches[0]?.identifier !== swipe.identifier) {
        finish(true);
        return;
      }
      const touch = event.touches[0]!;
      const dx = touch.clientX - swipe.x,
        dy = Math.abs(touch.clientY - swipe.y);
      if (!swipe.dragging) {
        if ((dy > 8 && dy >= Math.abs(dx)) || (swipe.kind === 'back' && dx < -8)) {
          clearSwipe();
          return;
        }
        if (Math.abs(dx) < 8 || Math.abs(dx) <= dy) return;
        if (!event.cancelable) {
          clearSwipe();
          return;
        }
        // 只有确认为横向拖动时才读取祖先布局。普通上下滚动直接走原生滚动。
        for (
          let node: Element | null = swipe.origin;
          node && node !== element;
          node = node.parentElement
        ) {
          const style = getComputedStyle(node);
          if (
            style.touchAction === 'none' ||
            /\bpan-x\b/.test(style.touchAction) ||
            (/auto|scroll/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1)
          ) {
            clearSwipe();
            return;
          }
        }
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
        if (swipe.kind === 'back') removeBackPreview = createMobileBackPreview(swipe.target);
        swipe.target.style.willChange = swipe.reduced ? 'opacity' : 'transform';
        setMobileNavigationBusy(true);
        element.dataset.mobileSwiping = 'true';
      }
      if (!event.cancelable) {
        finish(true);
        return;
      }
      event.preventDefault();
      swipe.distance = Math.max(
        swipe.kind === 'back' ? 0 : -swipe.width,
        Math.min(dx, swipe.width),
      );
      if (swipe.kind === 'tab') {
        swipe.distance =
          swipe.direction === 1 ? Math.min(0, swipe.distance) : Math.max(0, swipe.distance);
        rootTransition?.move(swipe.distance);
        return;
      }
      if (swipe.reduced)
        swipe.target.style.opacity = String(
          1 - (Math.abs(swipe.distance) / Math.max(swipe.width, 1)) * 0.4,
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
          current.width,
        );
      const sign = current.distance < 0 ? -1 : 1;
      const next = current.kind === 'tab' ? adjacentTab(-sign) : undefined;
      const accepted = commit && (current.kind === 'back' || Boolean(next));
      if (current.kind === 'tab') {
        void completeRootTransition(current.distance, accepted, next);
        return;
      }
      const endDistance = accepted ? sign * current.width : 0;
      const frames = current.reduced
        ? [{ opacity: current.target.style.opacity || 1 }, { opacity: accepted ? 0.6 : 1 }]
        : [
            { transform: `translateX(${current.distance}px)` },
            { transform: `translateX(${endDistance}px)` },
          ];
      completing = true;
      element.dataset.mobileAnimating = 'true';
      if (current.reduced) current.target.style.opacity = accepted ? '0.6' : '1';
      else current.target.style.transform = `translateX(${endDistance}px)`;
      animate(current.target, frames, 200, () => {
        backCommitted = accepted;
        if (accepted && mobileBack(current.entryId)) return;
        completing = false;
        clearSwipe();
      });
    };
    const end = (event: TouchEvent) => {
      const ended = [...event.changedTouches].some(
        (touch) => touch.identifier === swipe?.identifier,
      );
      finish(event.touches.length > 0 || !ended);
    };
    const cancel = () => finish(true);
    const resize = () => {
      completing = false;
      cancelAnimationFrame(frame);
      removeRootTransition();
      cancelAnimation();
      clearSwipe();
      if (isMobileNavigation() && !detach) detach = attachMobileHistory();
      else if (!isMobileNavigation() && detach) {
        detach();
        detach = undefined;
      }
    };
    const visibility = () => {
      if (document.hidden) resize();
    };
    resize();
    document.addEventListener('visibilitychange', visibility);
    const unsubscribeLayout = subscribeResponsiveLayout(resize);
    window.addEventListener('resize', resize);
    window.addEventListener('blur', resize);
    window.addEventListener('weq-mobile-navigate', navigate);
    element.addEventListener('click', clickTab, true);
    document.addEventListener('touchstart', start, { passive: true, capture: true });
    document.addEventListener('touchmove', move, { passive: false, capture: true });
    document.addEventListener('touchend', end, true);
    document.addEventListener('touchcancel', cancel, true);
    return () => {
      detach?.();
      removeRootTransition();
      cancelAnimation();
      cancelAnimationFrame(frame);
      clearSwipe();
      unsubscribeLayout();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', resize);
      window.removeEventListener('weq-mobile-navigate', navigate);
      element.removeEventListener('click', clickTab, true);
      document.removeEventListener('touchstart', start, true);
      document.removeEventListener('touchmove', move, true);
      document.removeEventListener('touchend', end, true);
      document.removeEventListener('touchcancel', cancel, true);
    };
  }, [root]);
  return null;
}
