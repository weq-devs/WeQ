import { useCallback, useEffect, useRef, useState } from 'react';
import { USER_ACTIVITY_EVENT } from '../lib/renderDocument';
export const COMPOSITION_DISPOSE_EVENT = 'weq:composition-dispose';

function disposeCompositionWindow(
  popup: Window | null,
  event: string | null = COMPOSITION_DISPOSE_EVENT,
): void {
  if (!popup || popup.closed) return;
  if (event) popup.dispatchEvent(new Event(event));
  popup.close();
}

export function mirrorCompositionStyles(
  source: Document,
  target: Document,
  titleText = 'WeQ · 合成聊天记录',
  bodyClass = 'weq-composition-window-body',
): () => void {
  target.title = titleText;
  const sync = () => {
    const head = target.createDocumentFragment();
    const base = target.createElement('base');
    base.href = source.baseURI;
    head.append(base);
    const title = target.createElement('title');
    title.textContent = titleText;
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
    target.body.classList.add(bodyClass);
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
  return useToolWindow({
    name: 'weq-compose',
    title: 'WeQ · 合成聊天记录',
    width: 1000,
    height: 680,
    bodyClass: 'weq-composition-window-body',
    disposeEvent: COMPOSITION_DISPOSE_EVENT,
  });
}

/** 应用自己的空白系统工具窗；渲染与 IPC 仍由主 React 树管理。 */
export function useToolWindow({
  name,
  title,
  width,
  height,
  bodyClass,
  disposeEvent = null,
}: {
  name: 'weq-compose' | 'weq-db-repair' | 'weq-call';
  title: string;
  width: number;
  height: number;
  bodyClass: string;
  disposeEvent?: string | null;
}) {
  const owned = useRef<Window | null>(null);
  const [popup, setPopup] = useState<Window | null>(null);
  const [fallback, setFallback] = useState(false);
  const open = useCallback(() => {
    const existing = owned.current;
    if (existing && !existing.closed) {
      existing.focus();
      setPopup(existing);
      return existing;
    }
    const next = window.open('about:blank', name, `popup,width=${width},height=${height}`);
    if (!next) {
      setFallback(true);
      return null;
    }
    next.document.open();
    next.document.write(
      '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
    );
    next.document.close();
    owned.current = next;
    setPopup(next);
    setFallback(false);
    return next;
  }, [name, width, height]);
  const close = useCallback(() => {
    disposeCompositionWindow(owned.current, disposeEvent);
    owned.current = null;
    setPopup(null);
    setFallback(false);
  }, [disposeEvent]);
  useEffect(
    () => () => {
      disposeCompositionWindow(owned.current, disposeEvent);
    },
    [disposeEvent],
  );
  useEffect(() => {
    if (!popup) return;
    const unmirror = mirrorCompositionStyles(document, popup.document, title, bodyClass);
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
  }, [popup, title, bodyClass]);
  return { popup, fallback, open, close };
}
