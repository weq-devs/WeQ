import { useCallback, useEffect, useRef, useState } from 'react';
import { USER_ACTIVITY_EVENT } from '../lib/renderDocument';
export const COMPOSITION_DISPOSE_EVENT = 'weq:composition-dispose';

function disposeCompositionWindow(popup: Window | null): void {
  if (!popup || popup.closed) return;
  popup.dispatchEvent(new Event(COMPOSITION_DISPOSE_EVENT));
  popup.close();
}

export function mirrorCompositionStyles(source: Document, target: Document): () => void {
  target.title = 'WeQ · 合成聊天记录';
  const sync = () => {
    const head = target.createDocumentFragment();
    const base = target.createElement('base');
    base.href = source.baseURI;
    head.append(base);
    const title = target.createElement('title');
    title.textContent = 'WeQ · 合成聊天记录';
    head.append(title);
    for (const element of source.head.querySelectorAll('style, link[rel="stylesheet"]'))
      head.append(target.importNode(element, true));
    target.head.replaceChildren(head);
    for (const name of [
      'class',
      'data-theme',
      'data-background',
      'data-privacy',
      'style',
      'lang',
    ]) {
      const value = source.documentElement.getAttribute(name);
      if (value === null) target.documentElement.removeAttribute(name);
      else target.documentElement.setAttribute(name, value);
    }
    target.body.classList.add('weq-composition-window-body');
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(source.head, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  observer.observe(source.documentElement, { attributes: true });
  return () => observer.disconnect();
}

/** 工作窗只属于当前账号的 MainView 生命周期，不给空白子窗加载特权 preload。 */
export function useCompositionWindow() {
  const owned = useRef<Window | null>(null);
  const [popup, setPopup] = useState<Window | null>(null);
  const [fallback, setFallback] = useState(false);
  const open = useCallback(() => {
    const existing = owned.current;
    if (existing && !existing.closed) {
      existing.focus();
      setPopup(existing);
      return;
    }
    const next = window.open('about:blank', 'weq-compose', 'popup,width=1000,height=680');
    if (!next) {
      setFallback(true);
      return;
    }
    next.document.open();
    next.document.write(
      '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
    );
    next.document.close();
    owned.current = next;
    setPopup(next);
    setFallback(false);
  }, []);
  const close = useCallback(() => {
    disposeCompositionWindow(owned.current);
    owned.current = null;
    setPopup(null);
    setFallback(false);
  }, []);
  useEffect(
    () => () => {
      disposeCompositionWindow(owned.current);
    },
    [],
  );
  useEffect(() => {
    if (!popup) return;
    const unmirror = mirrorCompositionStyles(document, popup.document);
    const events = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'] as const;
    const activity = () => window.dispatchEvent(new Event(USER_ACTIVITY_EVENT));
    for (const event of events) popup.addEventListener(event, activity);
    const timer = window.setInterval(() => {
      if (popup.closed) {
        owned.current = null;
        setPopup(null);
      }
    }, 400);
    return () => {
      unmirror();
      for (const event of events) popup.removeEventListener(event, activity);
      window.clearInterval(timer);
    };
  }, [popup]);
  return { popup, fallback, open, close };
}
