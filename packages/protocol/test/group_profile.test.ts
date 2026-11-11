import { describe, expect, it, vi } from 'vitest';
import { decode, encode, GetGroupJoinInfo } from '../src/index';

describe('群扩展资料', () => {
  it('按独立 wire 夹具读取 grade、活跃人数、头像及明确零值', () => {
    // Android FieldMap / 真回包结构：36/37/43/44/91/100，目标及内容均为测试数据。
    const bytes = Buffer.from(
      '0a24087b10001a1ea00205a802d303d80202e202080801120208021802d80500a006007a0147',
      'hex',
    );
    expect(
      GetGroupJoinInfo.deserialize(decode(GetGroupJoinInfo.respSchema, bytes))[0],
    ).toMatchObject({
      groupId: 123,
      name: 'G',
      extensions: {
        grade: 5,
        activeMemberCount: 467,
        freezeState: 0,
        freezeReason: 0,
        portraitSequence: 2,
        portrait: {
          count: 1,
          defaultId: 2,
          pictures: [{ id: 2, left: null, top: null, right: null, bottom: null }],
        },
      },
    });
  });
  it('未返回与 0 分开；未知冻结状态保留原始值', () => {
    const read = (info: Record<string, unknown>) =>
      GetGroupJoinInfo.deserialize({ groups: [{ groupCode: 123n, info }] })[0]!.extensions;
    expect(read({})).toEqual({
      grade: null,
      activeMemberCount: null,
      freezeState: null,
      freezeReason: null,
      portraitSequence: null,
      portrait: null,
    });
    expect(read({ grade: 0, activeMemberCount: 0, freezeState: 2 })).toMatchObject({
      grade: 0,
      activeMemberCount: 0,
      freezeState: 2,
    });
    expect(read({ portrait: {} })?.portrait).toEqual({
      count: null,
      defaultId: null,
      pictures: [],
    });
  });
  it('仅扩展读取选择新字段，旧入群读取的请求不变', () => {
    const decoded = (includeExtensions: boolean) =>
      decode(
        GetGroupJoinInfo.reqSchema,
        encode(
          GetGroupJoinInfo.reqSchema,
          GetGroupJoinInfo.serialize({ groupId: 123, includeExtensions }),
        ),
      );
    expect(decoded(false).groups).toEqual([
      {
        groupCode: 123n,
        info: {
          maxMemberCount: 0,
          memberCount: 0,
          option: 0,
          categoryId: 0,
          name: '',
          categoryName: '',
          question: '',
        },
      },
    ]);
    expect(decoded(true).groups).toMatchObject([
      {
        info: {
          grade: 0,
          activeMemberCount: 0,
          freezeState: 0,
          freezeReason: 0,
          portraitSequence: 0,
          portrait: {},
        },
      },
    ]);
  });
  it('拒绝错群、业务错误及非法字段，不生成空的成功资料', async () => {
    const nt = { sendOidbPacket: vi.fn(async () => Buffer.from('0a04087c1a00', 'hex')) };
    await expect(
      GetGroupJoinInfo.invoke(nt, 1, { groupId: 123, includeExtensions: true }),
    ).rejects.toThrow('不一致');
    expect(() =>
      GetGroupJoinInfo.deserialize({ groups: [{ groupCode: 123n, result: 319, info: {} }] }),
    ).toThrow('拒绝');
    for (const activeMemberCount of [-1, 1.5, Number.NaN])
      expect(() =>
        GetGroupJoinInfo.deserialize({
          groups: [{ groupCode: 123n, info: { activeMemberCount } }],
        }),
      ).toThrow('无效');
  });
});
