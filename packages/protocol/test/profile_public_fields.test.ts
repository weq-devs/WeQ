import { expect, it, vi } from 'vitest';
import { formatQqRegion } from '../src/profile-regions';
import { QQ_REGIONS } from '../src/oidb/profile/editable-profile';
import { getProfileDetails, getProfileRegion } from '../src/oidb/profile/details';
import { encode } from '../src/protobuf';
import { cloudProfileResponse } from '../src/oidb/profile/cloud-profile';
import { legacyOidbEnvelope } from '../src/oidb/legacy';

it('未选择地区不显示不限占位，省级为零仍继续解析其下城市', () => {
  expect(formatQqRegion(['0', '0', '0', '0'], QQ_REGIONS)).toBeNull();
  expect(formatQqRegion([], QQ_REGIONS)).toBeNull();
  expect(formatQqRegion(['1', '35', '0', '0'], QQ_REGIONS)).toBe('中国 · 福建');
  const text = formatQqRegion(['DEU', '0', 'SWH', '0'], QQ_REGIONS);
  expect(text).not.toContain('不限');
  expect(text?.split(' · ')).toHaveLength(2);
  expect(formatQqRegion(['DEU', '', 'SWH', ''], QQ_REGIONS)).toBe(text);
});

it('空本地资料所需的学校与职业从旧资料内容字段补齐，不拿数值学校 ID 当名称', async () => {
  // Independent TLV fixture: uint32 target, byte zero, count, text field and big-endian profession.
  const body = Buffer.from('000027120000024e3500065363686f6f6c699d000400000001', 'hex');
  const nt = {
    sendPacket: vi.fn(async () =>
      Buffer.from(encode(legacyOidbEnvelope, { command: 0x480, serviceType: 9, result: 0, body })),
    ),
  };
  expect(await getProfileDetails(nt, 7, '10002')).toMatchObject({
    school: 'School',
    profession: 1,
  });
});

it('所在地使用在线 20032 的三层地区，校验目标，不与家乡混用', async () => {
  const response = (uin = 10002, bytes = Buffer.from('000000310000353100000031', 'hex')) =>
    Buffer.from(
      encode(cloudProfileResponse, {
        body: { uin, properties: { bytes: [{ key: 20032, value: bytes }] } },
      }),
    );
  const nt = { sendOidbPacket: vi.fn(async () => response()) };
  expect(await getProfileRegion(nt, 7, '10002')).toMatchObject({
    targetUin: '10002',
    region: ['1', '51', '1'],
    regionText: '中国 · 四川 · 成都',
  });
  expect(nt.sendOidbPacket.mock.calls[0]?.slice(0, 3)).toEqual([7, 0xfe1, 2]);
  await expect(
    getProfileRegion({ sendOidbPacket: async () => response(10003) }, 7, '10002'),
  ).rejects.toThrow('匹配');
  await expect(
    getProfileRegion({ sendOidbPacket: async () => response(10002, Buffer.of(1, 2)) }, 7, '10002'),
  ).rejects.toThrow('地区');
});
