import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setSelfAvatar,
  setGroupAvatar,
  SELF_AVATAR_HIGHWAY_CMD,
  GROUP_AVATAR_HIGHWAY_CMD,
  AVATAR_MAX_BYTES,
  encodeGroupAvatarExtra,
} from '../src/oidb/set-group-avatar';
import { makeSolidPng } from '../src/highway/image-format';
import { fetchHighwaySession, uploadHighwayHttp } from '../src/highway/highway-client';

vi.mock('../src/highway/highway-client', async (original) => ({
  ...(await original<typeof import('../src/highway/highway-client')>()),
  fetchHighwaySession: vi.fn(async () => ({
    sigSession: new Uint8Array(),
    sessionKey: new Uint8Array(),
  })),
  uploadHighwayHttp: vi.fn(async () => undefined),
}));

beforeEach(() => vi.clearAllMocks());

describe('个人与群头像上传', () => {
  const nt = { sendPacket: async () => Buffer.alloc(0) };
  it('群号超出 uint32 时在编码与上传前拒绝，不能截断为另一群', async () => {
    const groupId = 2 ** 32 + 123;
    expect(() => encodeGroupAvatarExtra(groupId)).toThrow(/groupId/);
    await expect(
      setGroupAvatar(nt, 5, { groupId, uin: '10001', source: makeSolidPng(2, 2) }),
    ).rejects.toThrow(/groupId/);
    expect(fetchHighwaySession).not.toHaveBeenCalled();
    expect(uploadHighwayHttp).not.toHaveBeenCalled();
  });
  it('复用上传管线但保持不同命令号及群扩展', async () => {
    const source = makeSolidPng(2, 2);
    await setSelfAvatar(nt, 5, { uin: '10001', source });
    await setGroupAvatar(nt, 5, { groupId: 123, uin: '10001', source });
    const calls = vi.mocked(uploadHighwayHttp).mock.calls;
    expect(calls[0]?.[0]).toMatchObject({
      commandId: SELF_AVATAR_HIGHWAY_CMD,
      uin: '10001',
      extend: new Uint8Array(),
    });
    expect(calls[1]?.[0].commandId).toBe(GROUP_AVATAR_HIGHWAY_CMD);
    expect(calls[1]?.[0].extend?.length).toBeGreaterThan(0);
  });
  it('空内容、非图片和过大的内容在申请上传前拒绝', async () => {
    for (const source of [
      new Uint8Array(),
      Buffer.from('not-image'),
      new Uint8Array(AVATAR_MAX_BYTES + 1),
    ])
      await expect(setSelfAvatar(nt, 5, { uin: '10001', source })).rejects.toThrow();
    expect(fetchHighwaySession).not.toHaveBeenCalled();
    expect(uploadHighwayHttp).not.toHaveBeenCalled();
  });
});
