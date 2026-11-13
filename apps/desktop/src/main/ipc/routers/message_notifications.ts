import { z } from 'zod';
import { observable } from '@trpc/server/observable';
import { getHost } from '@weq/service';
import { procedure, router } from '../trpc';
import { globalClientState } from './client_state';
import {
  consumeMessageNoticeClick,
  messageNoticeClicks,
  pushMessageNoticeClick,
} from '../../message_notice_bus';
import type { WebNotice } from '../../web/notices';

const binding = z.object({
  expectedAccountUin: z.string().min(1),
  expectedAccountConfigId: z.string().min(1),
});
const shown = new Set<string>();
export function createMessageNotificationsRouter(
  resolve: (input: z.infer<typeof binding>) => unknown,
) {
  return router({
    badge: procedure
      .input(binding.extend({ count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }))
      .mutation(({ input }) => {
        resolve(input);
        const enabled = globalClientState().snapshot().values.applicationBadge !== false;
        return getHost().setApplicationBadge?.(enabled ? input.count : 0) ?? false;
      }),
    notify: procedure
      .input(
        binding.extend({
          messageId: z.string().min(1).max(128),
          kind: z.enum(['c2c', 'group']),
          conv: z.string().min(1),
          seq: z.string().regex(/^[1-9]\d*$/),
          title: z.string().max(512),
          body: z.string().max(2048),
          private: z.boolean(),
        }),
      )
      .mutation(({ input }) => {
        resolve(input);
        const values = globalClientState().snapshot().values;
        if (values.messageNotifications !== true) return false;
        const key = JSON.stringify([
          input.expectedAccountConfigId,
          input.kind,
          input.conv,
          input.messageId,
        ]);
        if (shown.has(key)) return true;
        const hide = input.private || values.privacyMode === true;
        const notice: WebNotice = {
          uin: input.expectedAccountUin,
          configId: input.expectedAccountConfigId,
          kind: 'message',
          title: hide ? 'WeQ' : input.title,
          body: hide ? '收到新消息' : input.body,
          target: { kind: input.kind, conv: input.conv, seq: input.seq },
        };
        const supported =
          getHost().showMessageNotification?.(notice, () => pushMessageNoticeClick(notice)) ??
          false;
        if (supported) {
          shown.add(key);
          while (shown.size > 5000) shown.delete(shown.values().next().value!);
        }
        return supported;
      }),
    consume: procedure.input(binding).mutation(({ input }) => {
      resolve(input);
      return consumeMessageNoticeClick(input.expectedAccountUin, input.expectedAccountConfigId);
    }),
    onClick: procedure.input(binding).subscription(({ input }) => {
      resolve(input);
      return observable<WebNotice>((emit) => {
        const listener = (notice: WebNotice) => {
          if (
            notice.uin === input.expectedAccountUin &&
            notice.configId === input.expectedAccountConfigId
          )
            emit.next(notice);
        };
        messageNoticeClicks.on('click', listener);
        return () => {
          messageNoticeClicks.off('click', listener);
        };
      });
    }),
  });
}
