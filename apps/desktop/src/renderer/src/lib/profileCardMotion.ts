import { useLayoutEffect, type RefObject } from 'react';

const closers = new WeakMap<HTMLElement, () => void>();

export function dismissProfileCard(element: HTMLElement) {
  closers.get(element)?.();
}

export function useProfileCardMotion(ref: RefObject<HTMLElement | null>, close?: () => void) {
  useLayoutEffect(() => {
    const element = ref.current;
    const view = element?.ownerDocument.defaultView;
    if (!element || !view || !close) return;
    closers.set(element, close);
    const reduced = view.matchMedia('(prefers-reduced-motion: reduce)');
    const enter = reduced.matches
      ? undefined
      : element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
    return () => {
      closers.delete(element);
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
