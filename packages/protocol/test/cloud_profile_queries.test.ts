import { describe, expect, it, vi } from 'vitest';
import { decode, encode, getCommonFriendCount, getCommonGroups, getCloudProfile, commonGroupsResponse, cloudProfileResponse } from '../src/index';
import { legacyOidbEnvelope } from '../src/oidb/legacy';

describe('云端精确资料与共同关系', () => {
  it('QQ 号资料使用 UIN 形式与签名，响应错号不能作为目标资料', async () => {
    const sendOidbPacket = vi.fn(async () => Buffer.from(encode(cloudProfileResponse, { body: { uin: 10002, properties: { bytes: [{ key: 20002, value: Buffer.from('合成昵称') }], numbers: [{ key: 105, value: 9 }] } } })));
    const nt = { sendOidbPacket, sendPacket: async () => Buffer.alloc(0) };
    expect((await getCloudProfile(nt, 1, '10002', [105, 20002])).numbers.get(105)).toBe(9);
    const call = sendOidbPacket.mock.calls[0] as unknown as unknown[];
    expect(call.slice(0, 3)).toEqual([1, 0xfe1, 2]); expect(call.slice(4)).toEqual([true, true]);
    await expect(getCloudProfile(nt, 1, '10003', [105])).rejects.toThrow('不匹配');
  });
  it.each([5, 0, -1])('共同好友 signed short %s，负数保持未知而不当成 65535 或 0', async (count) => {
    const body = Buffer.alloc(14); body.writeUInt32BE(10001); body.writeUInt16BE(1, 4); body.writeUInt32BE(10002, 6); body.writeInt16BE(count, 10);
    const sendPacket = vi.fn(async () => Buffer.from(encode(legacyOidbEnvelope, { command: 0x42d, serviceType: 4, result: 0, body })));
    expect(await getCommonFriendCount({ sendPacket, sendOidbPacket: async () => Buffer.alloc(0) }, 1, '10001', '10002')).toBe(count < 0 ? null : count);
    const call = sendPacket.mock.calls[0] as unknown as unknown[];
    expect(call[1]).toBe('OidbSvc.0x42d_4');
    expect(Buffer.from(decode(legacyOidbEnvelope, call[2] as Uint8Array).body as Uint8Array).toString('hex')).toBe('00002711000100002712');
  });
  it('共同群保留 uint64 标识，最近群不重复计数，完整旧 SSO 名称与版本不丢失', async () => {
    const body = encode(commonGroupsResponse, { from: 10001n, to: 10002n, info: { groups: [{ groupCode: 123n, groupUin: 9007199254740993n, name: '合成群' }], recent: { groupCode: 123n } } });
    const sendPacket = vi.fn(async () => Buffer.from(encode(legacyOidbEnvelope, { command: 0xcf4, serviceType: 0, result: 0, body })));
    expect(await getCommonGroups({ sendPacket, sendOidbPacket: async () => Buffer.alloc(0) }, 1, '10001', '10002', 'synthetic-version')).toEqual([{ groupCode: '123', groupUin: '9007199254740993', name: '合成群' }]);
    const call = sendPacket.mock.calls[0] as unknown as unknown[];
    expect(call[1]).toBe('OidbSvc.0xcf4');
    expect(decode(legacyOidbEnvelope, call[2] as Uint8Array).clientVersion).toBe('synthetic-version');
  });
});
