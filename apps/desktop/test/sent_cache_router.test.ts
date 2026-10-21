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
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    services: {
      msgs: {
        deleteCachedSentMessage: rpc.removeCached,
        deleteMessage: rpc.removeDb,
        restoreCachedSentMessage: rpc.restoreCached,
        restoreMessage: rpc.restoreDb,
        getDeletedMessages: async () => [],
        getDeletedMsgIds: rpc.deletedIds,
      },
      gapHistory: { cached: rpc.cached, cachedForExport: rpc.cachedForExport },
    },
  }),
}));
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
  rpc.cached.mockResolvedValue([row]);
  rpc.cachedForExport.mockResolvedValue([row]);
});
it('缓存删除用原会话和精确行身份读取，绝不将缓存 ID 送入 QQ 原库删除', async () => {
  const api = accountRouter.createCaller({});
  expect(
    await api.deleteMessage({ msgId: 'roaming:protocol:2:77', kind: 'group', conv: '777' }),
  ).toBe(true);
  expect(rpc.cached).toHaveBeenCalledWith('group', '777', 2, 2);
  expect(rpc.removeCached).toHaveBeenCalledWith(row);
  expect(rpc.removeDb).not.toHaveBeenCalled();
  rpc.cached.mockResolvedValue([
    { ...row, conv: '888' },
    { ...row, localSent: false },
  ]);
  await expect(
    api.deleteMessage({ msgId: 'roaming:protocol:2:77', kind: 'group', conv: '777' }),
  ).rejects.toThrow('当前会话缓存');
  expect(rpc.removeCached).toHaveBeenCalledOnce();
});
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
