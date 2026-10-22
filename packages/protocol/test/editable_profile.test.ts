import { describe, expect, it } from 'vitest';
import { packQqBirthday, packQqRegionCode, encodeQqRegion, encodeEditableProfile, parseLegacyProfileBody, readEditableProfile, encode, cloudProfileResponse } from '../src/index';
import { legacyOidbEnvelope } from '../src/oidb/legacy';

describe('已确认的本人资料字段编码', () => {
  it('现代读取失败不拖累旧文本资料，错误按字段返回', async () => {
    const legacy = Buffer.from('000027110000024e2b00004e35000141', 'hex');
    const result = await readEditableProfile({ sendOidbPacket: async () => { throw new Error('暂不可读'); }, sendPacket: async () => Buffer.from(encode(legacyOidbEnvelope, { command: 0x480, serviceType: 9, result: 0, body: legacy })) }, 1, '10001');
    expect(result).toMatchObject({ birthday: null, email: '', school: 'A', errors: { birthday: '生日读取失败', region: '当前地区读取失败' } });
    expect(result.errors.email).toBeUndefined();
  });
  it('旧链失败不阻断生日，现代 UID 回显错号直接拒绝', async () => {
    const nt = { sendOidbPacket: async () => Buffer.from(encode(cloudProfileResponse, { body: { uid: 'u_self', uin: 10001, properties: { bytes: [{ key: 20031, value: Buffer.from('07d0021d', 'hex') }] } } })), sendPacket: async () => { throw new Error('旧链不可读'); } };
    expect(await readEditableProfile(nt, 1, '10001', 'u_self')).toMatchObject({ birthday: '2000-02-29', errors: { email: '该项资料读取失败' } });
    await expect(readEditableProfile(nt, 1, '10001', 'u_other')).rejects.toThrow('UID');
  });
  it('生日使用公历打包而非时间戳，正确校验世纪闰年', () => {
    expect(packQqBirthday('2000-02-29')).toBe(0x07d0021d);
    for (const date of ['1900-02-29', '2026-04-31', '0000-01-01', '2026-1-01', '']) expect(() => packQqBirthday(date)).toThrow();
  });
  it('官方地区码按 ASCII 大端打包，不作十进制行政代码', () => {
    expect(packQqRegionCode('35')).toBe(0x3335);
    expect(encodeQqRegion(['1', '35', '2'], 3).toString('hex')).toBe('000000310000333500000032');
    expect(() => encodeQqRegion(['USA', '35', '2'], 3)).toThrow();
    expect(() => encodeQqRegion(['1', '35', '2', 'unknown'], 4)).toThrow();
  });
  it('学校与邮箱可显式清空，职业不接受新版任意编号', () => {
    expect([...encodeEditableProfile({ school: '' }).legacy]).toEqual([[20021, Buffer.alloc(0)]]);
    expect([...encodeEditableProfile({ email: '' }).legacy]).toEqual([[20011, Buffer.alloc(0)]]);
    expect(() => encodeEditableProfile({ profession: 15 })).toThrow();
    expect(() => encodeEditableProfile({ email: 'a', school: 'b' })).toThrow();
  });
  it('解析旧资料 TLV 时校验身份、重复键、截断与未建模尾部', () => {
    const body = Buffer.from('000027110000024e2b00004e35000141', 'hex');
    expect([...parseLegacyProfileBody(body, '10001')]).toEqual([[20011, Buffer.alloc(0)], [20021, Buffer.from('A')]]);
    expect(() => parseLegacyProfileBody(body, '10002')).toThrow();
    expect(() => parseLegacyProfileBody(body.subarray(0, -1), '10001')).toThrow();
    expect(() => parseLegacyProfileBody(Buffer.concat([body, Buffer.of(1)]), '10001')).toThrow();
  });
});
