import { describe, expect, it, vi } from 'vitest';
import { decode, encode } from '../src/protobuf';
import { GetGroupOperationInfo as Query } from '../src/oidb/group-admin/get-group-operation-info';

describe('群权限真实字段与缺省', () => {
  it('使用 0x88d_0 读取权限，不能把 110 的成功但缺字段回包当成未禁言', async () => {
    // 同群线上对照回包，仅将群号替换为 123；110 不返回全员禁言，0 返回非零值。
    const limited = Buffer.from(
      '0a1d087b10001a17200030f909f00200e80400f80400b00500980600e00604',
      'hex',
    );
    const complete = Buffer.from(
      '0a2a087b10001a2430f909e802c4b4e5d70ef00200c003c081a420f80400b00500c00500e00604ea06020804',
      'hex',
    );
    const sendOidbPacket = vi.fn(async (_pid: number, _command: number, subCommand: number) =>
      subCommand === 0 ? complete : limited,
    );
    expect(Query.deserialize(decode(Query.respSchema, limited))[0]).toMatchObject({
      muteAll: null,
      muteUntil: 0,
    });
    await expect(Query.invoke({ sendOidbPacket }, 9, { groupId: 123 })).resolves.toMatchObject({
      muteAll: true,
      muteUntil: 0,
      memberCanUpload: true,
    });
    expect(sendOidbPacket).toHaveBeenCalledWith(9, 0x88d, 0, expect.any(Buffer), false, false, 3);
  });

  it('按独立 Android FieldMap 样本解码，缺失不补成许可', () => {
    // group 123，info: privilegeFlag@56=2, rename@88=2, kick@86=1, ext@109.14=2。
    const raw = Buffer.from('0a12087b1a0ec00302c00502b00501ea06027002', 'hex');
    const row = Query.deserialize(decode(Query.respSchema, raw))[0]!;
    expect(row.memberCanUpload).toBe(false);
    expect(row.memberCanRename).toBe(true);
    expect(row.allowMemberKick).toBe(true);
    expect(row.memberCanEssence).toBe(true);
    expect(row.muteAll).toBeNull();
    expect(row.muteUntil).toBeNull();
  });
  it('返回了群但没返回字段时保留未知', () => {
    expect(Query.deserialize({ groups: [{ groupCode: 123n, info: {} }] })[0]).toMatchObject({
      memberCanRename: null,
      memberCanEssence: null,
      allowMemberKick: null,
      memberCanUpload: null,
    });
  });
  it('拒绝业务错误、错误数字字段', () => {
    expect(() => Query.deserialize({ groups: [{ result: 5 }] })).toThrow();
    expect(() => Query.deserialize({ groups: [{ info: { muteUntil: -1 } }] })).toThrow();
  });
  it('请求只选择已确认字段，零值选择器保留', () => {
    const parsed = decode(
      Query.reqSchema,
      encode(Query.reqSchema, Query.serialize({ groupId: 123 })),
    );
    expect(parsed.groups).toEqual([
      {
        groupCode: 123n,
        info: {
          muteAllUntil: 0n,
          muteUntil: 0,
          privilegeFlag: 0,
          isConf: 0,
          allowMemberKick: 0,
          memberRenameSwitch: 0,
          extension: { essencePrivilege: 0 },
        },
      },
    ]);
  });
  it('永久全员禁言的 uint64 最大值不会丢掉其他权限', () => {
    const row = Query.deserialize({
      groups: [
        {
          groupCode: 123n,
          info: {
            muteAllUntil: 0xffffffffffffffffn,
            memberRenameSwitch: 2,
          },
        },
      ],
    })[0]!;
    expect(row.muteAll).toBe(true);
    expect(row.memberCanRename).toBe(true);
    expect(() => Query.deserialize({ groups: [{ info: { muteAllUntil: -1n } }] })).toThrow();
  });
  it('无效群号不能发出权限请求', () => {
    for (const groupId of [0, -1, 1.5, Number.NaN])
      expect(() => Query.serialize({ groupId })).toThrow();
  });
});
