import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';

const fixture = vi.hoisted(() => ({
  uin: '10001',
  staticAccount: false,
  configId: 'source-a',
  getUnreadInfos: vi.fn(),
  markRead: vi.fn(),
  markLocalRead: vi.fn(),
  setReadState: vi.fn(),
  undoReadState: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => {
  const services = {
    accountConfig: { getRecord: () => ({ configId: fixture.configId }) },
    unreadInfo: {
      getUnreadInfos: fixture.getUnreadInfos,
      markReadAndReport: fixture.markRead,
      markLocalRead: fixture.markLocalRead,
      setReadState: fixture.setReadState,
      undoReadState: fixture.undoReadState,
    },
  };
  return {
    getAppContext: () => ({
      account: { context: { uin: fixture.uin } },
      accountIsStatic: fixture.staticAccount,
      services,
    }),
  };
});
const targets = [{ chatType: 2 as const, uid: '777' }];
beforeEach(() => {
  vi.resetAllMocks();
  fixture.uin = '10001';
  fixture.staticAccount = false;
  fixture.configId = 'source-a';
  fixture.getUnreadInfos.mockResolvedValue([
    {
      ...targets[0],
      msgSeq: 10,
      latestSeq: '11',
      unreadCount: 1,
      readSeq: '10',
      highlights: [
        { kind: 'atMe', rawKind: 1000, msgSeq: 11, senderUid: 'u_fixture', sendTime: 1, text: '' },
      ],
    },
  ]);
  fixture.markRead.mockResolvedValue({ changed: true, report: { state: 'disabled' } });
  fixture.markLocalRead.mockResolvedValue(true);
});

describe('未读 IPC', () => {
  it('设备保留真实类型，同号切来源后拒绝旧查询和标已读', async () => {
    const api = accountRouter.createCaller({});
    const input = {
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      targets: [{ chatType: 8 as const, uid: 'device-fixture' }],
    };
    await api.getUnreadInfos(input);
    expect(fixture.getUnreadInfos).toHaveBeenCalledWith(input.targets);
    fixture.getUnreadInfos.mockImplementationOnce(async () => {
      fixture.configId = 'source-b';
      return [];
    });
    await expect(api.getUnreadInfos(input)).rejects.toThrow('数据源已切换');
    await expect(
      api.markConversationRead({
        expectedAccountUin: '10001',
        expectedAccountConfigId: 'source-a',
        chatType: 8,
        uid: 'device-fixture',
        latestSeq: '1',
      }),
    ).rejects.toThrow('数据源已切换');
    expect(fixture.markRead).not.toHaveBeenCalled();
  });
  it('手动批量标记及撤销强制账号隔离，结果沿用未读序列化', async () => {
    const api = accountRouter.createCaller({});
    const token = '00000000-0000-4000-8000-000000000001';
    fixture.setReadState.mockResolvedValue({
      undoToken: token,
      rows: await fixture.getUnreadInfos(),
    });
    fixture.undoReadState.mockResolvedValue({ restored: 1, rows: await fixture.getUnreadInfos() });
    expect(
      await api.setConversationReadState({ expectedAccountUin: '10001', targets, unread: true }),
    ).toMatchObject({
      undoToken: token,
      rows: [{ latestSeq: '11', highlights: [{ msgSeq: '11' }] }],
    });
    expect(fixture.setReadState).toHaveBeenCalledWith(targets, true);
    expect(
      (await api.undoConversationReadState({ expectedAccountUin: '10001', undoToken: token }))
        .restored,
    ).toBe(1);
    fixture.uin = '10002';
    await expect(
      api.setConversationReadState({ expectedAccountUin: '10001', targets, unread: false }),
    ).rejects.toThrow('账号已切换');
    await expect(
      api.undoConversationReadState({ expectedAccountUin: '10001', undoToken: token }),
    ).rejects.toThrow('账号已切换');
    expect(fixture.setReadState).toHaveBeenCalledTimes(1);
    expect(fixture.undoReadState).toHaveBeenCalledTimes(1);
    await expect(
      api.setConversationReadState({ expectedAccountUin: '10002', targets: [], unread: true }),
    ).rejects.toThrow();
  });
  it('批量响应保留精确字符串字段，且限制单批大小', async () => {
    const api = accountRouter.createCaller({});
    expect(await api.getUnreadInfos({ expectedAccountUin: '10001', targets })).toMatchObject([
      {
        uid: '777',
        msgSeq: '10',
        latestSeq: '11',
        unreadCount: 1,
        readSeq: '10',
        readError: false,
        highlights: [{ msgSeq: '11', sendTime: '1' }],
      },
    ]);
    expect(fixture.getUnreadInfos).toHaveBeenCalledWith(targets);
    await expect(
      api.getUnreadInfos({
        expectedAccountUin: '10001',
        targets: Array.from({ length: 257 }, () => targets[0]!),
      }),
    ).rejects.toThrow();
    expect(fixture.getUnreadInfos).toHaveBeenCalledTimes(1);
  });

  it('切号后的旧刷新和已读请求不得访问新账号', async () => {
    fixture.uin = '10002';
    const api = accountRouter.createCaller({});
    await expect(api.getUnreadInfos({ expectedAccountUin: '10001', targets })).rejects.toThrow(
      '账号已切换',
    );
    await expect(
      api.markConversationRead({ expectedAccountUin: '10001', ...targets[0]! }),
    ).rejects.toThrow('账号已切换');
    expect(fixture.getUnreadInfos).not.toHaveBeenCalled();
    expect(fixture.markRead).not.toHaveBeenCalled();
  });

  it('正常请求传递固定水位，静态账号只推进 WeQ 本地阅读位置', async () => {
    const api = accountRouter.createCaller({});
    await api.markConversationRead({
      expectedAccountUin: '10001',
      ...targets[0]!,
      latestSeq: '11',
    });
    expect(fixture.markRead).toHaveBeenCalledWith(2, '777', '11');
    fixture.staticAccount = true;
    expect(await api.markConversationRead({ ...targets[0]! })).toEqual({
      changed: true,
      report: { state: 'unavailable' },
    });
    expect(fixture.markRead).toHaveBeenCalledTimes(1);
    expect(fixture.markLocalRead).toHaveBeenCalledWith(2, '777', undefined);
  });
});
