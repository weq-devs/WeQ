import { describe, expect, it, vi } from 'vitest';
import { SetProfile, SetSelfLongNick } from '../src/oidb/profile/set-profile';
import { PROFILE_SIGNATURE, PROFILE_GENDER } from '../src/oidb/set-self-profile';
import { decode, encode } from '../src/protobuf';

describe('个人说明与签名字段隔离', () => {
  it('签名使用明确的 signature 参数并编码到签名字段', () => {
    const params = { selfUin: '10001', signature: 'sig' };
    const bytes = encode(SetProfile.reqSchema, SetProfile.serialize(params));
    expect(Buffer.from(bytes).toString('hex')).toBe('08914e120708661203736967');
    expect(decode(SetProfile.reqSchema, bytes)).toEqual({
      uin: 10001n,
      stringProfiles: [{ fieldId: PROFILE_SIGNATURE, value: 'sig' }],
    });
  });

  it.each(['说明文本', '', null])(
    '拒绝歧义 personalNote=%s，混合补丁也不发送',
    async (personalNote) => {
      const nt = { sendOidbPacket: vi.fn(async () => Buffer.alloc(0)) };
      const params = { selfUin: '10001', nickname: '合成昵称', personalNote };
      expect(() => SetProfile.serialize(params)).toThrow(/personalNote.*signature/);
      await expect(SetProfile.invoke(nt, 1, params)).rejects.toThrow(/personalNote.*signature/);
      expect(nt.sendOidbPacket).not.toHaveBeenCalled();
    },
  );

  it('只有旧 personalNote 参数时不能提前返回成功', async () => {
    const nt = { sendOidbPacket: vi.fn(async () => Buffer.alloc(0)) };
    await expect(
      SetProfile.invoke(nt, 1, { selfUin: '10001', ...{ personalNote: '说明文本' } }),
    ).rejects.toThrow(/personalNote/);
    expect(nt.sendOidbPacket).not.toHaveBeenCalled();
  });

  it('批量入口清空签名和性别零值保留 value 字段', () => {
    const params = { selfUin: '10001', signature: '', sex: 0 };
    expect(
      decode(SetProfile.reqSchema, encode(SetProfile.reqSchema, SetProfile.serialize(params))),
    ).toEqual({
      uin: 10001n,
      stringProfiles: [{ fieldId: PROFILE_SIGNATURE, value: '' }],
      intProfiles: [{ fieldId: PROFILE_GENDER, value: 0n }],
    });
  });

  it('独立签名入口清空时同样显式编码空字符串', () => {
    expect(
      decode(
        SetSelfLongNick.reqSchema,
        encode(
          SetSelfLongNick.reqSchema,
          SetSelfLongNick.serialize({ selfUin: '10001', longNick: '' }),
        ),
      ),
    ).toEqual({ uin: 10001n, profile: { tag: PROFILE_SIGNATURE, value: '' } });
  });

  it('空补丁保持不发包，昵称与性别更新保持可用', async () => {
    const nt = { sendOidbPacket: vi.fn(async () => Buffer.alloc(0)) };
    await SetProfile.invoke(nt, 1, { selfUin: '10001' });
    expect(nt.sendOidbPacket).not.toHaveBeenCalled();
    await SetProfile.invoke(nt, 1, { selfUin: '10001', nickname: '合成昵称', sex: 1 });
    expect(nt.sendOidbPacket).toHaveBeenCalledOnce();
  });
});
