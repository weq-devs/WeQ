import { EventEmitter } from 'node:events';
import { observable } from '@trpc/server/observable';
import { z } from 'zod';
import { procedure, router } from '../trpc';
import { NOTICE_SEEN_LIMIT, type NoticeSeenState } from '../../../shared/notice_seen';

const binding = z.object({
  expectedAccountUin: z.string().min(1),
  expectedAccountConfigId: z.string().min(1),
  kind: z.enum(['friend', 'group']),
});
type Store = {
  getNoticeSeen(kind: 'friend' | 'group'): NoticeSeenState | null;
  mergeNoticeSeen(kind: 'friend' | 'group', state: NoticeSeenState): NoticeSeenState;
};

export function createNoticeReadRouter(resolve: (input: z.infer<typeof binding>) => Store) {
  const events = new EventEmitter();
  const key = (input: z.infer<typeof binding>) =>
    JSON.stringify([input.expectedAccountUin, input.expectedAccountConfigId, input.kind]);
  return router({
    snapshot: procedure
      .input(binding)
      .query(({ input }) => resolve(input).getNoticeSeen(input.kind)),
    merge: procedure
      .input(
        binding.extend({
          state: z.object({
            seen: z.array(z.string().max(512)).max(NOTICE_SEEN_LIMIT),
            readThrough: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          }),
        }),
      )
      .mutation(({ input }) => {
        const state = resolve(input).mergeNoticeSeen(input.kind, input.state);
        events.emit(key(input), state);
        return state;
      }),
    changed: procedure.input(binding).subscription(({ input }) => {
      resolve(input);
      return observable<NoticeSeenState | null>((emit) => {
        const receive = (state: NoticeSeenState) => emit.next(state);
        events.on(key(input), receive);
        // 订阅重连也带回快照，覆盖断线以及 query 到订阅之间的写入。
        emit.next(resolve(input).getNoticeSeen(input.kind));
        return () => events.off(key(input), receive);
      });
    }),
  });
}
