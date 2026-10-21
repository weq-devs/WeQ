import { describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { decode, encode, GetProfileLike, SendProfileLike } from '@weq/protocol';
import type { OidbNative } from '@weq/protocol';
import { PeerStatsService } from '../src/account/peer_stats';

describe('资料卡点赞与获赞读回', () => {
  it('使用当前 PID 和原 UID，不循环拆分或自动重发', async () => {
    const sendOidbPacket = vi.fn<OidbNative['sendOidbPacket']>(async () => Buffer.alloc(0));
    let pid = 101;
    const service = new PeerStatsService({ sendOidbPacket }, {} as AccountSession, () => pid);
    await expect(service.sendLike('u_fixture', 3)).resolves.toBe('accepted');
    pid = 102;
    await service.sendLike('u_fixture', 1);
    expect(sendOidbPacket.mock.calls.map((call) => call[0])).toEqual([101, 102]);
    expect(decode(SendProfileLike.reqSchema, sendOidbPacket.mock.calls[0]![3])).toMatchObject({
      targetUid: 'u_fixture',
      count: 3,
    });
  });
  it('业务拒绝和未知回执保持原状，不用累计获赞替代写结果', async () => {
    const sendOidbPacket = vi.fn(async () => Buffer.from([0x08, 0x01]));
    const service = new PeerStatsService({ sendOidbPacket }, {} as AccountSession, () => 101);
    await expect(service.sendLike('u_fixture', 1)).resolves.toBe('unconfirmed');
    sendOidbPacket.mockRejectedValueOnce(new Error('次数已达上限'));
    await expect(service.sendLike('u_fixture', 1)).rejects.toThrow('次数已达上限');
    expect(sendOidbPacket).toHaveBeenCalledTimes(2);
  });
  it('累计获赞只接受目标 UID 的响应，不把别人的统计挂到当前资料卡', async () => {
    const reply = (uid: string) =>
      Buffer.from(
        encode(GetProfileLike.respSchema, {
          userLikeInfos: [{ uid, voteInfo: { totalCount: 123 } }],
        }),
      );
    const sendOidbPacket = vi.fn(async () => reply('u_fixture'));
    const service = new PeerStatsService({ sendOidbPacket }, {} as AccountSession, () => 101);
    await expect(service.getLikeCount('u_fixture')).resolves.toBe(123);
    sendOidbPacket.mockResolvedValueOnce(reply('u_other'));
    await expect(service.getLikeCount('u_fixture')).rejects.toThrow('UID 不一致');
  });
});
