// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';
const rpc = vi.hoisted(() => ({ uin: '10001', configId: 'source-a', read: vi.fn() }));
vi.mock('../src/main/context/app_context', () => {
  const services = {
    accountConfig: { getRecord: () => ({ configId: rpc.configId }) },
  };
  const account = {
    context: {
      get uin() {
        return rpc.uin;
      },
    },
    groupMsgs: { findFileMessages: rpc.read },
  };
  return {
    accountEventBus: new EventEmitter(),
    getAppContext: () => ({
      account,
      services,
      bootstrap: { userConfig: { getSettings: () => ({ autoAttachQq: false }) } },
    }),
  };
});
const input = {
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'source-a',
  groupCode: '777',
  fileId: 'file',
};
beforeEach(() => {
  vi.clearAllMocks();
  rpc.uin = '10001';
  rpc.configId = 'source-a';
  rpc.read.mockResolvedValue({ messages: [], nextBefore: null });
});
it('离线查询保留大整数 ID，游标不经 number，按群和文件 ID 查询', async () => {
  const before = { msgId: '9007199254740999', msgSeq: '9007199254740998', sendTime: '1794380000' };
  rpc.read.mockResolvedValue({
    messages: [
      {
        msgId: BigInt(before.msgId),
        msgSeq: BigInt(before.msgSeq),
        sendTime: BigInt(before.sendTime),
        senderUid: 'u_fixture',
      },
    ],
    nextBefore: {
      msgId: BigInt(before.msgId),
      msgSeq: BigInt(before.msgSeq),
      sendTime: BigInt(before.sendTime),
    },
  });
  const result = await accountRouter.createCaller({}).findGroupFileMessages({ ...input, before });
  expect(result).toEqual({ messages: [{ ...before, senderUid: 'u_fixture' }], nextBefore: before });
  expect(rpc.read).toHaveBeenCalledWith('777', 'file', {
    msgId: BigInt(before.msgId),
    msgSeq: BigInt(before.msgSeq),
    sendTime: BigInt(before.sendTime),
  });
});
it('拒绝无来源、旧账号、旧数据源及非法查询，不读库', async () => {
  const api = accountRouter.createCaller({});
  await expect(
    api.findGroupFileMessages({ groupCode: '777', fileId: 'file' } as never),
  ).rejects.toThrow();
  await expect(
    api.findGroupFileMessages({ ...input, expectedAccountUin: '20002' }),
  ).rejects.toThrow('账号已切换');
  await expect(
    api.findGroupFileMessages({ ...input, expectedAccountConfigId: 'source-b' }),
  ).rejects.toThrow('数据源已切换');
  await expect(api.findGroupFileMessages({ ...input, groupCode: 'bad' })).rejects.toThrow();
  await expect(api.findGroupFileMessages({ ...input, fileId: '' })).rejects.toThrow();
  expect(rpc.read).not.toHaveBeenCalled();
});
it('查询期间切换数据源时不返回旧结果', async () => {
  rpc.read.mockImplementationOnce(async () => {
    rpc.configId = 'source-b';
    return { messages: [], nextBefore: null };
  });
  await expect(accountRouter.createCaller({}).findGroupFileMessages(input)).rejects.toThrow(
    '数据源已切换',
  );
});
