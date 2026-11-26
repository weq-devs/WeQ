// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { bootstrapRouter } from '../src/main/ipc/routers/bootstrap';

const mock = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('../src/main/context/app_context', () => ({
  requireBootstrap: () => ({ userConfig: { setSettings: mock.write } }),
}));
beforeEach(() => mock.write.mockReset());
it.each([false, true])('右上角标记 %s 只保存自己的偏好，不改变自动策略或通知', async (enabled) => {
  await bootstrapRouter.createCaller({}).setQqStatusIndicatorEnabled({ enabled });
  expect(mock.write).toHaveBeenCalledOnce();
  expect(mock.write).toHaveBeenCalledWith({ qqStatusIndicatorEnabled: enabled });
});
it('非法输入、额外字段与授权失败均不写入', async () => {
  const caller = bootstrapRouter.createCaller({});
  for (const input of [{ enabled: 'false' }, { enabled: false, autoAttachQq: false }])
    await expect(
      caller.setQqStatusIndicatorEnabled(input as { enabled: boolean }),
    ).rejects.toThrow();
  await expect(
    bootstrapRouter
      .createCaller({
        authorize: () => {
          throw new Error('合成拒绝');
        },
      })
      .setQqStatusIndicatorEnabled({ enabled: false }),
  ).rejects.toThrow('合成拒绝');
  expect(mock.write).not.toHaveBeenCalled();
});
