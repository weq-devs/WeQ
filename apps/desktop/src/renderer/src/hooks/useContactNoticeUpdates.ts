import { useEffect } from 'react';
import type { ContactNoticeKind } from '../../../shared/contact_notices';
import { client, trpc } from '../trpc/client';
import { createUnreadTargetRefresh } from '../lib/unreadRefresh';
import type { QQWriteBinding } from './useQQWriteSession';

/** 群通知由本地变更驱动，好友通知仍可补读在线申请。 */
export function useContactNoticeUpdates(binding: QQWriteBinding | null) {
  const utils = trpc.useUtils();
  const uin = binding?.expectedAccountUin;
  const configId = binding?.expectedAccountConfigId;
  useEffect(() => {
    if (!uin || !configId) return;
    let active = true;
    type Target = { chatType: number; uid: ContactNoticeKind };
    const online = createUnreadTargetRefresh<Target>(
      async () => {
        if (!active) return true;
        await Promise.all(
          (['friend', 'doubtFriend'] as const).map((kind) =>
            utils.account.qqActions.requestInbox.invalidate({
              expectedAccountUin: uin,
              expectedAccountConfigId: configId,
              kind,
            }),
          ),
        );
        return true;
      },
      undefined,
      2,
      5000,
    );
    const local = createUnreadTargetRefresh<Target>(async (targets) => {
      for (const target of targets) {
        if (!active) return true;
        await (target.uid === 'friend'
          ? utils.account.listBuddyRequests.invalidate()
          : utils.account.listGroupNotifies.invalidate());
        if (active && target.uid === 'friend') online.request([target]);
      }
      return true;
    });
    const sub = client.account.onContactNoticesChanged.subscribe(
      { expectedAccountUin: uin, expectedAccountConfigId: configId },
      {
        onData({ kind }) {
          if (active) local.request([{ chatType: kind === 'friend' ? 1 : 2, uid: kind }]);
        },
        onError(error) {
          console.error('[contact-notice] 通知变更订阅失败', error);
        },
      },
    );
    return () => {
      active = false;
      local.dispose();
      online.dispose();
      sub.unsubscribe();
    };
  }, [uin, configId, utils]);
}
