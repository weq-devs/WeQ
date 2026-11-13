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
  const editing = document.activeElement?.matches('input, textarea, [contenteditable="true"]');
  if (layoutWidth !== window.innerWidth || !editing) {
    layoutWidth = window.innerWidth;
    layoutHeight = window.innerHeight;
  }
  const viewportLandscape = window.innerWidth > (layoutHeight || window.innerHeight);
  const screen = window.screen;
  const screenGeometryKnown =
    Number.isFinite(screen?.width) &&
    Number.isFinite(screen?.height) &&
    screen.width > 0 &&
    screen.height > 0 &&
    screen.width !== screen.height;
  const screenLandscape = screenGeometryKnown ? screen.width > screen.height : undefined;
  const orientation = screen?.orientation?.type;
  const legacy = (window as Window & { orientation?: number }).orientation;
  const reportedLandscape = orientation
    ? orientation.startsWith('landscape')
    : typeof legacy === 'number' && Number.isFinite(legacy)
      ? Math.abs(legacy) === 90
      : undefined;
  // WebView 可能误报方向；仅当屏幕与稳定视口均反证它时改用几何结果。
  // 屏幕尺寸固定为自然方向的宿主仍采用方向 API，键盘缩短视口不改变已记录高度。
  if (screenLandscape !== undefined && screenLandscape === viewportLandscape)
    return screenLandscape;
  return reportedLandscape ?? screenLandscape ?? viewportLandscape;
}

/** 媒体查询只回答「是否窄」，交给规则函数时用这两个哨兵宽度表示口径。 */
const NARROW_VIEWPORT = 0;
const NOT_NARROW_VIEWPORT = SINGLE_COLUMN_MAX_WIDTH + 1;

/**
 * 布局视口是不是窄的。**媒体查询优先**：它才是 CSS 布局真正用的布局视口宽度；
 * `window.innerWidth` 是视觉视口，页面缩放时会差 1px 内，用它会和样式对不上。
 * 宿主没有 matchMedia 时才退回 innerWidth（见 responsive_layout.test.ts 首个用例）。
 */
function isNarrowLayoutViewport(): boolean {
  const query = window.matchMedia?.(`(max-width: ${SINGLE_COLUMN_MAX_WIDTH}px)`);
  if (query) return query.matches;
  return window.innerWidth <= SINGLE_COLUMN_MAX_WIDTH;
}

/**
 * 运行时唯一入口：规则只写在 {@link resolveResponsiveLayout} 里，这里只负责
 * 取视口口径（媒体查询 / 设备方向 / 客户端身份）。
 */
export function isSingleColumnLayout(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    resolveResponsiveLayout({
      width: isNarrowLayoutViewport() ? NARROW_VIEWPORT : NOT_NARROW_VIEWPORT,
      height: window.innerHeight,
      mobileClient: isMobileClient(),
      landscape: deviceLandscape(),
    }) === 'single'
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
