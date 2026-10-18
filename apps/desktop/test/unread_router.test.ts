import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';

const fixture = vi.hoisted(() => ({
  uin: '10001',
  staticAccount: false,
  getUnreadInfos: vi.fn(),
  markRead: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    account: { context: { uin: fixture.uin } },
    accountIsStatic: fixture.staticAccount,
    services: {
      unreadInfo: { getUnreadInfos: fixture.getUnreadInfos, markReadAndReport: fixture.markRead },
    },
  }),
}));
const targets = [{ chatType: 2 as const, uid: '777' }];
beforeEach(() => {
  vi.resetAllMocks();
  fixture.uin = '10001';
  fixture.staticAccount = false;
  fixture.getUnreadInfos.mockResolvedValue([
    {
      ...targets[0],
      msgSeq: 10,
      latestSeq: '11',
      highlights: [
        { kind: 'atMe', rawKind: 1000, msgSeq: 11, senderUid: 'u_fixture', sendTime: 1, text: '' },
      ],
    },
  ]);
  fixture.markRead.mockResolvedValue({ changed: true, report: { state: 'disabled' } });
});

describe('未读 IPC', () => {
  it('批量响应保留精确字符串字段，且限制单批大小', async () => {
    const api = accountRouter.createCaller({});
    expect(await api.getUnreadInfos({ expectedAccountUin: '10001', targets })).toMatchObject([
      {
        uid: '777',
        msgSeq: '10',
        latestSeq: '11',
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

  it('正常请求传递固定水位，静态账号不写入', async () => {
    const api = accountRouter.createCaller({});
    await api.markConversationRead({
      expectedAccountUin: '10001',
      ...targets[0]!,
      latestSeq: '11',
    });
    expect(fixture.markRead).toHaveBeenCalledWith(2, '777', '11');
    fixture.staticAccount = true;
    expect(await api.markConversationRead({ ...targets[0]! })).toEqual({
      changed: false,
      report: { state: 'unavailable' },
    });
    expect(fixture.markRead).toHaveBeenCalledTimes(1);
  });
});
