import { describe, expect, it, vi } from 'vitest';
import { encode, GetFriendSnsPage, SetFriendSpecialCare } from '@weqbot/protocol';
import { AccountWriteService } from '../src/account/account_write';

function fixture() {
  let pid = 1;
  const getBuddy = vi.fn(async (uid: string) =>
    uid === 'u_friend' ? { uid, uin: 10002n, qid: '', categoryId: 0 } : null,
  );
  const send = vi.fn(async (_pid: number, cmd: number) =>
    cmd === GetFriendSnsPage.command
      ? Buffer.from(
          encode(GetFriendSnsPage.respSchema, {
            selfUin: 10001n,
            friends: [{ uid: 'u_friend', uin: 10002n }],
          }),
        )
      : Buffer.from([8, 0]),
  );
  const service = new AccountWriteService(
    { sendOidbPacket: send, sendPacket: async () => Buffer.alloc(0) },
    {
      uin: '10001',
      selfUid: 'u_self',
      getBuddy,
      listCategories: async () => [],
    },
    () => pid,
  );
  return {
    service,
    send,
    getBuddy,
    switchPid: () => {
      pid++;
    },
  };
}

describe('特别关心写入与隔离', () => {
  it('不预读云端名册，只写一次，不把未知业务 ACK 当确认', async () => {
    const f = fixture();
    expect(await f.service.friendSpecialCare('u_friend', true)).toEqual({ state: 'unconfirmed' });
    expect(f.send.mock.calls.map((call) => call[1])).toEqual([SetFriendSpecialCare.command]);
  });
  it('非好友或本地好友身份读取失败均不写', async () => {
    const f = fixture();
    await expect(f.service.friendSpecialCare('u_stranger', true)).rejects.toThrow('不是');
    f.getBuddy.mockRejectedValueOnce(new Error('读取失败'));
    await expect(f.service.friendSpecialCare('u_friend', true)).rejects.toThrow('读取失败');
    expect(f.send).not.toHaveBeenCalled();
  });
  it('写超时返回待核对而不重放，允许调用方独立读取', async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error('超时'));
    expect(await f.service.friendSpecialCare('u_friend', true)).toEqual({ state: 'unconfirmed' });
    expect(f.send.mock.calls.map((call) => call[1])).toEqual([SetFriendSpecialCare.command]);
    expect(await f.service.getFriendSpecialCare('u_friend')).toEqual({
      uid: 'u_friend',
      enabled: false,
      zone: false,
      ring: false,
    });
    expect(f.send.mock.calls.map((call) => call[1])).toEqual([
      SetFriendSpecialCare.command,
      GetFriendSnsPage.command,
    ]);
  });
  it('读取本地好友身份期间切换运行时，不发送写入', async () => {
    const f = fixture();
    const getBuddy = f.getBuddy.getMockImplementation()!;
    f.getBuddy.mockImplementationOnce(async (uid) => {
      const buddy = await getBuddy(uid);
      f.switchPid();
      return buddy;
    });
    await expect(f.service.friendSpecialCare('u_friend', true)).rejects.toThrow('切换');
    expect(f.send).not.toHaveBeenCalled();
  });
});
