import { useEffect } from 'react';
import { client, trpc } from '../trpc/client';
import { useWebNotices } from '../state/webNotices';
import { useViewState } from '../state/view';
import { useAppLock } from '../state/lock';
import { preferenceValue } from '../lib/clientPreferences';
import { browserNoticeChannel } from '../lib/browserNotifications';
import { notificationEnabled, claimMessageBanner } from '../lib/notificationPolicy';
import { useToast } from './Toast.shared';
import { notificationSource } from '../lib/notificationNavigation.shared';
import { IS_WEB } from '../lib/target.shared';
import { PRIVATE_MESSAGE_NOTICE, PRIVATE_RECALL_NOTICE } from '../../../shared/notification_copy';
import {
  conversationInteractionId,
  interactionBannerPrefix,
} from '../../../shared/conversation_interaction';

function mailBannerKey(uin: string, configId: string, id: string): string {
  return JSON.stringify(['mail', uin, configId, id]);
}

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
          if (notice.kind === 'mail-read') {
            const { resolve } = useToast.getState();
            for (const id of notice.mailIds) resolve(mailBannerKey(notice.uin, configId, id));
            return;
          }
          const event = notice.kind;
          if (event === 'message') return;
          const hide = useAppLock.getState().locked || preferenceValue('privacyMode');
          const { banner, ...baseNotice } = notice;
          const systemCopy =
            !hide || event === 'mail'
              ? baseNotice
              : {
                  ...baseNotice,
                  ...(event === 'recall' ? PRIVATE_RECALL_NOTICE : PRIVATE_MESSAGE_NOTICE),
                };
          const bannerCopy = !hide && banner ? banner : systemCopy;
          const recallKey =
            event === 'recall' && notice.target?.msgId
              ? interactionBannerPrefix(uin, configId) +
                conversationInteractionId({
                  kind: notice.target.kind,
                  conv: notice.target.conv,
                  msgId: notice.target.msgId,
                  action: 'recall',
                })
              : undefined;
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
              key: notice.mail ? mailBannerKey(notice.uin, configId, notice.mail.id) : recallKey,
              title: bannerCopy.title,
              summary: bannerCopy.body,
              detail: !hide && event === 'keyword' ? bannerCopy.body : undefined,
              messageReadTarget:
                event === 'keyword' && notice.target
                  ? {
                      binding: {
                        expectedAccountUin: notice.uin,
                        expectedAccountConfigId: configId,
                      },
                      chatType: notice.target.kind === 'group' ? 2 : 1,
                      uid: notice.target.conv,
                      seq: notice.target.seq,
                    }
                  : undefined,
              source: notice.mail
                ? notificationSource(
                    { kind: 'mail', folderId: notice.mail.folderId, mailId: notice.mail.id },
                    '打开这封邮件',
                    { expectedAccountUin: notice.uin, expectedAccountConfigId: notice.configId },
                  )
                : notice.target
                  ? notificationSource(
                      {
                        kind: 'conversation',
                        conversationKind: notice.target.kind,
                        conv: notice.target.conv,
                        seq: notice.target.seq,
                        msgId: notice.target.msgId,
                      },
                      '定位消息',
                    )
                  : undefined,
            });
          if (IS_WEB && useWebNotices.getState().enabled && notificationEnabled(event, 'system'))
            channel.show(systemCopy);
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
