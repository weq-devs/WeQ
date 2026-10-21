import { describe, expect, it, vi } from 'vitest';
import {
  PROFILE_LIKE_MAX_PER_REQUEST,
  PROFILE_LIKE_SOURCE_ID,
  SendProfileLike,
} from '../src/oidb/interaction/profile-like';
import { decode } from '../src/protobuf';
import type { OidbNative } from '../src/transport';

describe('资料卡点赞', () => {
  it('只发送 UID 形态的 11/12/13 字段，次数上界与来源固定', async () => {
    const sendOidbPacket = vi.fn<OidbNative['sendOidbPacket']>(async () => Buffer.alloc(0));
    await expect(
      SendProfileLike.invoke({ sendOidbPacket }, 101, {
        targetUid: 'u_fixture',
        count: PROFILE_LIKE_MAX_PER_REQUEST,
      }),
    ).resolves.toBe('accepted');
    const call = sendOidbPacket.mock.calls[0]!;
    expect(call.slice(0, 3)).toEqual([101, 0x7e5, 104]);
    expect(call.slice(4)).toEqual([false, false]);
    expect(decode(SendProfileLike.reqSchema, call[3])).toEqual({
      targetUid: 'u_fixture',
      sourceId: PROFILE_LIKE_SOURCE_ID,
      count: PROFILE_LIKE_MAX_PER_REQUEST,
    });
    expect(call[3].toString('hex')).toBe('5a09755f6669787475726560476814');
  });
  it('非法 UID、零次、超界和非整数都在发包前拒绝，不静默截断', async () => {
    const sendOidbPacket = vi.fn(async () => Buffer.alloc(0));
    for (const count of [0, -1, 1.5, Number.NaN, PROFILE_LIKE_MAX_PER_REQUEST + 1])
      await expect(
        SendProfileLike.invoke({ sendOidbPacket }, 101, { targetUid: 'u_fixture', count }),
      ).rejects.toThrow('次数');
    await expect(
      SendProfileLike.invoke({ sendOidbPacket }, 101, { targetUid: '123456', count: 1 }),
    ).rejects.toThrow('UID');
    expect(sendOidbPacket).not.toHaveBeenCalled();
  });
  it('原生拒绝原样上抛，未建模的非空内层响应保持未知且只发一次', async () => {
    const sendOidbPacket = vi.fn(async () => Buffer.from([0x08, 0x01]));
    await expect(
      SendProfileLike.invoke({ sendOidbPacket }, 101, { targetUid: 'u_fixture', count: 1 }),
    ).resolves.toBe('unconfirmed');
    expect(sendOidbPacket).toHaveBeenCalledTimes(1);
    sendOidbPacket.mockRejectedValueOnce(new Error('今日次数限制'));
    await expect(
      SendProfileLike.invoke({ sendOidbPacket }, 101, { targetUid: 'u_fixture', count: 1 }),
    ).rejects.toThrow('今日次数限制');
    expect(sendOidbPacket).toHaveBeenCalledTimes(2);
  });
});
