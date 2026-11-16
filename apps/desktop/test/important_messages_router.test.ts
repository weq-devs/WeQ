// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';
const rpc = vi.hoisted(() => ({
  uin: '10001',
  configId: 'source-a',
  list: vi.fn(),
  read: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => {
  const services = {
    accountConfig: { getRecord: () => ({ configId: rpc.configId }) },
    unreadInfo: { listImportantMessages: rpc.list },
  };
  const account = {
    context: {
      get uin() {
        return rpc.uin;
      },
    },
    groupMsgs: { listBySeqsInPartition: rpc.read },
  };
  return { accountEventBus: new EventEmitter(), getAppContext: () => ({ account, services }) };
});
const input = {
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'source-a',
  groupCode: '777',
};
const item = {
  chatType: 2,
  uid: '777',
  msgSeq: '102',
  senderUid: 'u_peer',
  sendTime: '10',
  unread: false,
  reasons: [{ kind: 'atMe', rawKind: 1000, text: '' }],
};
beforeEach(() => {
  vi.resetAllMocks();
  rpc.uin = '10001';
  rpc.configId = 'source-a';
  rpc.list.mockResolvedValue({ items: [item], nextBefore: null });
  rpc.read.mockResolvedValue([]);
});
it('离线按页批量补摘要和精确 ID，保留已读项，缺消息仍返回定位序号', async () => {
  const api = accountRouter.createCaller({});
  let result = await api.listImportantGroupMessages(input);
  expect(result.items[0]).toMatchObject({ ...item, preview: '', msgId: undefined });
  expect(rpc.read).toHaveBeenCalledWith('777', [102n]);
  rpc.read.mockResolvedValueOnce([
    {
      msgSeq: 102n,
      msgId: 9007199254740999n,
      senderUid: 'u_peer',
      sendTime: 11n,
      elements: [{ kind: 'text', textContent: '真实摘要' }],
    },
  ]);
  result = await api.listImportantGroupMessages({ ...input, kind: 'atMe', before: '103' });
  expect(result.items[0]).toMatchObject({ msgId: '9007199254740999', preview: '真实摘要' });
  expect(rpc.list).toHaveBeenLastCalledWith(
    expect.objectContaining({ kind: 'atMe', before: '103', uid: '777', chatType: 2 }),
  );
});
it('摘要读取失败保留重要消息，空页不读消息表', async () => {
  rpc.read.mockRejectedValueOnce(new Error('busy'));
  const api = accountRouter.createCaller({});
  expect(await api.listImportantGroupMessages(input)).toMatchObject({
    contentUnavailable: true,
    items: [item],
  });
  rpc.read.mockClear();
  rpc.list.mockResolvedValueOnce({ items: [], nextBefore: null });
  await api.listImportantGroupMessages(input);
  expect(rpc.read).not.toHaveBeenCalled();
});
it('拒绝无来源、旧账号、旧数据源及查询中途切换后的结果', async () => {
  const api = accountRouter.createCaller({});
  await expect(api.listImportantGroupMessages({ groupCode: '777' } as never)).rejects.toThrow();
  await expect(
    api.listImportantGroupMessages({ ...input, expectedAccountUin: '20002' }),
  ).rejects.toThrow('账号已切换');
  await expect(
    api.listImportantGroupMessages({ ...input, expectedAccountConfigId: 'source-b' }),
  ).rejects.toThrow('数据源已切换');
  expect(rpc.read).not.toHaveBeenCalled();
  rpc.read.mockImplementationOnce(async () => {
    rpc.configId = 'source-b';
    return [];
  });
  await expect(api.listImportantGroupMessages(input)).rejects.toThrow('数据源已切换');
});
