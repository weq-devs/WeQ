import { useEffect } from 'react';
import { useToast } from '../components/Toast.shared';

/** 前台更新页面可以确认当前显示的更新，无须再点横幅。 */
export function useReadUpdateBanner(key: string, active: boolean) {
  useEffect(() => {
    if (!active) return;
    let read: (() => void) | undefined;
    const confirm = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      const { toasts, leaving } = useToast.getState();
      const banner = toasts.find((item) => item.key === key && !leaving.includes(item.id));
      const acknowledge = banner?.onManualDismiss;
      if (!acknowledge || acknowledge === read) return;
      read = acknowledge;
      acknowledge();
    };
    const stop = useToast.subscribe((state, previous) => {
      if (state.toasts !== previous.toasts) confirm();
    });
    window.addEventListener('focus', confirm);
    document.addEventListener('visibilitychange', confirm);
    confirm();
    return () => {
      stop();
      window.removeEventListener('focus', confirm);
      document.removeEventListener('visibilitychange', confirm);
    };
  }, [active, key]);
}
