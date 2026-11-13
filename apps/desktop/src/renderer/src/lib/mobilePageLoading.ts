export const MOBILE_PAGE_SETTLE_MS = 180;
export const MOBILE_NAVIGATION_BUSY_EVENT = 'weq-mobile-navigation-busy';
let navigationBusy = false;

export function isMobileNavigationBusy() {
  return navigationBusy;
}

export function setMobileNavigationBusy(busy: boolean) {
  navigationBusy = busy;
  window.dispatchEvent(new Event(MOBILE_NAVIGATION_BUSY_EVENT));
}

/** 每次空闲只预热一个模块；手势、后台和卸载都会暂停后续工作。 */
export function preloadMobilePages(loaders: Array<() => Promise<unknown>>) {
  let disposed = false;
  let running = false;
  let cancelIdle: (() => void) | undefined;
  const queue = [...loaders];
  const schedule = () => {
    cancelIdle?.();
    cancelIdle = undefined;
    if (disposed || running || !queue.length || navigationBusy || document.hidden) return;
    const load = () => {
      cancelIdle = undefined;
      if (disposed || navigationBusy || document.hidden) return;
      const next = queue.shift();
      if (!next) return;
      running = true;
      void Promise.resolve()
        .then(next)
        .catch(() => {})
        .finally(() => {
          running = false;
          schedule();
        });
    };
    if (window.requestIdleCallback) {
      const id = window.requestIdleCallback(load);
      cancelIdle = () => window.cancelIdleCallback(id);
    } else {
      const id = window.setTimeout(load, 80);
      cancelIdle = () => window.clearTimeout(id);
    }
  };
  window.addEventListener(MOBILE_NAVIGATION_BUSY_EVENT, schedule);
  document.addEventListener('visibilitychange', schedule);
  schedule();
  return () => {
    disposed = true;
    cancelIdle?.();
    window.removeEventListener(MOBILE_NAVIGATION_BUSY_EVENT, schedule);
    document.removeEventListener('visibilitychange', schedule);
  };
}
