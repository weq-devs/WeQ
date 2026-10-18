import { describe, expect, it, vi } from 'vitest';
import { ReportRead } from '../src/index';
import { encode } from '../src/protobuf';

describe('已读上报协议', () => {
  it('群聊与私聊黄金字段向量互斥，私聊带原消息时间', () => {
    expect(
      Buffer.from(
        encode(
          ReportRead.reqSchema,
          ReportRead.serialize({ kind: 'group', groupUin: 100, sequence: 5 }),
        ),
      ).toString('hex'),
    ).toBe('0a0408641005');
    expect(
      Buffer.from(
        encode(
          ReportRead.reqSchema,
          ReportRead.serialize({ kind: 'c2c', targetUid: 'u_x', sequence: 7, timestamp: 123 }),
        ),
      ).toString('hex'),
    ).toBe('12091203755f78187b2007');
  });

  it('使用 raw SSO 和 PC 白名单要求的签名，空应答不等于其他端已读', async () => {
    const sendPacket = vi.fn(async () => Buffer.alloc(0));
    const target = { kind: 'group' as const, groupUin: 100, sequence: 5 };
    expect(await ReportRead.invoke({ sendPacket }, 9, target)).toBe('acknowledged');
    expect(sendPacket).toHaveBeenCalledWith(9, ReportRead.cmd, expect.any(Buffer), true);
    sendPacket.mockResolvedValueOnce(Buffer.from([8, 1]));
    expect(await ReportRead.invoke({ sendPacket }, 9, target)).toBe('unconfirmed');
  });

  it('非法序号、UID 与时间在发包前拒绝，传输拒绝原样抛出', async () => {
    for (const sequence of [0, -1, 1.5, 0x100000000, Number.NaN])
      expect(() => ReportRead.serialize({ kind: 'group', groupUin: 100, sequence })).toThrow();
    expect(() => ReportRead.serialize({ kind: 'group', groupUin: 0, sequence: 1 })).toThrow();
    expect(() =>
      ReportRead.serialize({ kind: 'c2c', targetUid: '123', sequence: 1, timestamp: 123 }),
    ).toThrow();
    expect(() =>
      ReportRead.serialize({ kind: 'c2c', targetUid: 'u_x', sequence: 1, timestamp: 0 }),
    ).toThrow();
    const sendPacket = vi.fn(async (): Promise<Buffer> => {
      throw new Error('SSO 拒绝');
    });
    await expect(
      ReportRead.invoke({ sendPacket }, 9, { kind: 'group', groupUin: 100, sequence: 1 }),
    ).rejects.toThrow('SSO 拒绝');
  });
});
