// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';
const rpc = vi.hoisted(() => ({
  uin: '10001',
  configId: 'source-a',
  read: vi.fn(),
  preview: vi.fn(),
  detail: vi.fn(),
  userGroups: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => {
  const services = {
    accountConfig: { getRecord: () => ({ configId: rpc.configId, uin: rpc.uin }) },
    groupInfo: {
      getExtendedProfile: rpc.read,
      getMemberPreview: rpc.preview,
      getGroupDetail: rpc.detail,
      listUserGroups: rpc.userGroups,
    },
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
it('成员预览要求当前账号与数据源，离线交由局部缓存读取', async () => {
  rpc.preview.mockResolvedValue({ members: [], source: 'local', partial: true, error: null });
  const api = accountRouter.createCaller({});
  const target = {
    expectedAccountUin: input.expectedAccountUin,
    expectedAccountConfigId: input.expectedAccountConfigId,
    groupCode: '12345',
  };
  expect(await api.groupMemberPreview(target)).toEqual({
    members: [],
    source: 'local',
    partial: true,
    error: null,
  });
  expect(rpc.preview).toHaveBeenLastCalledWith('12345', false);
  rpc.configId = 'source-b';
  await expect(api.groupMemberPreview(target)).rejects.toThrow('数据源已切换');
  expect(rpc.preview).toHaveBeenCalledTimes(1);
});
it('成员预览不接收读取过程中切换数据源后的响应', async () => {
  rpc.preview.mockImplementation(async () => {
    rpc.configId = 'source-b';
    return { members: [], source: 'local', partial: true, error: null };
  });
  await expect(
    accountRouter.createCaller({}).groupMemberPreview({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      groupCode: '12345',
    }),
  ).rejects.toThrow('数据源已切换');
});
it('基础群资料兼容旧调用，同时拒绝来源不匹配和迟到结果', async () => {
  rpc.detail.mockResolvedValue(null);
  const api = accountRouter.createCaller({});
  expect(await api.getGroupDetail({ groupCode: '12345' })).toBeNull();
  await expect(
    api.getGroupDetail({
      expectedAccountUin: '10002',
      expectedAccountConfigId: 'source-a',
      groupCode: '12345',
    }),
  ).rejects.toThrow('账号已切换');
  rpc.detail.mockImplementationOnce(async () => {
    rpc.configId = 'source-b';
    return null;
  });
  await expect(
    api.getGroupDetail({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      groupCode: '12345',
    }),
  ).rejects.toThrow('数据源已切换');
});
it('联系人所在群分页沿用旧调用，并校验账号及数据源', async () => {
  rpc.userGroups.mockResolvedValue([]);
  const api = accountRouter.createCaller({});
  await expect(api.listUserGroups({ uid: 'u_fixture' })).resolves.toEqual([]);
  expect(rpc.userGroups).toHaveBeenLastCalledWith('u_fixture', 100, 0);
  await api.listUserGroups({ ...input, uid: 'u_fixture', limit: 100, offset: 100 });
  expect(rpc.userGroups).toHaveBeenLastCalledWith('u_fixture', 100, 100);
  await expect(
    api.listUserGroups({ ...input, expectedAccountUin: '10002', uid: 'u_fixture' }),
  ).rejects.toThrow('账号已切换');
  rpc.userGroups.mockImplementationOnce(async () => {
    rpc.configId = 'source-b';
    return [];
  });
  await expect(api.listUserGroups({ ...input, uid: 'u_fixture' })).rejects.toThrow('数据源已切换');
});
