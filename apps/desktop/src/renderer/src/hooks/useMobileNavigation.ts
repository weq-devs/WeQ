import { useEffect, useRef } from 'react';
import { MobileBackStack, type MobileBackEntry } from '../lib/mobileNavigation';
import { isMobileClient, isSingleColumnLayout } from '../lib/responsiveLayout';

const stack = new MobileBackStack();
let sequence = 0;
let syncQueued = false;
let guardInstalled = false;
let returningToRoot = false;
let backing = false;
let attached = false;
const marker = `weq-mobile-${Date.now()}`;

export function isMobileNavigation() {
  return typeof window !== 'undefined' && (isSingleColumnLayout() || isMobileClient());
}

function signal(direction: 'forward' | 'back' | 'root') {
  window.dispatchEvent(new CustomEvent('weq-mobile-navigate', { detail: direction }));
}

// 浏览器只保留一个返回哨兵；主标签切换不会不断增加浏览历史。
function syncHistory() {
  if (syncQueued || !attached) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    if (!attached || returningToRoot) return;
    if (stack.size && !guardInstalled) {
      window.history.pushState({ ...window.history.state, weqMobileGuard: marker }, '');
      guardInstalled = true;
    } else if (!stack.size && guardInstalled) {
      returningToRoot = true;
      window.history.back();
    }
  });
}

function consumeBack() {
  blurMobileEditor();
  const consumed = stack.back();
  if (consumed) signal('back');
  syncHistory();
  return consumed;
}

export function mobileBack() {
  if (!isMobileNavigation()) return false;
  if (backing || returningToRoot) return stack.size > 0 || backing;
  if (!stack.size) return false;
  if (attached && guardInstalled) {
    backing = true;
    window.history.back();
  } else consumeBack();
  return true;
}

export function mobileBackTarget() {
  return stack.top?.target?.() ?? null;
}

export function registerMobileBack(entry: MobileBackEntry) {
  if (!isMobileNavigation()) return () => {};
  const remove = stack.register(entry);
  signal('forward');
  syncHistory();
  return () => {
    const top = stack.top?.id === entry.id;
    remove();
    if (top) signal('back');
    syncHistory();
  };
}

export function pushMobileBack(back: () => void, target?: () => HTMLElement | null, priority = 10) {
  return registerMobileBack({ id: `shell-${++sequence}`, priority, back, target });
}

export function resetMobileRoot() {
  if (!isMobileNavigation()) return;
  blurMobileEditor();
  stack.clear();
  signal('root');
  syncHistory();
}

function blurMobileEditor() {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.matches('input, textarea, [contenteditable="true"]'))
    active.blur();
}

export function useMobileBack(
  active: boolean,
  back: () => void,
  priority = 20,
  target?: () => HTMLElement | null,
) {
  const id = useRef(`layer-${++sequence}`);
  const latest = useRef({ back, target });
  latest.current = { back, target };
  useEffect(() => {
    if (!active) return;
    return registerMobileBack({
      id: id.current,
      priority,
      retained: true,
      back: () => latest.current.back(),
      target: () => latest.current.target?.() ?? null,
    });
  }, [active, priority]);
}

export function attachMobileHistory() {
  attached = true;
  const scrollRestoration = window.history.scrollRestoration;
  window.history.scrollRestoration = 'manual';
  const onPop = (event: PopStateEvent) => {
    if (event.state?.weqMobileGuard === marker) {
      guardInstalled = true;
      syncHistory();
      return;
    }
    const wasGuarded = guardInstalled;
    guardInstalled = false;
    if (returningToRoot) returningToRoot = false;
    else if (wasGuarded) consumeBack();
    backing = false;
    syncHistory();
  };
  window.addEventListener('popstate', onPop);
  window.weqMobileNavigation = { back: mobileBack };
  syncHistory();
  return () => {
    attached = false;
    window.removeEventListener('popstate', onPop);
    delete window.weqMobileNavigation;
    stack.clear();
    if (guardInstalled) {
      const { weqMobileGuard: _, ...state } = window.history.state ?? {};
      window.history.replaceState(state, '');
    }
    guardInstalled = false;
    backing = false;
    returningToRoot = false;
    window.history.scrollRestoration = scrollRestoration;
  };
}
