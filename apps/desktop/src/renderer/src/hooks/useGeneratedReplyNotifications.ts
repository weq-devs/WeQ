import { useEffect, useRef } from 'react';
import { generatedMuteKey } from '@weq/service/client-preferences';
import { useToast } from '../components/Toast.shared';
import {
  accountBinding,
  preferenceValue,
  sharedAccountRecords,
  useAccountRecords,
} from '../lib/clientPreferences';
import { notificationSource, openNotificationSource } from '../lib/notificationNavigation.shared';
import { notificationEnabled, publishNotificationSystem } from '../lib/notificationPolicy';
import { IS_WEB } from '../lib/target.shared';
import { useAppLock } from '../state/lock';
import { client, trpc } from '../trpc/client';
import { messageNotificationDedupe } from '../../../shared/notification_dedupe';
import { notificationInlineText } from '../../../shared/notification_copy';

const claimReply = messageNotificationDedupe();
const event = 'assistantReply';

function replyRead(reads: Readonly<Record<string, unknown>>, key: string, ts: number) {
  const position = reads[key];
  return typeof position === 'string' && /^\d+$/.test(position) && BigInt(position) >= BigInt(ts);
}

/** 订阅主工作区，不随某个会话组件的挂载、切出或前后台切换而重建。 */
export function useGeneratedReplyNotifications(uin: string, configId: string, readingId?: string) {
  const utils = trpc.useUtils();
  const reading = useRef(readingId);
  reading.current = readingId;
  const scope = uin && configId ? JSON.stringify([uin, configId]) : '';
  const reads = useAccountRecords('reads', scope);
  const pending = useRef(new Map<number, { scope: string; key: string; ts: number }>());
  useEffect(() => {
    if (!pending.current.size) return;
    const toast = useToast.getState();
    const active = new Set(toast.toasts.map(({ id }) => id));
    for (const [id, reply] of pending.current) {
      if (!active.has(id)) pending.current.delete(id);
      else if (reply.scope === scope && replyRead(reads, reply.key, reply.ts)) {
        toast.dismiss(id);
        pending.current.delete(id);
      }
    }
  }, [scope, reads]);
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
        const name = notificationInlineText(reply.title, 38);
        const fallback =
          reply.kind === 'assistant' ? 'WeQ 助手' : reply.kind === 'group' ? '克隆群聊' : '克隆体';
        const title = privacy ? 'WeQ' : `${name || fallback} · 新回复`;
        const detail = privacy ? '' : reply.preview?.trim() || '';
        const body = privacy ? '收到新回复' : notificationInlineText(detail, 180);
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
        const readKey = `${reply.kind === 'group' ? 'clone-group' : reply.kind}:${reply.conversationId}`;
        const ts = reply.ts;
        const trackRead = ts !== undefined && Number.isSafeInteger(ts) && ts > 0;
        if (banner && !(trackRead && replyRead(sharedAccountRecords('reads'), readKey, ts))) {
          const toast = useToast.getState();
          const bannerId = toast.push({
            key,
            event,
            title,
            summary: body,
            detail,
            source,
            system: false,
          });
          if (trackRead) {
            if (pending.current.size >= 256) {
              const active = new Set(toast.toasts.map(({ id }) => id));
              for (const id of pending.current.keys())
                if (!active.has(id)) pending.current.delete(id);
            }
            pending.current.set(bannerId, { scope, key: readKey, ts });
          }
        }
        if (system)
          publishNotificationSystem(event, title, body, () => openNotificationSource(source), key);
      },
    });
    return () => subscription.unsubscribe();
  }, [uin, configId, scope, utils]);
}
