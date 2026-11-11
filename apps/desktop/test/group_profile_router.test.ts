// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';
const rpc = vi.hoisted(() => ({ uin: '10001', configId: 'source-a', read: vi.fn() }));
vi.mock('../src/main/context/app_context', () => {
  const services = {
    accountConfig: { getRecord: () => ({ configId: rpc.configId, uin: rpc.uin }) },
    groupInfo: { getExtendedProfile: rpc.read },
  };
  return {
    accountEventBus: new EventEmitter(),
    getAppContext: () => ({
      account: { context: { uin: rpc.uin } },
      services,
      bootstrap: {
        ocrModels: { listByKind: () => [] },
        userConfig: { getSettings: () => ({ autoAttachQq: true }), getLocalModelId: () => null },
      },
      platform: null,
    }),
  };
});
const input = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a', groupId: 123 };
beforeEach(() => {
  vi.clearAllMocks();
  rpc.uin = '10001';
  rpc.configId = 'source-a';
  rpc.read.mockResolvedValue({
    groupId: 123,
    profile: null,
    updatedAt: null,
    source: 'empty',
    error: null,
  });
});
it('默认仅查询缓存，刷新选项显式转交服务', async () => {
  const api = accountRouter.createCaller({});
  await api.getGroupExtendedProfile(input);
  expect(rpc.read).toHaveBeenLastCalledWith(123, false, false);
  await api.getGroupExtendedProfile({ ...input, refresh: true, force: true });
  expect(rpc.read).toHaveBeenLastCalledWith(123, true, true);
});
it('拒绝缺来源、旧账号、同号旧数据源及非法群号', async () => {
  const api = accountRouter.createCaller({});
  await expect(api.getGroupExtendedProfile({ groupId: 123 } as never)).rejects.toThrow();
  await expect(
    api.getGroupExtendedProfile({ ...input, expectedAccountUin: '10002' }),
  ).rejects.toThrow('账号已切换');
  rpc.configId = 'source-b';
  await expect(api.getGroupExtendedProfile(input)).rejects.toThrow('数据源已切换');
  await expect(api.getGroupExtendedProfile({ ...input, groupId: 0 })).rejects.toThrow();
  expect(rpc.read).not.toHaveBeenCalled();
});
it('换数据源后迟到结果不返回；错群结果不返回', async () => {
  rpc.read.mockImplementationOnce(async () => {
    rpc.configId = 'source-b';
    return { groupId: 123 };
  });
  await expect(accountRouter.createCaller({}).getGroupExtendedProfile(input)).rejects.toThrow(
    '数据源已切换',
  );
  rpc.configId = 'source-a';
  rpc.read.mockResolvedValue({ groupId: 124 });
  await expect(accountRouter.createCaller({}).getGroupExtendedProfile(input)).rejects.toThrow(
    '不一致',
  );
});
