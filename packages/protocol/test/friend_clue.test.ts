import { describe, expect, it, vi } from 'vitest';
import { getFriendClue, FRIEND_CLUE_COMMAND } from '../src/index';

// 独立手写 WebSSO field 4，避免响应和生产 schema 共享字段编号假设。
function reply(data: unknown, prefix: number[] = []) {
  const json = Buffer.from(JSON.stringify(data));
  const length: number[] = [];
  let remaining = json.length;
  do {
    length.push((remaining & 127) | (remaining > 127 ? 128 : 0));
    remaining >>>= 7;
  } while (remaining);
  return Buffer.concat([Buffer.from([...prefix, 0x22, ...length]), json]);
}
function fixture(bytes: Buffer) {
  const sendPacket = vi.fn(async () => bytes);
  return { sendPacket };
}

describe('好友线索 WebSSO', () => {
  it.each([
    ['4162123456', '272123456'],
    ['2067654321', '124654321'],
  ])('来源群内部 UIN %s 转换为公开群号 %s，来源文案保持不变', async (uin, code) => {
    for (const value of [uin, Number(uin)]) {
      const result = await getFriendClue(
        fixture(
          reply({
            ErrorCode: 0,
            uint64_group_id: value,
            str_add_frd_source_wording: '线索来源原文',
          }),
        ),
        5,
        '10002',
      );
      expect(result.sourceGroupCode).toBe(code);
      expect(result.source).toBe('线索来源原文');
    }
  });
  it.each([
    ['202000001', '1'],
    ['212999999', '10999999'],
    ['480000001', '11000001'],
    ['488999999', '19999999'],
    ['2100000001', '20000001'],
    ['2146999999', '66999999'],
    ['2010000001', '67000001'],
    ['2099999999', '156999999'],
    ['2147000001', '157000001'],
    ['2199999999', '209999999'],
    ['2600000001', '335000001'],
    ['2651999999', '386999999'],
    ['3800000001', '310000001'],
    ['3989999999', '499999999'],
    ['4100000001', '210000001'],
    ['4199999999', '309999999'],
  ])('内部 UIN 号段边界 %s 正确转换为 %s', async (uin, code) => {
    const result = await getFriendClue(
      fixture(reply({ ErrorCode: 0, uint64_group_id: uin })),
      5,
      '10002',
    );
    expect(result.sourceGroupCode).toBe(code);
  });
  it.each([
    '201999999',
    '213000000',
    '479999999',
    '489000000',
    '2009999999',
    '2200000000',
    '2599999999',
    '2652000000',
    '3799999999',
    '3990000000',
    '4099999999',
    '4200000000',
    '1234567890',
    '9007199254740993',
  ])('不属于转换号段的来源群标识 %s 保持原值及精度', async (uin) => {
    const result = await getFriendClue(
      fixture(reply({ ErrorCode: 0, uint64_group_id: uin })),
      5,
      '10002',
    );
    expect(result.sourceGroupCode).toBe(uin);
  });
  it('使用完整命令、显式 JSON type=0 和数字 UIN，不发送 OIDB 信封', async () => {
    const nt = fixture(
      reply({
        ErrorCode: 0,
        uint64_add_frd_time: 1704067200,
        uint32_add_frd_type: 2,
        str_add_frd_source_wording: '通过群聊',
        str_add_frd_message: '你好\n问题1:名字',
        uint64_group_id: '9007199254740993',
        bool_group_jump: true,
      }),
    );
    const result = await getFriendClue(nt, 5, '10002');
    expect(result).toEqual({
      targetUin: '10002',
      addedAt: 1704067200,
      direction: 'outgoing',
      rawDirection: 2,
      source: '通过群聊',
      verificationMessage: '你好\n问题1:名字',
      sourceGroupCode: '9007199254740993',
      canOpenSourceGroup: true,
    });
    const call = nt.sendPacket.mock.calls[0] as unknown as unknown[];
    expect(call.slice(0, 2)).toEqual([5, FRIEND_CLUE_COMMAND]);
    expect(call[3]).toBe(false);
    const json = Buffer.from('{"uint64_friend_uin":10002}');
    expect(call[2]).toEqual(Buffer.concat([Buffer.from([0x10, 0, 0x1a, json.length]), json]));
  });
  it.each([undefined, 0, 1, 2, 9])('方向 %s 不把缺省或未知值变为被动添加', async (value) => {
    const result = await getFriendClue(
      fixture(reply({ ErrorCode: 0, uint32_add_frd_type: value })),
      5,
      '10002',
    );
    expect(result.direction).toBe(value === 1 ? 'incoming' : value === 2 ? 'outgoing' : null);
    expect(result.rawDirection).toBe(value ?? null);
    expect(result.addedAt).toBeNull();
    expect(result.source).toBeNull();
    expect(result.verificationMessage).toBeNull();
  });
  it('保留明确空验证消息、false 和零时间，与缺失分开', async () => {
    const result = await getFriendClue(
      fixture(
        reply({
          ErrorCode: 0,
          uint64_add_frd_time: '0',
          str_add_frd_message: '',
          bool_group_jump: false,
          uint64_group_id: 0,
        }),
      ),
      5,
      '10002',
    );
    expect(result.verificationMessage).toBe('');
    expect(result.canOpenSourceGroup).toBe(false);
    expect(result.sourceGroupCode).toBeNull();
    expect(result.addedAt).toBeNull();
  });
  it.each([
    { ErrorCode: 1 },
    {},
    [],
    { ErrorCode: '0' },
    { ErrorCode: 0, uint64_friend_uin: 10003 },
    { ErrorCode: 0, uint64_add_frd_time: -1 },
    { ErrorCode: 0, uint64_add_frd_time: 8640000000001 },
    { ErrorCode: 0, uint64_group_id: 9007199254740992 },
    { ErrorCode: 0, uint64_group_id: '18446744073709551616' },
    { ErrorCode: 0, uint32_add_frd_type: 1.5 },
    { ErrorCode: 0, bool_group_jump: 1 },
    { ErrorCode: 0, str_add_frd_message: {} },
  ])('拒绝无效业务内容 %j', async (data) => {
    await expect(getFriendClue(fixture(reply(data)), 5, '10002')).rejects.toThrow();
  });
  it.each([
    Buffer.alloc(0),
    Buffer.from([0x22, 99, 123, 125]),
    Buffer.from([0x22, 1, 255]),
    reply({ ErrorCode: 0 }, [0x18, 1]),
    reply({ ErrorCode: 0 }, [0x10, 1]),
    reply({ ErrorCode: 0 }, [0x18, 0, 0x18, 0]),
    Buffer.from([0x22, 1, 123]),
  ])('拒绝错误、截断或重复外层字段 %#', async (bytes) => {
    await expect(getFriendClue(fixture(bytes), 5, '10002')).rejects.toThrow();
  });
  it.each(['u_peer', '10002junk', '0', '9007199254740993'])(
    '发包前拒绝无效目标 %s',
    async (uin) => {
      const nt = fixture(reply({ ErrorCode: 0 }));
      await expect(getFriendClue(nt, 5, uin)).rejects.toThrow();
      expect(nt.sendPacket).not.toHaveBeenCalled();
    },
  );
});
