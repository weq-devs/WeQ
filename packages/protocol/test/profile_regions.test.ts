import { describe, expect, it } from 'vitest';
import {
  QQ_REGIONS,
  encodeQqRegion,
  encodeEditableProfile,
  packQqRegionCode,
  readEditableProfile,
  encode,
  cloudProfileResponse,
} from '../src';
import { legacyOidbEnvelope } from '../src/oidb/legacy';
import regionRows from '../src/oidb/profile/qq-regions.json';

async function readRegions(region?: string, hometown?: string, district?: string) {
  const fields: Buffer[] = [];
  for (const [key, hex] of [
    [24002, hometown],
    [20043, district],
  ] as const) {
    if (hex === undefined) continue;
    const bytes = Buffer.from(hex, 'hex');
    const header = Buffer.alloc(4);
    header.writeUInt16BE(key);
    header.writeUInt16BE(bytes.length, 2);
    fields.push(Buffer.concat([header, bytes]));
  }
  const header = Buffer.from('00002711000000', 'hex');
  header.writeUInt16BE(fields.length, 5);
  return readEditableProfile(
    {
      sendOidbPacket: async () =>
        Buffer.from(
          encode(cloudProfileResponse, {
            body: {
              uin: 10001,
              properties: {
                bytes:
                  region === undefined ? [] : [{ key: 20032, value: Buffer.from(region, 'hex') }],
              },
            },
          }),
        ),
      sendPacket: async () =>
        Buffer.from(
          encode(legacyOidbEnvelope, {
            command: 0x480,
            serviceType: 9,
            result: 0,
            body: Buffer.concat([header, ...fields]),
          }),
        ),
    },
    1,
    '10001',
  );
}

describe('地区不限层级', () => {
  it('安卓 CODE_NO_LIMIT 编为整数零，而不是字符零', () => {
    expect(packQqRegionCode('0')).toBe(0);
    expect(packQqRegionCode('')).toBe(0);
    expect(packQqRegionCode('35')).toBe(0x3335);
  });

  it.each([
    [['0', '0', '0'], '000000000000000000000000'],
    [['1', '0', '0'], '000000310000000000000000'],
    [['1', '35', '0'], '000000310000333500000000'],
  ] as const)('所在地 %j 保留已选择的上级', (path, hex) => {
    expect(encodeQqRegion([...path], 3).toString('hex')).toBe(hex);
  });

  it('家乡在任一级不限，区县明确发送零值', () => {
    const result = encodeEditableProfile({ hometown: ['1', '35', '0', '0'] });
    expect(Buffer.from(result.legacy.get(24002)!).toString('hex')).toBe('000000310000333500000000');
    expect(Buffer.from(result.legacy.get(20043)!).toString('hex')).toBe('00000000');
    expect(encodeQqRegion(['0', '0', '0', '0'], 4)).toEqual(Buffer.alloc(16));
  });

  it('没有省级的官方目录仍允许选择城市，兼容旧空代码', () => {
    expect(encodeQqRegion(['DEU', '0', 'SWH', '0'], 4).toString('hex')).toBe(
      '00444555000000000053574800000000',
    );
    expect(encodeQqRegion(['DEU', '', 'SWH', ''], 4)).toEqual(
      encodeQqRegion(['DEU', '0', 'SWH', '0'], 4),
    );
  });

  it('目录每层有不限，不能在不匹配的上级下选具体地区', () => {
    expect(QQ_REGIONS[0]).toMatchObject({ code: '0', name: '不限' });
    expect(() => encodeQqRegion(['1', '0', '2'], 3)).toThrow();
    expect(() => encodeQqRegion(['0', '35', '2'], 3)).toThrow();
    expect(() => encodeQqRegion(['1', '35'], 3)).toThrow();
    expect(() => encodeQqRegion(['unknown', '0', '0'], 3)).toThrow();
  });

  it('原目录所有地区路径仍可编码，空层级与虚拟区县零值不冲突', () => {
    for (const row of regionRows) {
      const path = [row[0]!, row[2]!, row[4]!, row[6]!];
      const expected = Buffer.alloc(16);
      path.forEach((code, index) => {
        const hex = Buffer.from(code, 'ascii').toString('hex');
        expected.writeUInt32BE(!code || code === '0' ? 0 : Number.parseInt(hex, 16), index * 4);
      });
      expect(encodeQqRegion(path, 4)).toEqual(expected);
      expect(encodeQqRegion(path.slice(0, 3), 3)).toEqual(expected.subarray(0, 12));
    }
  });

  it('读回区分明确不限和没有返回数据，不因零值变为 null', async () => {
    expect(
      await readRegions('000000310000333500000000', '000000310000000000000000', '00000000'),
    ).toMatchObject({
      region: ['1', '35', '0'],
      hometown: ['1', '0', '0', '0'],
    });
    expect(await readRegions('000000000000000000000000')).toMatchObject({
      region: ['0', '0', '0'],
      hometown: null,
    });
    expect(await readRegions()).toMatchObject({ region: null, hometown: null });
    expect(await readRegions('000000310000000000000032')).toMatchObject({ region: null });
  });
});
