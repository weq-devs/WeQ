import { qqDatabaseReadOnly } from '@weq/db';
import { EventEmitter } from 'node:events';
import { getLogger, logErrorContext } from '@weq/service';
import { observable } from '@trpc/server/observable';
import { z } from 'zod/v3';
import { procedure, router } from '../trpc';
import {
  mergeNoticeSeen,
  newerGroupNoticeRead,
  NOTICE_SEEN_LIMIT,
  type GroupNoticeRead,
  type NoticeReadSnapshot,
} from '../../../shared/notice_seen';

const binding = z.object({
  expectedAccountUin: z.string().min(1),
  expectedAccountConfigId: z.string().min(1),
  kind: z.enum(['friend', 'group']),
});
type Store = {
  getNoticeSeen(kind: 'friend' | 'group'): NoticeReadSnapshot | null;
  setNoticeSeen(kind: 'friend' | 'group', state: NoticeReadSnapshot): void;
};
type Binding = z.infer<typeof binding>;
const logger = getLogger().child({ scope: 'notice-read' });

export function createNoticeReadSync(resolve: (input: Binding) => Store) {
  const events = new EventEmitter();
  const key = (input: Binding) =>
    JSON.stringify([input.expectedAccountUin, input.expectedAccountConfigId, input.kind]);
  const save = (input: Binding, store: Store, state: NoticeReadSnapshot) => {
    store.setNoticeSeen(input.kind, state);
    events.emit(key(input), state);
    return state;
  };
  const readRouter = router({
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
        const store = resolve(input);
        const previous = store.getNoticeSeen(input.kind);
        if (qqDatabaseReadOnly())
          return previous ?? { seen: [], readThrough: 0, baselinePending: true as const };
        const state = mergeNoticeSeen(previous, input.state);
        return save(
          input,
          store,
          previous?.qqGroupRead ? { ...state, qqGroupRead: previous.qqGroupRead } : state,
        );
      }),
    changed: procedure.input(binding).subscription(({ input }) => {
      resolve(input);
      return observable<NoticeReadSnapshot | null>((emit) => {
        const state = resolve(input).getNoticeSeen(input.kind);
        const receive = (state: NoticeReadSnapshot) => emit.next(state);
        events.on(key(input), receive);
        // 订阅重连也带回快照，覆盖断线以及 query 到订阅之间的写入。
        emit.next(state);
        return () => events.off(key(input), receive);
      });
    }),
  });
  return {
    router: readRouter,
    confirmGroupRead(account: Omit<Binding, 'kind'>, box: keyof GroupNoticeRead, sequence: string) {
      const input = { ...account, kind: 'group' } as const;
      try {
        const store = resolve(input);
        const previous = store.getNoticeSeen(input.kind);
        const current = previous?.qqGroupRead?.[box];
        const next = newerGroupNoticeRead(current, sequence);
        if (!next || next === current) return;
        save(input, store, {
          ...(previous ?? { seen: [], readThrough: 0, baselinePending: true }),
          qqGroupRead: { ...previous?.qqGroupRead, [box]: next },
        });
      } catch (error) {
        // 已读保存失败不影响收件箱查询，下一次收到 QQ 水位时再尝试。
        logger.warn('保存 QQ 群通知已读失败', logErrorContext(error));
      }
    },
  };
}
