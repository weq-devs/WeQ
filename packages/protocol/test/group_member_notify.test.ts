import { describe, expect, it, vi } from 'vitest';
import {
  decodeGroupMemberNotify,
  encodeGroupMemberNotify,
  getGroupMemberNotify,
  setGroupMemberNotify,
} from '../src/group-member-notify';
import { invokeLegacyOidb } from '../src/oidb/legacy';
import type { TrpcNative } from '../src/transport';

const target = { groupId: 123, memberUin: '456' };
// 独立手工 wire 夹具：群号 123、成员 456、result=0，状态字段为 tag 30。
const response = (tail: string) =>
  Buffer.from(
    `087b1a${(5 + tail.length / 2).toString(16).padStart(2, '0')}08c8031000${tail}`,
    'hex',
  );
describe('群内成员消息提醒', () => {
  it.each([
    ['default', 9, '0a070a05087b30c803'],
    ['concerned', 2, '0a090a07087b1a0308c803'],
    ['shielded', 7, '0a090a07087b2a0308c803'],
  ] as const)('仅写本次目标字段：%s', async (mode, sub, hex) => {
    expect(Buffer.from(encodeGroupMemberNotify({ ...target, mode })).toString('hex')).toBe(hex);
    const ack = Buffer.from([8, 0xbb, 0x11, 0x10, sub, 0x18, 0]);
    const sendPacket = vi.fn<TrpcNative['sendPacket']>(async () => ack);
    await setGroupMemberNotify({ sendPacket }, 10, { ...target, mode });
    expect(sendPacket.mock.calls[0]?.[1]).toBe(`OidbSvc.0x8bb_${sub}`);
    expect(sendPacket).toHaveBeenCalledTimes(1);
  });
  it.each([
    [0, 'default'],
    [1, 'concerned'],
    [2, 'shielded'],
  ] as const)('读取明确三态 %s', (raw, mode) => {
    expect(decodeGroupMemberNotify(response(`f0010${raw}`), target)).toEqual({
      ...target,
      mode,
      rawMode: raw,
      complete: true,
    });
  });
  it.each(['', '3000', '3001', 'f00163'])('缺字段、旧 bool 或未知值不推断默认：%s', (tail) => {
    expect(decodeGroupMemberNotify(response(tail), target)).toMatchObject({
      mode: null,
      complete: false,
    });
  });
  it('拒绝错目标、缺结果、非零结果与截断', () => {
    for (const p of [
      { ...target, groupId: 124 },
      { ...target, memberUin: '457' },
    ])
      expect(() => decodeGroupMemberNotify(response('f00100'), p)).toThrow('目标');
    for (const hex of ['087b1a0308c803', '087b1a0508c8031001', '087b1a0808c8031000f001'])
      expect(() => decodeGroupMemberNotify(Buffer.from(hex, 'hex'), target)).toThrow();
  });
  it('读取使用成员详情而不是 OIDB 新版命令', async () => {
    const sendPacket = vi.fn<TrpcNative['sendPacket']>(async () => response('f00100'));
    await getGroupMemberNotify({ sendPacket }, 10, target);
    expect(sendPacket.mock.calls[0]?.[1]).toBe('group_member_card.get_group_member_card_info');
    expect(Buffer.from(sendPacket.mock.calls[0]![2]).toString('hex')).toBe(
      '087b10c803180120012801',
    );
  });
  it('可选空 ACK 不改变旧 helper 默认行为，且不能吞掉缺 result 或业务失败', async () => {
    const call = (hex: string, allowEmptyBody = false) =>
      invokeLegacyOidb(
        { sendPacket: async () => Buffer.from(hex, 'hex') },
        1,
        0x8bb,
        9,
        'OidbSvc.0x8bb_9',
        new Uint8Array(),
        { strict: true, allowEmptyBody },
      );
    await expect(call('08bb1110091800')).rejects.toThrow('业务体');
    await expect(call('08bb1110091800', true)).resolves.toHaveLength(0);
    for (const hex of [
      '08bb111009',
      '08bb1110091841',
      '08bb1110091842',
      '08bb1110021800',
      '08bb11100918002205',
    ])
      await expect(call(hex, true)).rejects.toThrow();
  });
});
