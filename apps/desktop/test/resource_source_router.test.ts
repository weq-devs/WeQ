// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { resourceCleanupRouter } from '../src/main/ipc/routers/resource_cleanup';
import { mediaResourceRouter } from '../src/main/ipc/routers/media_resource';

const f = vi.hoisted(() => ({
  uin: '10001',
  configId: 'synthetic-source',
  static: false,
  services: {} as object,
  analyze: vi.fn(),
  targets: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    account: { context: { uin: f.uin } },
    accountIsStatic: f.static,
    services: f.services,
  }),
}));
const source = { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic-source' };
beforeEach(() => {
  f.uin = '10001';
  f.configId = 'synthetic-source';
  f.static = false;
  f.analyze.mockReset().mockResolvedValue({ key: 'pic' });
  f.targets.mockReset().mockResolvedValue([]);
  f.cleanup.mockReset().mockResolvedValue({ freedBytes: 0, perTarget: [] });
  f.services = {
    accountConfig: { getRecord: () => ({ configId: f.configId }) },
    mediaResource: { analyzeTree: f.analyze },
    resourceCleanup: { listTargets: f.targets, cleanup: f.cleanup },
  };
});
it.each(['account', 'source'] as const)(
  '分析、清理目标和删除在 %s 不匹配时都拒绝，未调用文件服务',
  async (change) => {
    if (change === 'account') f.uin = '10002';
    else f.configId = 'other';
    await expect(
      mediaResourceRouter.createCaller({}).analyzeTree({ ...source, key: 'pic' }),
    ).rejects.toThrow('切换');
    await expect(resourceCleanupRouter.createCaller({}).listTargets(source)).rejects.toThrow(
      '切换',
    );
    await expect(
      resourceCleanupRouter
        .createCaller({})
        .cleanup({ ...source, instructions: [{ id: 'pic', variant: 'all' }] }),
    ).rejects.toThrow('切换');
    expect(f.analyze).not.toHaveBeenCalled();
    expect(f.targets).not.toHaveBeenCalled();
    expect(f.cleanup).not.toHaveBeenCalled();
  },
);
it.each(['source', 'instance'] as const)(
  '等待统计期间换 %s 不返回旧结果，即使账号号未改变',
  async (change) => {
    let finish!: (value: unknown) => void;
    f.analyze.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = mediaResourceRouter.createCaller({}).analyzeTree({ ...source, key: 'pic' });
    const rejected = expect(pending).rejects.toThrow('切换');
    await vi.waitFor(() => expect(f.analyze).toHaveBeenCalledOnce());
    if (change === 'source') f.configId = 'other';
    else f.services = { ...f.services };
    finish({ key: 'pic' });
    await rejected;
  },
);
it('静态账号仍不能清理；旧调用不带身份时保持参数兼容', async () => {
  f.static = true;
  await expect(
    resourceCleanupRouter
      .createCaller({})
      .cleanup({ instructions: [{ id: 'pic', variant: 'all' }] }),
  ).rejects.toThrow('静态账号');
  expect(f.cleanup).not.toHaveBeenCalled();
  f.static = false;
  expect(await resourceCleanupRouter.createCaller({}).listTargets()).toEqual([]);
  expect(await mediaResourceRouter.createCaller({}).analyzeTree({ key: 'pic' })).toEqual({
    key: 'pic',
  });
});
it('清理已按旧来源开始后，换实例不向新来源返回旧回执', async () => {
  let finish!: (value: unknown) => void;
  f.cleanup.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = resourceCleanupRouter
    .createCaller({})
    .cleanup({ ...source, instructions: [{ id: 'pic', variant: 'thumb' }] });
  const rejected = expect(pending).rejects.toThrow('实例已切换');
  await vi.waitFor(() => expect(f.cleanup).toHaveBeenCalledOnce());
  f.services = { ...f.services };
  finish({ freedBytes: 0, perTarget: [] });
  await rejected;
  expect(f.cleanup).toHaveBeenCalledOnce();
});
