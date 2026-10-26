// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { bootstrapRouter } from '../src/main/ipc/routers/bootstrap';

const f = vi.hoisted(() => ({ write: vi.fn(), cancel: vi.fn() }));
vi.mock('../src/main/context/app_context', () => ({
  requireBootstrap: () => ({ userConfig: { setSettings: f.write } }),
  getAppContext: () => ({ services: { unreadInfo: { cancelReports: f.cancel } } }),
}));
beforeEach(() => {
  f.write.mockReset();
  f.cancel.mockReset();
});
it.each([false, true])('总开关 %s 一次提交两个旧字段，不创建第三个持久字段', async (enabled) => {
  await bootstrapRouter.createCaller({}).setReadSyncEnabled({ enabled });
  expect(f.write).toHaveBeenCalledOnce();
  expect(f.write).toHaveBeenCalledWith({
    reportReadEnabled: enabled,
    manualReadReportEnabled: enabled,
  });
  expect(f.cancel).toHaveBeenCalledTimes(enabled ? 0 : 1);
});
it('受限横幅只保存被动提醒偏好，不改权限或上报状态', async () => {
  await bootstrapRouter.createCaller({}).setRestrictedModeBannerEnabled({ enabled: false });
  expect(f.write).toHaveBeenCalledOnce();
  expect(f.write).toHaveBeenCalledWith({ restrictedModeBannerEnabled: false });
  expect(f.cancel).not.toHaveBeenCalled();
});
it('写入失败不操作运行中的上报队列；授权失败和额外字段不写入', async () => {
  f.write.mockImplementationOnce(() => {
    throw new Error('合成写入失败');
  });
  await expect(
    bootstrapRouter.createCaller({}).setReadSyncEnabled({ enabled: false }),
  ).rejects.toThrow('合成写入失败');
  expect(f.cancel).not.toHaveBeenCalled();
  f.write.mockClear();
  await expect(
    bootstrapRouter
      .createCaller({
        authorize: () => {
          throw new Error('合成拒绝');
        },
      })
      .setReadSyncEnabled({ enabled: true }),
  ).rejects.toThrow('合成拒绝');
  await expect(
    bootstrapRouter
      .createCaller({})
      .setReadSyncEnabled(JSON.parse('{"enabled":true,"reportReadEnabled":false}')),
  ).rejects.toThrow();
  expect(f.write).not.toHaveBeenCalled();
});
