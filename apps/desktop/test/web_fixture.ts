import { observable } from '@trpc/server/observable';
import { procedure, router } from '../src/main/ipc/trpc';

// 手机容器集成测试专用，不打开账号或读取真实 QQ 数据。
export const webFixtureRouter = router({
  probe: procedure.query(() => ({ fixture: true })),
  stream: procedure.subscription(() =>
    observable<string>((emit) => {
      emit.next('ready');
      return () => {};
    }),
  ),
});
