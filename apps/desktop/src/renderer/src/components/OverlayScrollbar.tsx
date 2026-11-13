import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  type ReactElement,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTabActive } from './RetainedTabs';
import { timelineViewport } from '../lib/timelineViewport';

type OverlayScrollbarState = {
  top: number;
  left: number;
  height: number;
  thumbTop: number;
  thumbHeight: number;
  visible: boolean;
  canScroll: boolean;
};

const overlayScrollbarInitialState: OverlayScrollbarState = {
  top: 0,
  left: 0,
  height: 0,
  thumbTop: 0,
  thumbHeight: 0,
  visible: false,
  canScroll: false,
};

const OVERLAY_SCROLLBAR_WIDTH = 10;

const OVERLAY_SCROLLBAR_INSET = 8;

const OVERLAY_SCROLLBAR_MIN_THUMB = 34;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function OverlayScrollbar({
  targetSelector,
  scrollRef,
  className,
  refreshKey,
}: {
  targetSelector?: string;
  scrollRef?: RefObject<HTMLElement | null>;
  className: string;
  refreshKey: string;
}): ReactElement | null {
  const [state, setState] = useState<OverlayScrollbarState>(overlayScrollbarInitialState);
  const tabActive = useTabActive();
  const targetRef = useRef<HTMLElement | null>(null);
  const scrollbarRef = useRef<HTMLDivElement | null>(null);
  const hoverRef = useRef(false);
  const draggingRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const dragCleanup = useRef<(() => void) | null>(null);

  const updateScrollbar = useCallback(() => {
    frameRef.current = null;

    const target = targetRef.current;
    if (!target) {
      setState(overlayScrollbarInitialState);
      return;
    }

    const rect = target.getBoundingClientRect();
    const maxScrollTop = target.scrollHeight - target.clientHeight;
    const canScroll = maxScrollTop > 1 && rect.height > 0 && rect.width > 0;
    if (!canScroll) {
      setState((current) => ({ ...current, visible: false, canScroll: false }));
      return;
    }

    const parent = scrollbarRef.current?.offsetParent as HTMLElement | null;
    const parentRect = parent?.getBoundingClientRect();
    const scaleX = parent?.offsetWidth
      ? (parentRect?.width ?? parent.offsetWidth) / parent.offsetWidth || 1
      : 1;
    const scaleY = parent?.offsetHeight
      ? (parentRect?.height ?? parent.offsetHeight) / parent.offsetHeight || 1
      : 1;
    const height = rect.height / scaleY;
    const trackHeight = Math.max(0, height - OVERLAY_SCROLLBAR_INSET * 2);
    const proportionalHeight = (target.clientHeight / target.scrollHeight) * trackHeight;
    const thumbHeight = clamp(proportionalHeight, OVERLAY_SCROLLBAR_MIN_THUMB, trackHeight);
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = OVERLAY_SCROLLBAR_INSET + (target.scrollTop / maxScrollTop) * maxThumbTop;

    setState({
      top: (rect.top - (parentRect?.top ?? 0)) / scaleY - (parent?.clientTop ?? 0),
      left:
        (rect.right - (parentRect?.left ?? 0)) / scaleX -
        (parent?.clientLeft ?? 0) -
        OVERLAY_SCROLLBAR_WIDTH -
        2,
      height,
      thumbTop,
      thumbHeight,
      visible: hoverRef.current || draggingRef.current,
      canScroll,
    });
  }, []);
  useLayoutEffect(() => {
    if (state.canScroll && tabActive) updateScrollbar();
  }, [state.canScroll, tabActive, updateScrollbar]);

  const scheduleUpdate = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(updateScrollbar);
  }, [updateScrollbar]);

  useEffect(() => {
    if (!tabActive) return undefined;
    const target =
      scrollRef?.current ??
      (targetSelector
        ? [...document.querySelectorAll<HTMLElement>(targetSelector)].find(
            (element) => element.getClientRects().length > 0,
          )
        : undefined);
    targetRef.current = target ?? null;
    hoverRef.current = false;
    draggingRef.current = false;

    if (!target) {
      setState(overlayScrollbarInitialState);
      return undefined;
    }

    function showScrollbar(): void {
      hoverRef.current = true;
      scheduleUpdate();
    }

    function hideScrollbar(): void {
      hoverRef.current = false;
      scheduleUpdate();
    }

    target.addEventListener('scroll', scheduleUpdate, { passive: true });
    target.addEventListener('mouseenter', showScrollbar);
    target.addEventListener('mouseleave', hideScrollbar);
    window.addEventListener('resize', scheduleUpdate);

    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(target);
    if (target.firstElementChild) resizeObserver.observe(target.firstElementChild);

    const mutationObserver = new MutationObserver(() => {
      if (hoverRef.current || draggingRef.current) scheduleUpdate();
    });
    mutationObserver.observe(target, { childList: true, subtree: true });

    scheduleUpdate();

    return () => {
      dragCleanup.current?.();
      target.removeEventListener('scroll', scheduleUpdate);
      target.removeEventListener('mouseenter', showScrollbar);
      target.removeEventListener('mouseleave', hideScrollbar);
      window.removeEventListener('resize', scheduleUpdate);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [tabActive, refreshKey, scheduleUpdate, targetSelector, scrollRef]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    dragCleanup.current?.();
    const target = targetRef.current;
    if (!target) return;
    const scrollTarget = target;
    timelineViewport(scrollTarget)?.cancelScroll?.();

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    hoverRef.current = true;

    const startY = event.clientY;
    const startScrollTop = scrollTarget.scrollTop;
    const maxScrollTop = scrollTarget.scrollHeight - scrollTarget.clientHeight;
    const trackHeight = Math.max(
      0,
      scrollTarget.getBoundingClientRect().height - OVERLAY_SCROLLBAR_INSET * 2,
    );
    const maxThumbTravel = Math.max(1, trackHeight - state.thumbHeight);

    function handlePointerMove(moveEvent: PointerEvent): void {
      const delta = moveEvent.clientY - startY;
      scrollTarget.scrollTop = clamp(
        startScrollTop + (delta / maxThumbTravel) * maxScrollTop,
        0,
        maxScrollTop,
      );
      scheduleUpdate();
    }

    function handlePointerUp(): void {
      draggingRef.current = false;
      hoverRef.current = scrollTarget.matches(':hover');
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      window.removeEventListener('blur', handlePointerUp);
      dragCleanup.current = null;
      scheduleUpdate();
    }

    window.addEventListener('pointermove', handlePointerMove);
    dragCleanup.current = handlePointerUp;
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    window.addEventListener('blur', handlePointerUp);
    scheduleUpdate();
  }

  if (!tabActive || !state.canScroll) return null;

  return (
    <div
      ref={scrollbarRef}
      className={`weq-custom-scrollbar ${className}${state.visible ? ' is-visible' : ''}`}
      style={{ position: 'absolute', top: state.top, left: state.left, height: state.height }}
    >
      <div
        className="weq-custom-scrollbar-thumb"
        onPointerDown={handlePointerDown}
        style={{ height: state.thumbHeight, transform: `translateY(${state.thumbTop}px)` }}
      />
    </div>
  );
}
