import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import { decode, encode, GetProfileLike, SendProfileLike } from '@weq/protocol';
import type { OidbNative } from '@weq/protocol';
import { PeerStatsService } from '../src/account/peer_stats';
import { ContactMetricsService } from '../src/account/contact_metrics';

function profileSession(
  profile: { isBot?: boolean; uin?: bigint; extInfo?: { isEnterprise?: boolean } } | null = null,
) {
  return {
    profileInfo: { getProfile: vi.fn(async (_uid: string) => profile) },
  } as unknown as AccountSession;
}

describe('资料卡点赞与获赞读回', () => {
  it.each([{ isBot: true }, { isBot: false, extInfo: { isEnterprise: true } }])(
    '机器人与企业用户不发起获赞请求：%j',
    async (profile) => {
      const sendOidbPacket = vi.fn(async () => Buffer.alloc(0));
      const resolvePid = vi.fn(() => {
        throw new Error('不应检查在线进程');
      });
      const session = profileSession(profile);
      const service = new PeerStatsService({ sendOidbPacket }, session, resolvePid);
      await expect(service.getLikeCount('u_excluded')).resolves.toBeNull();
      expect(session.profileInfo.getProfile).toHaveBeenCalledWith('u_excluded');
      expect(sendOidbPacket).not.toHaveBeenCalled();
      expect(resolvePid).not.toHaveBeenCalled();
    },
  );
  it('企业用户获赞不适用，删除 UID 和 QQ 号下的旧缓存而不写入零', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weq-profile-like-excluded-'));
    const cache = new ContactMetricsService(join(root, 'metrics.json'), () => true);
    try {
      await cache.record('friend:u_excluded', { likeCount: 0 });
      await cache.record('friend:12345', { likeCount: 88, level: 3 });
      const sendOidbPacket = vi.fn(async () => Buffer.alloc(0));
      const service = new PeerStatsService(
        { sendOidbPacket },
        profileSession({ uin: 12345n, extInfo: { isEnterprise: true } }),
        () => 101,
      );
      service.contactMetrics = cache;
      const query = vi.spyOn(cache, 'query');
      await expect(service.getLikeCount('u_excluded')).resolves.toBeNull();
      expect((await cache.row('friend:u_excluded')).likeCount).toBeUndefined();
      expect((await cache.row('friend:12345')).likeCount).toBeUndefined();
      expect((await cache.row('friend:12345')).level?.value).toBe(3);
      expect(sendOidbPacket).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    } finally {
      await cache.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('实际空结果回包的累计获赞返回零，不报 UID 不一致', async () => {
    const sendOidbPacket = vi.fn(async () => Buffer.from('0a00100a', 'hex'));
    const service = new PeerStatsService({ sendOidbPacket }, profileSession(), () => 101);
    await expect(service.getLikeCount('u_fixture')).resolves.toBe(0);
  });
  it('空结果将原失败缓存更新为就绪零值，更新任务正常完成', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weq-profile-like-test-'));
    const cache = new ContactMetricsService(join(root, 'metrics.json'), () => true, {
      interval: 0,
      concurrency: 1,
    });
    try {
      const sendOidbPacket = vi.fn(async () => Buffer.from('0a00100a', 'hex'));
      const service = new PeerStatsService({ sendOidbPacket }, profileSession(), () => 101);
      service.contactMetrics = cache;
      await cache.failed('friend:u_fixture', 'likeCount', new Error('旧失败'));
      cache.start([{ key: 'friend:u_fixture', run: () => service.getLikeCount('u_fixture') }]);
      await vi.waitFor(() => expect(cache.progress.status).toBe('completed'));
      expect(cache.progress.failed).toBe(0);
      const cell = (await cache.row('friend:u_fixture')).likeCount;
      expect(cell).toMatchObject({ value: 0, state: 'ready' });
      expect(cell?.error).toBeUndefined();
      expect(cell?.updatedAt).toBeGreaterThan(0);
    } finally {
      await cache.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
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
    const service = new PeerStatsService({ sendOidbPacket }, profileSession(), () => 101);
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
    const service = new PeerStatsService({ sendOidbPacket }, profileSession(), () => 101);
    await expect(service.getLikeCount('u_fixture')).resolves.toBe(123);
    sendOidbPacket.mockResolvedValueOnce(reply('u_other'));
    await expect(service.getLikeCount('u_fixture')).rejects.toThrow('UID 不一致');
  });
});
