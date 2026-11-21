import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  MobileBackStack,
  type MobileBackEntry,
  type MobileNavigationChange,
} from '../lib/mobileNavigation';
import { compareMobileBackEntries } from '../lib/mobileBackSurface';
import {
  getMobileNavigationSnapshot,
  isMobileClient,
  isSingleColumnLayout,
  subscribeResponsiveLayout,
} from '../lib/responsiveLayout';
import { useRenderDocument } from '../lib/renderDocument';
import { useTabActive } from '../components/RetainedTabs.shared';

const stack = new MobileBackStack(compareMobileBackEntries);
let sequence = 0;
let syncQueued = false;
let guardInstalled = false;
let returningToRoot = false;
let backing = false;
let attached = false;
let requestedEntry: string | undefined;
const marker = `weq-mobile-${Date.now()}`;

export function isMobileNavigation() {
  return typeof window !== 'undefined' && (isSingleColumnLayout() || isMobileClient());
}

function signal(direction: MobileNavigationChange['direction'], source?: HTMLElement | null) {
  window.dispatchEvent(
    new CustomEvent<MobileNavigationChange>('weq-mobile-navigate', {
      detail: { direction, source },
    }),
  );
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

function consumeBack(expectedId?: string) {
  if (expectedId !== undefined && stack.top?.id !== expectedId) return false;
  blurMobileEditor();
  const source = stack.top?.target?.();
  const consumed = stack.back();
  if (consumed) signal('back', source);
  syncHistory();
  return consumed;
}

export function mobileBack(expectedId?: string) {
  if (!isMobileNavigation()) return false;
  if (expectedId !== undefined && stack.top?.id !== expectedId) return false;
  if (backing || returningToRoot) return expectedId === undefined && (stack.size > 0 || backing);
  if (!stack.size) return false;
  if (attached && guardInstalled) {
    backing = true;
    requestedEntry = stack.top?.id;
    window.history.back();
  } else consumeBack();
  return true;
}

export function mobileBackTarget() {
  return stack.top?.target?.() ?? null;
}

export function mobileBackEntry() {
  return stack.top;
}

export function registerMobileBack(entry: MobileBackEntry) {
  if (!isMobileNavigation()) return () => {};
  // React 卸载时 ref 已可能清空，保留原节点以识别本次退出来自哪个页面或浮层。
  const source = entry.target?.();
  const remove = stack.register(entry);
  signal('forward', source);
  syncHistory();
  return () => {
    const top = stack.top?.id === entry.id;
    const departing = entry.target?.() ?? source;
    remove();
    if (top) signal('back', departing);
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
  const renderDocument = useRenderDocument();
  const tabActive = useTabActive();
  const mobile = useSyncExternalStore(
    subscribeResponsiveLayout,
    getMobileNavigationSnapshot,
    () => false,
  );
  const id = useRef(`layer-${++sequence}`);
  const latest = useRef({ back, target });
  latest.current = { back, target };
  useEffect(() => {
    // 系统工具窗有自己的目录导航，不向主窗口的浏览历史注册返回动作。
    if (!active || !tabActive || !mobile || renderDocument !== document) return;
    return registerMobileBack({
      id: id.current,
      priority,
      retained: true,
      back: () => latest.current.back(),
      target: () => latest.current.target?.() ?? null,
    });
  }, [active, tabActive, priority, renderDocument, mobile]);
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
    else if (wasGuarded) consumeBack(requestedEntry);
    requestedEntry = undefined;
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
    requestedEntry = undefined;
    returningToRoot = false;
    window.history.scrollRestoration = scrollRestoration;
  };
}
