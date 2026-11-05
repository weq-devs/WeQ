import { useEffect } from 'react';
import { client, trpc } from '../trpc/client';
import { useWebNotices } from '../state/webNotices';
import { useViewState } from '../state/view';

export const WEB_NOTICE_OPEN = 'weq:web-notice-open';
export function WebNotifications() {
  const enabled = useWebNotices((state) => state.enabled);
  const uin = useViewState((state) => state.openedUin);
  const config = trpc.account.getAccountConfig.useQuery(undefined, { enabled: Boolean(uin) });
  const configId = config.data?.configId;
  useEffect(() => {
    if (
      !enabled ||
      !uin ||
      !configId ||
      typeof Notification === 'undefined' ||
      Notification.permission !== 'granted'
    )
      return;
    const visible = new Set<Notification>();
    const subscription = client.account.onWebNotice.subscribe(
      { expectedAccountUin: uin, expectedAccountConfigId: configId },
      {
        onData: (notice) => {
          if (
            notice.uin !== useViewState.getState().openedUin ||
            notice.configId !== configId ||
            !useWebNotices.getState().enabled
          )
            return;
          try {
            const item = new Notification(notice.title, {
              body: notice.body,
              tag: `weq:${notice.kind}:${notice.target?.conv ?? ''}`,
            });
            visible.add(item);
            item.onclose = () => visible.delete(item);
            item.onclick = () => {
              window.focus();
              window.dispatchEvent(new CustomEvent(WEB_NOTICE_OPEN, { detail: notice }));
              item.close();
            };
            while (visible.size > 20) {
              const first = visible.values().next().value;
              if (!first) break;
              first.close();
              visible.delete(first);
            }
          } catch {
            /* 浏览器撤销通知权限不影响消息订阅。 */
          }
        },
      },
    );
    return () => {
      subscription.unsubscribe();
      for (const item of visible) item.close();
    };
  }, [enabled, uin, configId]);
  return null;
}
