import { describe, expect, it, vi } from 'vitest';
import { getProfileDetails, PROFILE_DETAIL_FIELDS } from '../src/oidb/profile/details';
import { encode, decode } from '../src/protobuf';
import { legacyOidbEnvelope } from '../src/oidb/legacy';
import { encodeQqRegion, formatQqRegion, QQ_REGIONS } from '../src/oidb/profile/editable-profile';

function body(rows: Array<[number, string | Buffer]>, uin = 10002) {
  const head = Buffer.alloc(7);
  head.writeUInt32BE(uin);
  head.writeUInt16BE(rows.length, 5);
  return Buffer.concat([
    head,
    ...rows.map(([key, value]) => {
      const bytes = typeof value === 'string' ? Buffer.from(value) : value;
      const header = Buffer.alloc(4);
      header.writeUInt16BE(key);
      header.writeUInt16BE(bytes.length, 2);
      return Buffer.concat([header, bytes]);
    }),
  ]);
}
function native(bytes: Uint8Array, result = 0, command = 0x480, serviceType = 9) {
  return {
    sendPacket: vi.fn(async (_pid: number, _command: string, _body: Uint8Array) =>
      Buffer.from(encode(legacyOidbEnvelope, { command, serviceType, result, body: bytes })),
    ),
  };
}
describe('公司、个人说明、邮箱读取', () => {
  it('请求文本与独立家乡地区字段，不请求签名或可见性开关', async () => {
    const nt = native(body([]));
    await getProfileDetails(nt, 7, '10002');
    const call = nt.sendPacket.mock.calls[0]!;
    expect(call[0]).toBe(7);
    expect(call[1]).toBe('OidbSvc.0x480_9_IMCore');
    const envelope = decode(legacyOidbEnvelope, call[2]);
    expect(envelope).toMatchObject({ command: 0x480, serviceType: 9 });
    expect(Buffer.from(envelope.body as Uint8Array).toString('hex')).toBe(
      '000027120000055dc84e334e2b5dc24e4b',
    );
  });
  it('三项独立读取，保留换行与非 ASCII 文本，不作邮箱格式改写', async () => {
    expect(
      await getProfileDetails(
        native(
          body([
            [PROFILE_DETAIL_FIELDS.company, '合成公司'],
            [PROFILE_DETAIL_FIELDS.personalDescription, '第一行\n第二行'],
            [PROFILE_DETAIL_FIELDS.email, 'synthetic@example.invalid'],
            [102, '不是个人说明的签名'],
          ]),
        ),
        7,
        '10002',
      ),
    ).toEqual({
      targetUin: '10002',
      company: '合成公司',
      personalDescription: '第一行\n第二行',
      email: 'synthetic@example.invalid',
      hometown: null,
      hometownText: null,
      errors: {},
    });
  });
  it('未返回与明确空值分开，不根据签名补个人说明', async () => {
    expect(
      await getProfileDetails(
        native(
          body([
            [PROFILE_DETAIL_FIELDS.company, ''],
            [102, '签名'],
          ]),
        ),
        7,
        '10002',
      ),
    ).toEqual({
      targetUin: '10002',
      company: '',
      personalDescription: null,
      email: null,
      hometown: null,
      hometownText: null,
      errors: {},
    });
  });
  it('单项非法 UTF-8 只报告该项，不丢弃其他字段', async () => {
    expect(
      await getProfileDetails(
        native(
          body([
            [PROFILE_DETAIL_FIELDS.company, Buffer.from([255])],
            [PROFILE_DETAIL_FIELDS.email, 'a@example.invalid'],
          ]),
        ),
        7,
        '10002',
      ),
    ).toMatchObject({
      company: null,
      email: 'a@example.invalid',
      errors: { company: '文本格式无法识别' },
    });
  });
  it('错目标、重复字段、截断或未知尾部拒绝，不能返回伪造空结果', async () => {
    const normal = body([[PROFILE_DETAIL_FIELDS.company, 'abc']]);
    for (const bytes of [
      body([], 10003),
      normal.subarray(0, -1),
      Buffer.concat([normal, Buffer.of(1)]),
      body([
        [PROFILE_DETAIL_FIELDS.email, 'a'],
        [PROFILE_DETAIL_FIELDS.email, 'b'],
      ]),
    ])
      await expect(getProfileDetails(native(bytes), 7, '10002')).rejects.toThrow();
  });
  it.each([
    [151, 0x480, 9],
    [0, 0x481, 9],
    [0, 0x480, 1],
  ])('业务拒绝及命令错配不视为空资料 %j', async (result, command, sub) => {
    await expect(
      getProfileDetails(native(body([]), result, command, sub), 7, '10002'),
    ).rejects.toThrow();
  });
  it('拒绝超出旧资料链路 uint32 容量的目标，不截断 QQ 号', async () => {
    const nt = native(body([]));
    for (const uin of ['0', '4294967296', '-1', 'abc'])
      await expect(getProfileDetails(nt, 7, uin)).rejects.toThrow();
    expect(nt.sendPacket).not.toHaveBeenCalled();
  });
  it('家乡与本人共用目录解码和格式，不能把数字代码或所在地当家乡', async () => {
    const bytes = encodeQqRegion(['1', '35', '2', '0'], 4);
    const result = await getProfileDetails(
      native(
        body([
          [PROFILE_DETAIL_FIELDS.hometown, bytes.subarray(0, 12)],
          [20043, bytes.subarray(12)],
          [20032, encodeQqRegion(['1', '11', '1'], 3)],
        ]),
      ),
      7,
      '10002',
    );
    expect(result.hometown).toEqual(['1', '35', '2', '0']);
    expect(result.hometownText).toBe(formatQqRegion(['1', '35', '2', '0'], QQ_REGIONS));
    expect(result.hometownText).toContain('福建');
    expect(result.hometownText).not.toContain('北京');
    const partial = await getProfileDetails(
      native(body([[PROFILE_DETAIL_FIELDS.hometown, bytes.subarray(0, 12)]])),
      7,
      '10002',
    );
    expect(partial.hometown).toEqual(['1', '35', '2']);
  });
  it('家乡损坏只标记该字段，未返回不填成所在地或未设置', async () => {
    const result = await getProfileDetails(
      native(
        body([
          [PROFILE_DETAIL_FIELDS.hometown, Buffer.of(1, 2)],
          [PROFILE_DETAIL_FIELDS.company, 'A'],
        ]),
      ),
      7,
      '10002',
    );
    expect(result).toMatchObject({
      hometown: null,
      company: 'A',
      errors: { hometown: '地区格式无法识别' },
    });
    expect((await getProfileDetails(native(body([])), 7, '10002')).hometown).toBeNull();
    expect(
      await getProfileDetails(native(body([[PROFILE_DETAIL_FIELDS.hometown, '']])), 7, '10002'),
    ).toMatchObject({ hometown: [], hometownText: '未设置', errors: {} });
  });
});
