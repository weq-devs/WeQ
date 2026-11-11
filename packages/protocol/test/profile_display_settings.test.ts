import { describe, expect, it, vi } from 'vitest';
import {
  getSelfProfileDisplaySettings,
  setSelfProfileDisplaySetting,
  profileDisplayRaw,
} from '../src/oidb/profile/display-settings';

// 从 Android FieldMap 独立编 wire，不用生产 schema 验证自身。
function v(input: number | bigint) {
  let rest = BigInt(input);
  const bytes: number[] = [];
  do {
    bytes.push(Number(rest & 127n) | (rest > 127n ? 128 : 0));
    rest >>= 7n;
  } while (rest);
  return Buffer.from(bytes);
}
const pb = (...fields: Uint8Array[]) => Buffer.concat(fields);
const n = (tag: number, value: number | bigint) => pb(v(tag * 8), v(value));
const b = (tag: number, value: Uint8Array) => pb(v(tag * 8 + 2), v(value.length), value);
const envelope = (body: Uint8Array, cmd = 0x5eb, sub = 22, result = 0) =>
  pb(n(1, cmd), n(2, sub), n(3, result), b(4, body));
const native = (reply: Uint8Array) => ({ sendPacket: vi.fn(async () => Buffer.from(reply)) });
const row = (...fields: Uint8Array[]) => b(11, pb(n(1, 10002), ...fields));

describe('资料展示协议', () => {
  it('查询 selector 是请求标记一，返回显式零不丢失', async () => {
    const nt = native(envelope(row(n(41611, 0), n(41610, 2))));
    const result = await getSelfProfileDisplaySettings(nt, 7, '10002', ['gender', 'age']);
    expect(result.settings).toEqual([
      { field: 'gender', raw: 0, value: 0, status: 'known' },
      { field: 'age', raw: 2, value: 2, status: 'known' },
    ]);
    expect(nt.sendPacket).toHaveBeenCalledWith(
      7,
      'OidbSvc.0x5eb_22',
      pb(n(1, 0x5eb), n(2, 22), b(4, pb(n(1, 10002), n(41611, 1), n(41610, 1)))),
      expect.anything(),
      expect.anything(),
    );
  });
  it('缺字段、未知值和未完成响应不伪造为公开', async () => {
    const nt = native(envelope(row(n(41611, 99))));
    expect(
      (await getSelfProfileDisplaySettings(nt, 7, '10002', ['gender', 'age'])).settings,
    ).toEqual([
      { field: 'gender', raw: 99, value: null, status: 'unknown' },
      { field: 'age', raw: null, value: null, status: 'missing' },
    ]);
    const partial = native(envelope(pb(row(n(41611, 0)), n(12, 10002))));
    expect(
      (await getSelfProfileDisplaySettings(partial, 7, '10002', ['gender'])).settings[0],
    ).toEqual({ field: 'gender', raw: 0, value: null, status: 'incomplete' });
  });
  it.each([
    envelope(b(11, n(1, 10003))),
    envelope(pb(row(), row())),
    envelope(Buffer.alloc(0)),
    envelope(row(), 0x5eb, 22, 151),
    envelope(row(), 0x587),
    envelope(row(), 0x5eb, 23),
    envelope(Buffer.from([0x5a, 8, 8])),
  ])('拒绝错目标、重复目标、缺目标、业务错误、命令错配和截断', async (reply) => {
    await expect(getSelfProfileDisplaySettings(native(reply), 7, '10002')).rejects.toThrow();
  });
  it('保存只带一项且明确编码零', async () => {
    const nt = native(envelope(Buffer.alloc(0), 0x587, 74));
    await setSelfProfileDisplaySetting(nt, 7, '10002', 'gender', 0);
    expect(nt.sendPacket).toHaveBeenCalledWith(
      7,
      'OidbSvc.0x587_74',
      pb(n(1, 0x587), n(2, 74), b(4, pb(n(1, 10002), n(41611, 0)))),
      expect.anything(),
      expect.anything(),
    );
  });
  it('Q 崽和农场按独立枚举转换，不套用通用 bool', () => {
    expect(profileDisplayRaw('qqCub', 0)).toBe(1);
    expect(profileDisplayRaw('qqCub', 1)).toBe(2);
    expect(profileDisplayRaw('metaFarm', 0)).toBe(2);
    expect(profileDisplayRaw('metaFarm', 1)).toBe(1);
    expect(() => profileDisplayRaw('personalityLabels', 2)).toThrow();
  });
  it('非法选项不发包，uint64 账号不丢精度', async () => {
    const nt = native(envelope(b(11, n(1, 9007199254740993n))));
    await expect(setSelfProfileDisplaySetting(nt, 7, '10002', 'gender', 99)).rejects.toThrow();
    await expect(getSelfProfileDisplaySettings(nt, 7, '0')).rejects.toThrow();
    expect(nt.sendPacket).not.toHaveBeenCalled();
    expect((await getSelfProfileDisplaySettings(nt, 7, '9007199254740993')).targetUin).toBe(
      '9007199254740993',
    );
  });
});
