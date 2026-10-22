import { describe, expect, it, vi } from 'vitest';
import { decode, encode, GetFriendSnsPage, SNS_FRIEND_DISTURB } from '@weq/protocol';
import { AccountWriteService } from '../src/account/account_write';

const friend = { uid: 'u_friend', uin: 10002n, qid: '', categoryId: 0 };
const enabled = Uint8Array.from([0, 0, 0, 1, 255, 255, 255, 255]);
const row = (value?: Uint8Array) => ({
  uid: friend.uid,
  uin: friend.uin,
  ...(value === undefined ? {} : { sns: [{ key: SNS_FRIEND_DISTURB, value }] }),
});
function fixture(pages: Array<Record<string, unknown>>) {
  let pid = 5;
  const send = vi.fn(
    async (
      _pid: number,
      _command: number,
      _sub: number,
      _body: Buffer,
      _isUid?: boolean,
      _needSign?: boolean,
    ) => {
      const page = pages.shift();
      if (!page) throw new Error('未预期的额外请求');
      return Buffer.from(encode(GetFriendSnsPage.respSchema, page));
    },
  );
  const service = new AccountWriteService(
    { sendOidbPacket: send, sendPacket: async () => Buffer.alloc(0) },
    {
      uin: '10001',
      selfUid: 'u_self',
      getBuddy: async (uid) => (uid === friend.uid ? friend : null),
      listCategories: async () => [],
    },
    () => pid,
  );
  return {
    service,
    send,
    switchPid: () => {
      pid = 6;
    },
  };
}

describe('好友免打扰云端读回', () => {
  it.each([
    [enabled, true],
    [new Uint8Array(), false],
    [undefined, false],
    [Uint8Array.of(1, 2, 3, 4, 255), null],
    [Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 0), null],
  ])('完整名册中的规范值／缺省与异常值分开处理 %#', async (value, expected) => {
    const f = fixture([{ selfUin: 10001n, friends: [row(value)] }]);
    expect(await f.service.getFriendDisturb(friend.uid)).toEqual({
      uid: friend.uid,
      enabled: expected,
    });
    const call = f.send.mock.calls[0]!;
    expect(call.slice(0, 3)).toEqual([5, GetFriendSnsPage.command, GetFriendSnsPage.subCommand]);
    const request = decode(GetFriendSnsPage.reqSchema, call[3]);
    expect(request.snsKeys).toContain(SNS_FRIEND_DISTURB);
    expect(call[4]).toBe(false);
    expect(call[5]).toBe(true);
  });
  it('完整遍历分页并携带原始游标，不能找到目标就提前结束', async () => {
    const cookie = Uint8Array.of(7, 0, 8);
    const f = fixture([
      { selfUin: 10001n, cookie, friends: [row()] },
      { selfUin: 10001n, friends: [{ uid: 'u_other', uin: 10003n }] },
    ]);
    expect(await f.service.getFriendDisturb(friend.uid)).toEqual({
      uid: friend.uid,
      enabled: false,
    });
    expect(f.send).toHaveBeenCalledTimes(2);
    const call = f.send.mock.calls[1]!;
    expect(decode(GetFriendSnsPage.reqSchema, call[3]).cookie).toEqual(Buffer.from(cookie));
  });
  it('拒绝非好友且不发包', async () => {
    const f = fixture([]);
    await expect(f.service.getFriendDisturb('u_stranger')).rejects.toThrow('不是');
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each([
    [{ selfUin: 99999n, friends: [row(enabled)] }],
    [{ selfUin: 10001n, friends: [] }],
    [{ selfUin: 10001n, friends: [{ ...row(enabled), uin: 10003n }] }],
    [{ selfUin: 10001n, friends: [row(enabled), row(enabled)] }],
    [
      { selfUin: 10001n, cookie: Uint8Array.of(1), friends: [row()] },
      { selfUin: 10001n, cookie: Uint8Array.of(1) },
    ],
    [
      { selfUin: 10001n, cookie: Uint8Array.of(1), friends: [row()] },
      { selfUin: 10001n, friends: [row(enabled)] },
    ],
  ])('账号／目标不符、缺目标、重复或游标循环不能误报关闭 %#', async (...pages) => {
    const f = fixture(pages);
    await expect(f.service.getFriendDisturb(friend.uid)).rejects.toThrow();
  });
  it('在途切换运行进程时不返回旧结果，也不继续分页', async () => {
    const f = fixture([{ selfUin: 10001n, cookie: Uint8Array.of(1), friends: [row()] }]);
    f.send.mockImplementationOnce(async () => {
      f.switchPid();
      return Buffer.from(
        encode(GetFriendSnsPage.respSchema, {
          selfUin: 10001n,
          cookie: Uint8Array.of(1),
          friends: [row()],
        }),
      );
    });
    await expect(f.service.getFriendDisturb(friend.uid)).rejects.toThrow('切换');
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('分页中断不提前把已见目标的属性缺省解释为关闭', async () => {
    const f = fixture([{ selfUin: 10001n, cookie: Uint8Array.of(1), friends: [row()] }]);
    await expect(f.service.getFriendDisturb(friend.uid)).rejects.toThrow('额外请求');
  });
  it('允许没有账号回显的空结束页，仍需先前页面有匹配的好友', async () => {
    const f = fixture([
      { selfUin: 10001n, cookie: Uint8Array.of(1), friends: [row()] },
      { isEnd: true },
    ]);
    expect(await f.service.getFriendDisturb(friend.uid)).toEqual({
      uid: friend.uid,
      enabled: false,
    });
  });
  it('分页上限有界，超过上限不返回部分名册', async () => {
    const f = fixture(
      Array.from({ length: 100 }, (_, i) => ({
        selfUin: 10001n,
        cookie: Uint8Array.of(i + 1),
        ...(i === 0 ? { friends: [row()] } : {}),
      })),
    );
    await expect(f.service.getFriendDisturb(friend.uid)).rejects.toThrow('上限');
    expect(f.send).toHaveBeenCalledTimes(100);
  });
});
