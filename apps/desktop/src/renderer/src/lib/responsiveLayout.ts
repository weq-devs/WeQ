import { IS_WEB } from './target';
import { isRemoteClient } from './remoteClient';

export { isRemoteClient } from './remoteClient';
export type ResponsiveLayout = 'single' | 'wide';
const SINGLE_COLUMN_MAX_WIDTH = 760;

export function resolveResponsiveLayout({
  width,
  height,
  mobileClient,
  landscape = width > height,
}: {
  width: number;
  height: number;
  mobileClient: boolean;
  landscape?: boolean;
}): ResponsiveLayout {
  return width <= SINGLE_COLUMN_MAX_WIDTH && !(mobileClient && landscape) ? 'single' : 'wide';
}

/** 客户端身份不由窗口宽度推断；iPad 的桌面 UA 用触控能力补充识别。 */
export function isMobileClient() {
  if (typeof navigator === 'undefined') return false;
  return (
    isRemoteClient() ||
    (IS_WEB &&
      (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
        (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)))
  );
}

export function isTouchClient() {
  return (
    typeof window !== 'undefined' &&
    (isRemoteClient() ||
      navigator.maxTouchPoints > 0 ||
      (window.matchMedia?.('(pointer: coarse)').matches ?? false))
  );
}

let layoutWidth = 0;
let layoutHeight = 0;
function deviceLandscape(): boolean {
  // 屏幕方向不会因软键盘缩短 layout/visual viewport 而改变。
  const orientation = window.screen?.orientation?.type;
  if (orientation) return orientation.startsWith('landscape');
  const legacy = (window as Window & { orientation?: number }).orientation;
  if (typeof legacy === 'number') return Math.abs(legacy) === 90;
  const editing = document.activeElement?.matches('input, textarea, [contenteditable="true"]');
  if (layoutWidth !== window.innerWidth || !editing) {
    layoutWidth = window.innerWidth;
    layoutHeight = window.innerHeight;
  }
  return window.innerWidth > (layoutHeight || window.innerHeight);
}

export function isSingleColumnLayout(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    (window.matchMedia?.(`(max-width: ${SINGLE_COLUMN_MAX_WIDTH}px)`).matches ??
      window.innerWidth <= SINGLE_COLUMN_MAX_WIDTH) &&
    !(isMobileClient() && deviceLandscape())
  );
}

const listeners = new Set<() => void>();
let stopObserving: (() => void) | undefined;
function update() {
  const html = document.documentElement;
  html.dataset.weqLayout = isSingleColumnLayout() ? 'single' : 'wide';
  html.dataset.weqInput = isTouchClient() ? 'touch' : 'pointer';
  html.dataset.weqMobileClient = String(isMobileClient());
  for (const notify of listeners) notify();
}

export function subscribeResponsiveLayout(notify: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  if (!stopObserving) {
    const pointer = window.matchMedia?.('(pointer: coarse)');
    const orientation = window.screen?.orientation;
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    window.addEventListener('weq-remote-shell-ready', update);
    orientation?.addEventListener('change', update);
    pointer?.addEventListener('change', update);
    stopObserving = () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      window.removeEventListener('weq-remote-shell-ready', update);
      orientation?.removeEventListener('change', update);
      pointer?.removeEventListener('change', update);
      stopObserving = undefined;
    };
  }
  update();
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
    if (!listeners.size) stopObserving?.();
  };
}

// 首次 React 提交前即确定样式，避免窄横屏先绘制单栏再跳到多栏。
if (typeof window !== 'undefined' && typeof document !== 'undefined') update();
