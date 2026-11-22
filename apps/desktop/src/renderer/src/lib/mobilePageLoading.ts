import { scheduleBackgroundModule, setBackgroundNavigationBusy } from './backgroundLoad';

export const MOBILE_PAGE_SETTLE_MS = 180;
export const MOBILE_NAVIGATION_BUSY_EVENT = 'weq-mobile-navigation-busy';
let navigationBusy = false;

export function isMobileNavigationBusy() {
  return navigationBusy;
}

export function setMobileNavigationBusy(busy: boolean) {
  if (navigationBusy === busy) return;
  navigationBusy = busy;
  setBackgroundNavigationBusy(busy);
  window.dispatchEvent(new Event(MOBILE_NAVIGATION_BUSY_EVENT));
}

/** 每次空闲只预热一个模块；手势、后台和卸载都会暂停后续工作。 */
export function preloadMobilePages(loaders: Array<() => Promise<unknown>>) {
  const stops = loaders.map((load) =>
    scheduleBackgroundModule(
      load,
      typeof window.requestIdleCallback === 'function' ? 0 : 80,
      () => !window.weqRemoteStartup || window.weqRemoteStartup.state === 'ready',
    ),
  );
  return () => {
    for (const stop of stops) stop();
  };
}
