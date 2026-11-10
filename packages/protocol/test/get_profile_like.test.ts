import { describe, expect, it, vi } from 'vitest';
import { GetProfileLike } from '../src/oidb/profile/get-profile-like';
import { encode } from '../src/protobuf';

describe('资料卡获赞空结果', () => {
  it('将实际采集的空对象回包按请求目标解析为零', async () => {
    const sendOidbPacket = vi.fn(async () => Buffer.from('0a00100a', 'hex'));
    await expect(
      GetProfileLike.invoke({ sendOidbPacket }, 101, { targetUid: 'u_fixture' }),
    ).resolves.toMatchObject({ uid: 'u_fixture', voteInfo: { totalCount: 0 } });
    expect(sendOidbPacket).toHaveBeenCalledTimes(1);
  });

  it('不将其他目标或缺 UID 的非空数据改写为请求目标', async () => {
    for (const data of [
      { uid: 'u_other', voteInfo: { totalCount: 123 } },
      { voteInfo: { totalCount: 123 } },
    ]) {
      const sendOidbPacket = vi.fn(async () =>
        Buffer.concat([
          Buffer.from(encode(GetProfileLike.respSchema, { userLikeInfos: [data] })),
          Buffer.from('100a', 'hex'),
        ]),
      );
      const result = await GetProfileLike.invoke({ sendOidbPacket }, 101, {
        targetUid: 'u_fixture',
      });
      expect(result.uid).not.toBe('u_fixture');
      expect(result.voteInfo.totalCount).toBe(123);
    }
  });

  it('没有采集到的附带字段或列表并非单个空对象时不套用零值规则', async () => {
    for (const hex of ['0a00', '0a00100b', '0a000a00100a']) {
      const sendOidbPacket = vi.fn(async () => Buffer.from(hex, 'hex'));
      const result = await GetProfileLike.invoke({ sendOidbPacket }, 101, {
        targetUid: 'u_fixture',
      });
      expect(result.uid).toBe('');
    }
  });

  it('空包和传输错误仍然失败', async () => {
    const sendOidbPacket = vi.fn(async () => Buffer.alloc(0));
    await expect(
      GetProfileLike.invoke({ sendOidbPacket }, 101, { targetUid: 'u_fixture' }),
    ).rejects.toThrow('empty');
    sendOidbPacket.mockRejectedValueOnce(new Error('查询超时'));
    await expect(
      GetProfileLike.invoke({ sendOidbPacket }, 101, { targetUid: 'u_fixture' }),
    ).rejects.toThrow('查询超时');
  });
});
