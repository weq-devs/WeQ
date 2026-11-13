import { describe, expect, it, vi } from 'vitest';
import { getEducationHistory } from '../src/oidb/profile/education';

// 从 FieldMap 独立构造 wire，避免用生产 schema 验证自身。
function v(value: number | bigint) {
  let rest = BigInt(value);
  const bytes: number[] = [];
  do {
    bytes.push(Number(rest & 127n) | (rest > 127n ? 128 : 0));
    rest >>= 7n;
  } while (rest);
  return Buffer.from(bytes);
}
const pb = (...fields: Uint8Array[]) => Buffer.concat(fields);
const n = (tag: number, value: number | bigint) => pb(v(tag * 8), v(value));
const b = (tag: number, value: string | Uint8Array) => {
  const data = Buffer.from(value);
  return pb(v(tag * 8 + 2), v(data.length), data);
};
const oidb = (body: Uint8Array, result = 0, command = 0xd2d, sub = 1) =>
  pb(n(1, command), n(2, sub), n(3, result), b(4, body));
const nt = (reply: Uint8Array) => ({
  sendPacket: vi.fn(async (_pid: number, _command: string, _body: Uint8Array) =>
    Buffer.from(reply),
  ),
});

describe('完整教育经历读取', () => {
  it('原生命令无后缀，子命令一，显式请求全部类别零', async () => {
    const native = nt(oidb(Buffer.alloc(0)));
    expect(await getEducationHistory(native, 7, '10002')).toEqual({
      targetUin: '10002',
      items: [],
    });
    const [pid, command, bytes] = native.sendPacket.mock.calls[0]!;
    expect(pid).toBe(7);
    expect(command).toBe('OidbSvc.0xd2d');
    expect(Buffer.from(bytes).toString('hex')).toBe('08ad1a1001220508924e1000');
  });

  it('多条记录保留全部十七字段，记录编号来自 tag100', async () => {
    const school = pb(
      n(1, 3),
      b(2, 'school-id'),
      b(3, '合成大学'),
      b(4, 'dept-id'),
      b(5, '合成院系'),
      n(6, 6),
      n(7, 2019),
      n(8, 2023),
      n(9, 0),
      n(10, 4),
      n(11, 100),
      n(12, 5),
      n(13, 200),
      n(14, 0),
      n(15, 2),
      n(16, 8),
      n(100, 19),
    );
    const result = await getEducationHistory(
      nt(oidb(b(1, pb(b(1, school), b(1, pb(b(3, '合成高中'), n(100, 20))))))),
      7,
      '10002',
    );
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual({
      index: 19,
      category: 3,
      schoolId: 'school-id',
      schoolName: '合成大学',
      departmentId: 'dept-id',
      departmentName: '合成院系',
      degree: 6,
      enrollmentYear: 2019,
      graduationYear: 2023,
      allowRecommend: 0,
      createSource: 4,
      createdAt: 100,
      updateSource: 5,
      updatedAt: 200,
      hidden: 0,
      verifyStatus: 2,
      verifyType: 8,
    });
    expect(result.items[1]).toMatchObject({
      index: 20,
      schoolName: '合成高中',
      degree: null,
      hidden: null,
    });
    expect(Object.keys(result.items[0]!)).toHaveLength(17);
  });

  it('未知枚举和明确零值保留，不把缺字段补成零或移除隐藏记录', async () => {
    const result = await getEducationHistory(
      nt(oidb(b(1, b(1, pb(n(1, 99), n(6, 0), n(14, 1), n(15, 99), n(100, 0)))))),
      7,
      '10002',
    );
    expect(result.items[0]).toMatchObject({
      index: 0,
      category: 99,
      degree: 0,
      hidden: 1,
      verifyStatus: 99,
      schoolName: null,
      graduationYear: null,
    });
  });

  it('不按旧学校字符串或固定条数截断，也不按学校名去重', async () => {
    const records = Array.from({ length: 600 }, (_, index) =>
      b(1, pb(b(3, '同名学校'), n(100, index))),
    );
    const result = await getEducationHistory(nt(oidb(b(1, pb(...records)))), 7, '10002');
    expect(result.items).toHaveLength(600);
    expect(result.items.at(-1)?.index).toBe(599);
  });

  it.each([Buffer.alloc(0), b(1, Buffer.alloc(0))])(
    '成功空响应允许缺省 EduHis 或列表',
    async (body) => {
      expect((await getEducationHistory(nt(oidb(body)), 7, '10002')).items).toEqual([]);
    },
  );

  it.each([
    oidb(Buffer.alloc(0), 151),
    oidb(Buffer.alloc(0), 0, 0xd2e),
    oidb(Buffer.alloc(0), 0, 0xd2d, 2),
    oidb(Buffer.from([10, 8, 10])),
  ])('业务错误、命令错配及截断不伪装为空列表', async (reply) => {
    await expect(getEducationHistory(nt(reply), 7, '10002')).rejects.toThrow();
  });

  it('非法目标在发包前拒绝，uint64 目标不丢精度', async () => {
    const native = nt(oidb(Buffer.alloc(0)));
    await expect(getEducationHistory(native, 7, '0')).rejects.toThrow();
    expect(native.sendPacket).not.toHaveBeenCalled();
    expect((await getEducationHistory(native, 7, '9007199254740993')).targetUin).toBe(
      '9007199254740993',
    );
    expect(Buffer.from(native.sendPacket.mock.calls[0]![2]).includes(v(9007199254740993n))).toBe(
      true,
    );
  });
});
