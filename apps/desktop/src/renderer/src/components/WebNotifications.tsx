import { useEffect } from 'react';
import { client, trpc } from '../trpc/client';
import { useWebNotices } from '../state/webNotices';
import { useViewState } from '../state/view';
import { browserNoticeChannel } from '../lib/browserNotifications';
import { notificationEnabled, claimMessageBanner } from '../lib/notificationPolicy';
import { useToast } from './Toast.shared';
import { notificationSource } from '../lib/notificationNavigation.shared';
import { IS_WEB } from '../lib/target.shared';
export function WebNotifications() {
  const enabled = useWebNotices((state) => state.enabled);
  const uin = useViewState((state) => state.openedUin);
  const config = trpc.account.getAccountConfig.useQuery(undefined, { enabled: Boolean(uin) });
  const configId = config.data?.configId;
  useEffect(() => {
    if (!uin || !configId) return;
    const channel = browserNoticeChannel();
    const subscription = client.account.onWebNotice.subscribe(
      { expectedAccountUin: uin, expectedAccountConfigId: configId },
      {
        onData: (notice) => {
          if (notice.uin !== useViewState.getState().openedUin || notice.configId !== configId)
            return;
          const event =
            notice.kind === 'recall'
              ? 'recall'
              : notice.kind === 'keyword'
                ? 'keyword'
                : notice.kind === 'mail'
                  ? 'mail'
                  : null;
          if (!event) return;
          if (
            notificationEnabled(event, 'banner') &&
            (event !== 'keyword' ||
              !notice.target ||
              claimMessageBanner(
                configId,
                notice.target.kind,
                notice.target.conv,
                notice.target.seq,
              ))
          )
            useToast.getState().push({
              event,
              title: notice.title,
              detail: notice.body,
              source: notice.mail
                ? notificationSource(
                    { kind: 'mail', folderId: notice.mail.folderId, mailId: notice.mail.id },
                    '打开这封邮件',
                  )
                : notice.target
                  ? notificationSource(
                      {
                        kind: 'conversation',
                        conversationKind: notice.target.kind,
                        conv: notice.target.conv,
                        seq: notice.target.seq,
                      },
                      '定位消息',
                    )
                  : undefined,
            });
          if (IS_WEB && useWebNotices.getState().enabled && notificationEnabled(event, 'system'))
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
