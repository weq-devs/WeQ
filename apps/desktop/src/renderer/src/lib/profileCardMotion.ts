import { useLayoutEffect, type RefObject } from 'react';
import { fadeRemovedSurface } from './surfaceExit';

export type ProfileTrigger =
  | Element
  | { element: Element; hitTest: (point: MouseEvent) => boolean };
export type ProfilePoint = { x: number; y: number; trigger?: ProfileTrigger };

const cards = new WeakMap<HTMLElement, { close: () => void; trigger?: ProfileTrigger }>();

export function isProfileTrigger(trigger: ProfileTrigger, target: Node, event?: MouseEvent) {
  return 'hitTest' in trigger
    ? trigger.element.contains(target) && !!event && trigger.hitTest(event)
    : trigger.contains(target);
}

export function ownsProfileCard(element: HTMLElement, trigger: Element, event?: MouseEvent) {
  const origin = cards.get(element)?.trigger;
  if (!origin) return false;
  return 'hitTest' in origin
    ? origin.element === trigger && !!event && origin.hitTest(event)
    : origin === trigger;
}

export function dismissProfileCard(element: HTMLElement) {
  cards.get(element)?.close();
}

/** 提前开始淡出。松手确认前仍保留名片，取消时可恢复。 */
export function previewProfileCardDismissal(
  element: HTMLElement,
  pressMs: number,
  timeout: number,
) {
  const view = element.ownerDocument.defaultView;
  if (!cards.has(element) || !view) return;
  const opacity = Number(view.getComputedStyle(element).opacity);
  const fadedOpacity = opacity * 0.65;
  return element.animate(
    [
      { opacity, easing: 'ease-out' },
      { opacity: fadedOpacity, offset: pressMs / timeout },
      { opacity: fadedOpacity },
    ],
    timeout,
  );
}

export function useProfileCardMotion(
  ref: RefObject<HTMLElement | null>,
  close?: () => void,
  trigger?: ProfileTrigger,
) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !close) return;
    cards.set(element, { close, trigger });
    return () => {
      cards.delete(element);
    };
  }, [ref, close, trigger]);

  useLayoutEffect(() => {
    const element = ref.current;
    const view = element?.ownerDocument.defaultView;
    if (!element || !view || !close) return;
    const reduced = view.matchMedia('(prefers-reduced-motion: reduce)');
    const enter = reduced.matches
      ? undefined
      : element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
    void enter?.finished.catch(() => {});
    return () => {
      fadeRemovedSurface(element);
      enter?.cancel();
    };
  }, [ref, close]);
}
