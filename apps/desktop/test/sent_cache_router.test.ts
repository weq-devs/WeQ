import { beforeEach, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';
const rpc = vi.hoisted(() => ({
  cached: vi.fn(),
  removeCached: vi.fn(() => true),
  removeDb: vi.fn(async () => true),
  restoreCached: vi.fn(() => true),
  restoreDb: vi.fn(async () => true),
  cachedForExport: vi.fn(),
  deletedIds: vi.fn(() => ['roaming:protocol:2:77']),
  state: { switched: false },
}));
vi.mock('../src/main/context/app_context', () => {
  const context = {
    account: { context: { uin: '10001' } },
    services: {
      msgs: {
        deleteCachedSentMessage: rpc.removeCached,
        deleteMessage: rpc.removeDb,
        restoreCachedSentMessage: rpc.restoreCached,
        restoreMessage: rpc.restoreDb,
        getDeletedMessages: async () => [],
        getDeletedMsgIds: rpc.deletedIds,
      },
      gapHistory: { cachedForDeletion: rpc.cached, cachedForExport: rpc.cachedForExport },
    },
  };
  const otherServices = { ...context.services };
  return {
    getAppContext: () => ({
      ...context,
      services: rpc.state.switched ? otherServices : context.services,
    }),
  };
});
const row = {
  kind: 'group',
  conv: '777',
  msgId: '77',
  msgSeq: '2',
  senderUid: 'u_self',
  senderUin: '10001',
  sendTime: '1792544400',
  elements: [],
  localSent: true,
  sourceFormat: 'protocol',
};
beforeEach(() => {
  vi.clearAllMocks();
  rpc.state.switched = false;
  rpc.cached.mockResolvedValue([row]);
  rpc.cachedForExport.mockResolvedValue([row]);
});
it('缓存查询期间切换账号时拒绝旧请求，不写任一来源', async () => {
  rpc.cached.mockImplementationOnce(async () => {
    rpc.state.switched = true;
    return [row];
  });
  const api = accountRouter.createCaller({});
  await expect(
    api.deleteMessage({ msgId: 'roaming:protocol:2:77', kind: 'group', conv: '777' }),
  ).rejects.toThrow('账号已切换');
  expect(rpc.removeCached).not.toHaveBeenCalled();
  expect(rpc.removeDb).not.toHaveBeenCalled();
});
it('缓存删除用原会话和精确行身份读取，绝不将缓存 ID 送入 QQ 原库删除', async () => {
  const api = accountRouter.createCaller({});
  expect(
    await api.deleteMessage({ msgId: 'roaming:protocol:2:77', kind: 'group', conv: '777' }),
  ).toBe(true);
  expect(rpc.cached).toHaveBeenCalledWith('group', '777', 2);
  expect(rpc.removeCached).toHaveBeenCalledWith(row, false);
  expect(rpc.removeDb).not.toHaveBeenCalled();
  rpc.cached.mockResolvedValue([
    { ...row, conv: '888' },
    { ...row, msgId: '78', localSent: false },
  ]);
  await expect(
    api.deleteMessage({ msgId: 'roaming:protocol:2:77', kind: 'group', conv: '777' }),
  ).rejects.toThrow('当前会话缓存');
  expect(rpc.removeCached).toHaveBeenCalledOnce();
});
it.each([undefined, 'native', 'protocol'] as const)(
  '普通 %s 漫游删除透传隐藏选项并按精确身份隔离',
  async (sourceFormat) => {
    const value = { ...row, sourceFormat, localSent: false };
    rpc.cached.mockResolvedValue([value]);
    const id = `roaming:${sourceFormat ? `${sourceFormat}:` : ''}2:77`;
    const api = accountRouter.createCaller({});
    expect(
      await api.deleteMessage({ msgId: id, kind: 'group', conv: '777', hideAfterDelete: true }),
    ).toBe(true);
    expect(rpc.removeCached).toHaveBeenCalledWith(value, true);
    expect(rpc.removeDb).not.toHaveBeenCalled();
    rpc.deletedIds.mockReturnValueOnce([id]);
    rpc.cachedForExport.mockResolvedValueOnce([value]);
    expect(await api.deletedMessages({ kind: 'group', conv: '777' })).toMatchObject([
      { msgId: '77', msgSeq: '2', deletedKind: 'weq' },
    ]);
    expect(rpc.cachedForExport).toHaveBeenCalledWith('group', '777', true);
  },
);
it('缓存恢复要求会话目标，删除列表保留缓存身份并可恢复', async () => {
  const api = accountRouter.createCaller({});
  await expect(api.restoreMessage({ msgId: 'roaming:protocol:2:77' })).rejects.toThrow('会话目标');
  expect(
    await api.restoreMessage({ msgId: 'roaming:protocol:2:77', kind: 'group', conv: '777' }),
  ).toBe(true);
  expect(rpc.restoreCached).toHaveBeenCalledWith('roaming:protocol:2:77', 'group', '777');
  expect(rpc.restoreDb).not.toHaveBeenCalled();
  expect(await api.deletedMessages({ kind: 'group', conv: '777' })).toMatchObject([
    { msgId: '77', msgSeq: '2', source: 'roaming', localSent: true, deletedKind: 'weq' },
  ]);
});

it('缓存格式升级后删除列表仍能定位同一消息', async () => {
  rpc.cachedForExport.mockResolvedValueOnce([{ ...row, sourceFormat: 'native', localSent: false }]);
  const api = accountRouter.createCaller({});
  expect(await api.deletedMessages({ kind: 'group', conv: '777' })).toMatchObject([
    { msgId: '77', sourceFormat: 'native', deletedKind: 'weq' },
  ]);
});
