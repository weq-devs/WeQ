import { useEffect, useRef } from 'react';
import { generatedMuteKey } from '@weq/service/client-preferences';
import { useToast } from '../components/Toast.shared';
import { accountBinding, preferenceValue, sharedAccountRecords } from '../lib/clientPreferences';
import { notificationSource, openNotificationSource } from '../lib/notificationNavigation.shared';
import { notificationEnabled, publishNotificationSystem } from '../lib/notificationPolicy';
import { IS_WEB } from '../lib/target.shared';
import { useAppLock } from '../state/lock';
import { client, trpc } from '../trpc/client';
import { messageNotificationDedupe } from '../../../shared/notification_dedupe';

const claimReply = messageNotificationDedupe();
const event = 'assistantReply';

/** 订阅主工作区，不随某个会话组件的挂载、切出或前后台切换而重建。 */
export function useGeneratedReplyNotifications(uin: string, configId: string, readingId?: string) {
  const utils = trpc.useUtils();
  const reading = useRef(readingId);
  reading.current = readingId;
  useEffect(() => {
    if (!uin || !configId) return;
    const binding = { expectedAccountUin: uin, expectedAccountConfigId: configId };
    const subscription = client.account.onGeneratedReply.subscribe(binding, {
      onData: (reply) => {
        const current = accountBinding();
        if (current?.expectedAccountConfigId !== configId || current.expectedAccountUin !== uin)
          return;
        if (reply.kind === 'assistant') void utils.account.listAssistantSessions.invalidate();
        else if (reply.kind === 'persona') void utils.account.listAgentLabPersonas.invalidate();
        else void utils.account.listAgentLabGroups.invalidate();

        const id =
          reply.kind === 'assistant'
            ? `assistant:${reply.conversationId}`
            : `virtual:${reply.kind}:${reply.conversationId}`;
        if (sharedAccountRecords('notifications')[generatedMuteKey(id)] === true) return;
        const locked = useAppLock.getState().locked;
        if (
          !locked &&
          reading.current === id &&
          document.visibilityState === 'visible' &&
          document.hasFocus()
        )
          return;
        const banner = notificationEnabled(event, 'banner');
        const system =
          notificationEnabled(event, 'system') && (!IS_WEB || preferenceValue('webNotifications'));
        if (
          (!banner && !system) ||
          !claimReply(configId, reply.kind, reply.conversationId, reply.id)
        )
          return;

        const privacy = locked || preferenceValue('privacyMode');
        const title = privacy ? 'WeQ' : `${reply.title} · 新回复`;
        const body = privacy ? '收到新回复' : reply.preview || '收到新回复';
        const source = notificationSource(
          {
            kind: 'generated-reply',
            conversationKind: reply.kind,
            conversationId: reply.conversationId,
            messageId: reply.messageId,
          },
          reply.messageId ? '定位这条回复' : '返回对应会话',
          binding,
        );
        const key = JSON.stringify([configId, id, reply.id]);
        if (banner)
          useToast.getState().push({ key, event, title, detail: body, source, system: false });
        if (system)
          publishNotificationSystem(event, title, body, () => openNotificationSource(source), key);
      },
    });
    return () => subscription.unsubscribe();
  }, [uin, configId, utils]);
}
