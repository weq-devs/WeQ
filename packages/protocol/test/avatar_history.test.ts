import { describe, expect, it, vi } from 'vitest';
import {
  decode,
  message,
  getSelfAvatarHistory,
  historicalAvatarUrl,
  SELF_AVATAR_HISTORY_COMMAND,
} from '../src/index';

// 独立 wire：WebSSO 的 type@2、ret@3、JSON@4。
function web(data: unknown, ret = 0) {
  const bytes = Buffer.from(JSON.stringify(data));
  const length: number[] = [];
  let n = bytes.length;
  do {
    length.push((n & 127) | (n > 127 ? 128 : 0));
    n >>>= 7;
  } while (n);
  return Buffer.concat([Buffer.from([16, 0, 24, ret, 34, ...length]), bytes]);
}
const avatar = {
  str_fileid: 'synthetic-a',
  str_headurl: 'http://q1.qlogo.cn/g?b=qq&k=synthetic&s=',
  uint32_face_flag: 63,
  uint32_upload_time: 100,
  uint32_update_time: 200,
  uint32_file_size: 13008,
};
const page = (extra = {}) => ({
  ErrorCode: 0,
  uint32_is_end: 0,
  uint32_last_timestamp: 200,
  rpt_msg_his_heads: [avatar],
  ...extra,
});
const nt = (data: unknown, ret = 0) => ({ sendPacket: vi.fn(async () => web(data, ret)) });
describe('本人历史头像', () => {
  it('六字段映射及首页请求不带目标 UIN，24 条首页', async () => {
    const transport = nt(page());
    const value = await getSelfAvatarHistory(transport, 5);
    expect(value.items[0]).toMatchObject({
      id: avatar.str_fileid,
      faceFlag: 63,
      firstUsedAt: 100,
      lastUsedAt: 200,
      fileSize: 13008,
    });
    expect(value.items[0]?.url).toContain('&s=0');
    expect(value.items[0]?.thumbnailUrl).toContain('&s=100');
    const args = transport.sendPacket.mock.calls[0] as unknown as [number, string, Uint8Array];
    expect(args[1]).toBe(SELF_AVATAR_HISTORY_COMMAND);
    const wire = decode(message([{ name: 'data', tag: 3, type: 'string' }]), args[2]);
    expect(JSON.parse(wire.data as string)).toEqual({
      uint32_timestamp: expect.any(Number),
      uint32_num: 24,
    });
  });
  it('续页使用原始边界与30条，保留时间不同且不推算次数', async () => {
    const transport = nt(page());
    expect(await getSelfAvatarHistory(transport, 5, 300)).toMatchObject({
      nextCursor: 200,
      hasMore: true,
    });
    const args = transport.sendPacket.mock.calls[0] as unknown as [number, string, Uint8Array];
    const body = decode(message([{ name: 'data', tag: 3, type: 'string' }]), args[2]);
    expect(JSON.parse(body.data as string)).toEqual({ uint32_timestamp: 300, uint32_num: 30 });
  });
  it('去重资源而不是把重复条目当设置次数', async () => {
    const value = await getSelfAvatarHistory(
      nt(page({ rpt_msg_his_heads: [avatar, avatar] })),
      5,
      300,
    );
    expect(value.items).toHaveLength(1);
    expect(value.items[0]).not.toHaveProperty('useCount');
  });
  it.each([{ uint32_is_end: 1 }, { uint32_last_timestamp: 0 }])(
    '接受真实终点 %j',
    async (extra) => {
      expect(await getSelfAvatarHistory(nt(page(extra)), 5, 300)).toMatchObject({
        hasMore: false,
        nextCursor: null,
        paginationError: null,
      });
    },
  );
  it.each([300, 400, undefined])('停止无效游标 %s 并保留本页', async (cursor) => {
    expect(
      await getSelfAvatarHistory(nt(page({ uint32_last_timestamp: cursor })), 5, 300),
    ).toMatchObject({
      items: [expect.objectContaining({ id: avatar.str_fileid })],
      hasMore: false,
      paginationError: expect.any(String),
    });
  });
  it('时间和大小缺失保留未知', async () => {
    const value = await getSelfAvatarHistory(
      nt(page({ rpt_msg_his_heads: [{ str_fileid: 'a', str_headurl: avatar.str_headurl }] })),
      5,
      300,
    );
    expect(value.items[0]).toMatchObject({
      firstUsedAt: null,
      lastUsedAt: null,
      fileSize: null,
      faceFlag: null,
    });
  });
  it.each([{ ErrorCode: 316 }, { uint32_is_end: undefined }, { rpt_msg_his_heads: undefined }])(
    '不把错误或不完整响应当空列表 %j',
    async (extra) => {
      await expect(getSelfAvatarHistory(nt(page(extra)), 5)).rejects.toThrow();
    },
  );
  it('拒绝外层业务错误、无效时间或图片地址', async () => {
    await expect(getSelfAvatarHistory(nt(page(), 1), 5)).rejects.toThrow();
    await expect(
      getSelfAvatarHistory(
        nt(page({ rpt_msg_his_heads: [{ ...avatar, uint32_upload_time: -1 }] })),
        5,
      ),
    ).rejects.toThrow();
    expect(() => historicalAvatarUrl('https://example.com/image/', 63)).toThrow();
    await expect(getSelfAvatarHistory(nt(page()), 5, -1)).rejects.toThrow();
  });
  it('规格位优先级及旧图小尺寸回退', () => {
    expect(historicalAvatarUrl(avatar.str_headurl, 31)).toContain('&s=640');
    expect(historicalAvatarUrl(avatar.str_headurl, 2)).toContain('&s=40');
    expect(historicalAvatarUrl(avatar.str_headurl, 32, true)).toContain('&s=0');
  });
});
