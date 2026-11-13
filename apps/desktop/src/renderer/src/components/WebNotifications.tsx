import { useEffect } from 'react';
import { client, trpc } from '../trpc/client';
import { useWebNotices } from '../state/webNotices';
import { useViewState } from '../state/view';
import { browserNoticeChannel } from '../lib/browserNotifications';

export { WEB_NOTICE_OPEN } from '../lib/browserNotifications';
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
    const channel = browserNoticeChannel();
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
          channel.show(notice);
        },
      },
    );
    return () => {
      subscription.unsubscribe();
      channel.close();
    };
  }, [enabled, uin, configId]);
  return null;
}
