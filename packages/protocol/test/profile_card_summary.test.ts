import { describe, expect, it, vi } from 'vitest';
import {
  getProfileMedalWall,
  getProfileSimilarity,
  MEDAL_WALL_COMMAND,
  PROFILE_SUMMARY_COMMAND,
} from '../src/oidb/profile/card-summary';
import {
  jceField,
  jceFields,
  jceStruct,
  readJce,
  type JceValue,
} from '../src/oidb/profile/summary-jce';
import { encode, message } from '../src/protobuf';
import { walkProto } from '../src/msg/dump';

function reply(extra = Buffer.alloc(0), result = 0, target = 10002, version = 3) {
  const entries = new Map<JceValue, JceValue>([
    ['RespHead', jceStruct({ 1: result })],
    ['RespSummaryCard', Buffer.concat([Buffer.of(10), jceField(23, target), extra, Buffer.of(11)])],
  ]);
  if (version === 2)
    for (const [key, value] of entries)
      entries.set(key, new Map<JceValue, JceValue>([['type', value]]));
  return jceFields({ 1: version, 7: jceFields({ 0: entries }) });
}
function medals(values: Record<number, JceValue>) {
  // tag 80 / STRUCT_BEGIN comes from Android TMedalWallInfo's real readFrom chain.
  return Buffer.concat([Buffer.of(0xfa, 80), jceFields(values), Buffer.of(11)]);
}
function similarityFrame(
  header = Buffer.from('080118914e20924e28165000', 'hex'),
  body = Buffer.from('08001a0e12064142434445461a0461626364', 'hex'),
) {
  const frame = Buffer.alloc(10 + header.length + body.length);
  frame[0] = 0x28;
  frame.writeUInt32BE(header.length, 1);
  frame.writeUInt32BE(body.length, 5);
  frame.set(header, 9);
  frame.set(body, 9 + header.length);
  frame[frame.length - 1] = 0x29;
  return frame;
}
function nt(bytes: Uint8Array) {
  return { sendPacket: vi.fn(async () => Buffer.from(bytes)) };
}
function web(data: unknown, ret = 0) {
  return encode(
    message([
      { name: 'type', tag: 2, type: 'uint32', force: true },
      { name: 'ret', tag: 3, type: 'uint32', force: true },
      { name: 'data', tag: 4, type: 'string' },
    ]),
    { type: 0, ret, data: JSON.stringify(data) },
  );
}
describe('名片勋章与共同点', () => {
  it('JCE 固定字节正对照保留有符号整数与扩展 tag', () => {
    expect(jceFields({ 0: 0, 1: 127, 2: 128, 80: 2 }).toString('hex')).toBe('0c107f210080f05002');
    expect([...readJce(Buffer.from('0c107f210080f05002', 'hex'))]).toEqual([
      [0, 0],
      [1, 127],
      [2, 128],
      [80, 2],
    ]);
    for (const b of ['0a', 'f1', '0d01', '080002', '0c0c'])
      expect(() => readJce(Buffer.from(b, 'hex'))).toThrow();
  });
  it.each([2, 3])('勋章数零与缺失状态分开，JCE v%i 与真实嵌套结构均能读取', async (version) => {
    const binding = nt(reply(medals({ 0: 1, 1: 0, 2: 0, 3: 2 }), 0, 10002, version));
    expect(await getProfileMedalWall(binding, 7, '10001', '10002')).toMatchObject({
      targetUin: '10002',
      count: 0,
      openFlag: 1,
      newCount: 0,
      upgradeCount: 2,
    });
    expect(binding.sendPacket).toHaveBeenCalledOnce();
  });
  it('勋章仅请求自己的选择字段，不混入共同点业务', async () => {
    const binding = nt(reply(medals({ 1: 3 })));
    await getProfileMedalWall(binding, 7, '10001', '10002');
    const call = binding.sendPacket.mock.calls[0] as unknown as [number, string, Buffer];
    expect(call.slice(0, 2)).toEqual([7, PROFILE_SUMMARY_COMMAND]);
    const map = readJce(readJce(call[2]).get(7) as Buffer).get(0) as Map<JceValue, JceValue>;
    const fields = readJce(map.get('ReqSummaryCard') as Buffer).get(0) as Map<JceValue, JceValue>;
    expect(fields.get(18)).toBe(1);
    expect(fields.get(14)).toEqual([]);
    expect(await getProfileMedalWall(binding, 7, '10001', '10002')).toMatchObject({
      count: 3,
      openFlag: null,
      newCount: null,
    });
  });
  it('独立官方 H5 读取可补聚合 151，不接受默认零或猜测新获状态', async () => {
    const binding = {
      sendPacket: vi
        .fn()
        .mockResolvedValueOnce(reply(medals({ 1: 0 }), 151))
        .mockResolvedValueOnce(web({ ErrorCode: 0, user: { uin: 10002 }, achieved_count: '7' })),
    };
    expect(await getProfileMedalWall(binding, 7, '10001', '10002')).toMatchObject({
      count: 7,
      openFlag: null,
      newCount: null,
      upgradeCount: null,
    });
    const call = binding.sendPacket.mock.calls[1]!;
    expect(call[1]).toBe(MEDAL_WALL_COMMAND);
    const fields = walkProto(call[2]);
    expect(JSON.parse(fields.find((f) => f.tag === 3)!.value)).toBe(JSON.stringify({ uin: 10002 }));
  });
  it.each([
    { ErrorCode: 1, achieved_count: 7 },
    { ErrorCode: 0 },
    { ErrorCode: 0, achieved_count: -1 },
    { ErrorCode: 0, achieved_count: 'x' },
  ])('独立读取业务失败或缺少计数不伪造空墙 %j', async (data) => {
    const binding = {
      sendPacket: vi
        .fn()
        .mockResolvedValueOnce(reply(Buffer.alloc(0), 151))
        .mockResolvedValueOnce(web(data)),
    };
    await expect(getProfileMedalWall(binding, 7, '10001', '10002')).rejects.toThrow('151');
  });
  it('错目标直接拒绝，不用另一个接口掩盖错误', async () => {
    const binding = nt(reply(medals({ 1: 2 }), 0, 10003));
    await expect(getProfileMedalWall(binding, 7, '10001', '10002')).rejects.toThrow('目标');
    expect(binding.sendPacket).toHaveBeenCalledOnce();
    const fallback = {
      sendPacket: vi
        .fn()
        .mockResolvedValueOnce(reply(Buffer.alloc(0), 151))
        .mockResolvedValueOnce(web({ ErrorCode: 0, user: { uin: 10003 }, achieved_count: 4 })),
    };
    await expect(getProfileMedalWall(fallback, 7, '10001', '10002')).rejects.toThrow('目标');
  });
  it('按官方页面接受省略成功 ErrorCode 的有效零计数', async () => {
    const binding = {
      sendPacket: vi
        .fn()
        .mockResolvedValueOnce(reply(Buffer.alloc(0), 151))
        .mockResolvedValueOnce(web({ achieved_count: 0 })),
    };
    expect(await getProfileMedalWall(binding, 7, '10001', '10002')).toMatchObject({ count: 0 });
  });
  it('手写 protobuf 字节恢复共同点，不拿共同好友数量或 AI 文案代替', async () => {
    const binding = nt(reply(jceField(46, [similarityFrame()])));
    expect(await getProfileSimilarity(binding, 7, '10001', '10002')).toEqual({
      targetUin: '10002',
      items: [{ icon: null, title: 'ABCDEF', wordings: ['abcd'] }],
    });
    const call = binding.sendPacket.mock.calls[0] as unknown as [number, string, Buffer];
    const map = readJce(readJce(call[2]).get(7) as Buffer).get(0) as Map<JceValue, JceValue>;
    const fields = readJce(map.get('ReqSummaryCard') as Buffer).get(0) as Map<JceValue, JceValue>;
    expect(fields.get(18)).toBe(0);
    const frames = fields.get(14) as Buffer[];
    expect(frames).toHaveLength(1);
    expect(frames[0]?.[0]).toBe(0x28);
    expect(
      walkProto(frames[0]!.subarray(9, 9 + frames[0]!.readUInt32BE(1))).find((f) => f.tag === 5)
        ?.value,
    ).toBe('22');
  });
  it('成功空共同点与未返回／聚合拒绝／业务拒绝区分', async () => {
    expect(
      await getProfileSimilarity(
        nt(reply(jceField(46, [similarityFrame(undefined, Buffer.from('0800', 'hex'))]))),
        7,
        '10001',
        '10002',
      ),
    ).toEqual({ targetUin: '10002', items: [] });
    for (const bytes of [
      reply(),
      reply(Buffer.alloc(0), 151),
      reply(jceField(46, [])),
      reply(jceField(46, [similarityFrame(undefined, Buffer.from('0801', 'hex'))])),
      reply(jceField(46, [similarityFrame(Buffer.from('28165001', 'hex'))])),
    ])
      await expect(getProfileSimilarity(nt(bytes), 7, '10001', '10002')).rejects.toThrow();
  });
  it('共同点拒绝帧截断、重复业务与错身份', async () => {
    for (const frames of [
      [similarityFrame().subarray(0, -1)],
      [similarityFrame(), similarityFrame()],
      [similarityFrame(Buffer.from('20934e28165000', 'hex'))],
    ])
      await expect(
        getProfileSimilarity(nt(reply(jceField(46, frames))), 7, '10001', '10002'),
      ).rejects.toThrow();
    const binding = nt(reply());
    await expect(getProfileSimilarity(binding, 7, '10001', '10001')).rejects.toThrow('自己');
    expect(binding.sendPacket).not.toHaveBeenCalled();
  });
});
