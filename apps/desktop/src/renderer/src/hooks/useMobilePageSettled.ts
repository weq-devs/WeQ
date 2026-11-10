import { useEffect, useState } from 'react';
import { useMobileWebLayout } from './useMobileWebViewport';
import {
  isMobileNavigationBusy,
  MOBILE_NAVIGATION_BUSY_EVENT,
  MOBILE_PAGE_SETTLE_MS,
} from '../lib/mobilePageLoading';

/** 页面、账号或导航发生变化后重新计时，离开页面即失效。 */
export function useMobilePageSettled(active: boolean, pageKey: string) {
  const mobile = useMobileWebLayout();
  const [readyKey, setReadyKey] = useState<string | null>(null);
  useEffect(() => {
    if (!mobile || !active) {
      setReadyKey(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      setReadyKey(null);
      if (!document.hidden && !isMobileNavigationBusy())
        timer = setTimeout(() => setReadyKey(pageKey), MOBILE_PAGE_SETTLE_MS);
    };
    update();
    window.addEventListener(MOBILE_NAVIGATION_BUSY_EVENT, update);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(MOBILE_NAVIGATION_BUSY_EVENT, update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [mobile, active, pageKey]);
  return active && (!mobile || readyKey === pageKey);
}
