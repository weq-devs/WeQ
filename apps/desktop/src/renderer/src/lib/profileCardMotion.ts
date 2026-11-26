import { useLayoutEffect, type RefObject } from 'react';

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
      if (!reduced.matches && element.isConnected) fadeRemovedCard(element, view);
      enter?.cancel();
    };
  }, [ref, close]);
}

/** Only the pixels linger: the real card releases focus, listeners and its overlay slot immediately. */
function fadeRemovedCard(element: HTMLElement, view: Window) {
  const parent = element.parentElement;
  const opacity = Number(view.getComputedStyle(element).opacity);
  if (!parent || !opacity || element.ownerDocument.hidden) return;

  const snapshot = element.cloneNode(true) as HTMLElement;
  snapshot.inert = true;
  snapshot.setAttribute('aria-hidden', 'true');
  const targets = snapshot.querySelectorAll<HTMLElement>('*');
  const scroll = [...element.querySelectorAll<HTMLElement>('*')].flatMap((node, index) => {
    const target = targets[index];
    const { scrollTop: top, scrollLeft: left } = node;
    return target && (top || left) ? [{ target, top, left }] : [];
  });

  queueMicrotask(() => {
    // React may rehearse effect cleanup without removing the card (StrictMode).
    if (element.isConnected || !parent.isConnected) return;
    parent.prepend(snapshot);
    for (const { target, top, left } of scroll) {
      target.scrollTop = top;
      target.scrollLeft = left;
    }
    const exit = snapshot.animate([{ opacity }, { opacity: 0 }], {
      duration: 120,
      easing: 'ease-in',
      fill: 'both',
    });
    const remove = () => snapshot.remove();
    void exit.finished.then(remove, remove);
  });
}
