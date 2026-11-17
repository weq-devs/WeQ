import { useEffect } from 'react';
import { client } from '../trpc/client';
import { IS_WEB } from '../lib/target.shared';
import { activateNotificationClick } from '../lib/notificationSystemClick';
import { useToast } from './Toast.shared';

export function NotificationClickBridge() {
  useEffect(() => {
    if (IS_WEB) return;
    let active = true;
    let draining = false;
    let requested = false;
    const drain = async () => {
      if (draining) return;
      draining = true;
      try {
        do {
          requested = false;
          while (active) {
            const id = await client.bootstrap.consumeNotificationClick.mutate();
            if (!id || !active) break;
            try {
              await activateNotificationClick(id);
            } catch (error) {
              useToast.getState().push({
                tone: 'warning',
                title: '暂时无法打开通知来源',
                detail: error instanceof Error ? error.message : String(error),
              });
              console.warn('[notifications] 无法打开原通知来源', error);
            }
          }
        } while (active && requested);
      } finally {
        draining = false;
      }
    };
    const consume = () => {
      requested = true;
      void drain().catch((error: unknown) => console.warn('[notifications] 点击未接续', error));
    };
    const subscription = client.bootstrap.onNotificationClick.subscribe(undefined, {
      onData: consume,
    });
    consume();
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);
  return null;
}
