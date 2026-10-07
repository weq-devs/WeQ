/**
 * 新增群管理 OIDB 命令的离线单元测试：请求编码（黄金字节）+ 路由 + needSign。
 *
 * 字段布局对照 SnowLuma `oidb-services/group-admin/*`：
 *   - 0x89A_15 SetGroupName      body@2 / targetName@3
 *   - 0x89A_0  MuteGroupAll      muteState@2 / state@17（force 上线 0）
 *   - 0x1253_1 MuteGroupMember   type@2 / body@3 { targetUid@1, duration@2 }
 *   - 0x8A0_1  KickGroupMember   targetUid@3 / reject@4 / reason@5 + results@2
 *   - 0x1096_1 SetGroupAdmin     uid@2 / isAdmin@3
 *   - 0x8FC_3  SetGroupMemberCard  body@3 { targetUid@1, targetName@**8** }
 *   - 0x8FC_2  SetGroupSpecialTitle body@3 { targetUid@1, title@5, expire@6, uinName@7 }
 *   - 0xEAC    SetGroupEssence   sequence@2 / random@3（sub 1 设 / 2 撤）
 */

import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/protobuf';
import {
  KickGroupMember,
  MuteGroupAll,
  MuteGroupMember,
  SetGroupAdmin,
  SetGroupEssence,
  SetGroupMemberCard,
  SetGroupName,
  SetGroupSpecialTitle,
} from '../src/index';

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((h) => Number.parseInt(h, 16)),
  );

interface OidbCall {
  pid: number;
  command: number;
  subCommand: number;
  body: Uint8Array;
  isUid: boolean;
}

function makeNative() {
  const calls: OidbCall[] = [];
  return {
    calls,
    sendOidbPacket: async (
      pid: number,
      command: number,
      subCommand: number,
      body: Buffer,
      isUid: boolean,
    ): Promise<Buffer> => {
      calls.push({ pid, command, subCommand, body: new Uint8Array(body), isUid });
      return Buffer.alloc(0);
    },
  };
}

describe('SetGroupName (0x89A_15)', () => {
  it('body@2 / targetName@3，needSign=true（白名单）', () => {
    expect(SetGroupName.command).toBe(0x89a);
    expect(SetGroupName.subCommand).toBe(15);
    expect(SetGroupName.needSign).toBe(true);
    const bytes = encode(
      SetGroupName.reqSchema,
      SetGroupName.serialize({ groupId: 12345, name: 'NewName' }),
    );
    expect(bytes).toEqual(hexToBytes('08 b9 60 12 09 1a 07 4e 65 77 4e 61 6d 65'));
    expect(decode(SetGroupName.reqSchema, bytes)).toEqual({
      groupUin: 12345,
      body: { targetName: 'NewName' },
    });
  });

  it('空群名 / 非法群号在编码前报错', () => {
    expect(() => SetGroupName.serialize({ groupId: 0, name: 'x' })).toThrow(/groupId/);
    expect(() => SetGroupName.serialize({ groupId: 1, name: '   ' })).toThrow(/name/);
  });
});

describe('MuteGroupAll (0x89A_0)', () => {
  it('muteState@2 / state@17，禁言=0xFFFFFFFF，needSign=true', () => {
    expect(MuteGroupAll.command).toBe(0x89a);
    expect(MuteGroupAll.subCommand).toBe(0);
    expect(MuteGroupAll.needSign).toBe(true);
    const on = encode(
      MuteGroupAll.reqSchema,
      MuteGroupAll.serialize({ groupId: 100, enable: true }),
    );
    expect(on).toEqual(hexToBytes('08 64 12 07 88 01 ff ff ff ff 0f'));
    const off = encode(
      MuteGroupAll.reqSchema,
      MuteGroupAll.serialize({ groupId: 100, enable: false }),
    );
    // state=0 必须显式上线，否则服务端与同 (0x89A,0) 的其它命令混淆。
    expect(off).toEqual(hexToBytes('08 64 12 03 88 01 00'));
  });
});

describe('MuteGroupMember (0x1253_1)', () => {
  it('type=1 / body{ targetUid, duration }，needSign=false', () => {
    expect(MuteGroupMember.command).toBe(0x1253);
    expect(MuteGroupMember.subCommand).toBe(1);
    expect(MuteGroupMember.needSign).toBe(false);
    const bytes = encode(
      MuteGroupMember.reqSchema,
      MuteGroupMember.serialize({ groupId: 100, targetUid: 'u_x', duration: 600 }),
    );
    expect(decode(MuteGroupMember.reqSchema, bytes)).toEqual({
      groupUin: 100,
      type: 1,
      body: { targetUid: 'u_x', duration: 600 },
    });
  });

  it('duration=0（解除禁言）合法', () => {
    expect(() =>
      MuteGroupMember.serialize({ groupId: 100, targetUid: 'u_x', duration: 0 }),
    ).not.toThrow();
    expect(() =>
      MuteGroupMember.serialize({ groupId: 100, targetUid: 'u_x', duration: -1 }),
    ).toThrow(/duration/);
  });
});

describe('KickGroupMember (0x8A0_1)', () => {
  it('targetUid@3 / reject@4，非 0 results 抛错', async () => {
    expect(KickGroupMember.command).toBe(0x8a0);
    expect(KickGroupMember.subCommand).toBe(1);
    expect(KickGroupMember.needSign).toBe(false);

    const bytes = encode(
      KickGroupMember.reqSchema,
      KickGroupMember.serialize({ groupId: 100, targetUid: 'u_x', reject: true, reason: 'r' }),
    );
    expect(decode(KickGroupMember.reqSchema, bytes)).toEqual({
      groupUin: 100,
      targetUid: 'u_x',
      rejectAddRequest: true,
      reason: 'r',
    });

    // 信封 errorCode=0 也可能带失败的 result，必须逐个检查。
    const resp = encode(KickGroupMember.respSchema, {
      groupUin: 100,
      results: [{ result: 5, uid: 'u_x' }],
    });
    expect(() => KickGroupMember.deserialize(decode(KickGroupMember.respSchema, resp))).toThrow(
      /result=5/,
    );
    expect(() =>
      KickGroupMember.deserialize({ results: [{ result: 0, uid: 'u_x' }] }),
    ).not.toThrow();
  });
});

describe('SetGroupAdmin (0x1096_1)', () => {
  it('uid@2 / isAdmin@3，needSign=false', () => {
    expect(SetGroupAdmin.command).toBe(0x1096);
    expect(SetGroupAdmin.subCommand).toBe(1);
    expect(SetGroupAdmin.needSign).toBe(false);
    const bytes = encode(
      SetGroupAdmin.reqSchema,
      SetGroupAdmin.serialize({ groupId: 100, targetUid: 'u_x', enable: true }),
    );
    expect(decode(SetGroupAdmin.reqSchema, bytes)).toEqual({
      groupUin: 100,
      uid: 'u_x',
      isAdmin: true,
    });
  });
});

describe('SetGroupMemberCard (0x8FC_3)', () => {
  it('body@3 / targetName@8（不是 2），needSign=true', () => {
    expect(SetGroupMemberCard.command).toBe(0x8fc);
    expect(SetGroupMemberCard.subCommand).toBe(3);
    expect(SetGroupMemberCard.needSign).toBe(true);
    const bytes = encode(
      SetGroupMemberCard.reqSchema,
      SetGroupMemberCard.serialize({ groupId: 100, targetUid: 'u_x', card: '卡片' }),
    );
    expect(bytes).toEqual(hexToBytes('08 64 1a 0d 0a 03 75 5f 78 42 06 e5 8d a1 e7 89 87'));
  });
});

describe('SetGroupSpecialTitle (0x8FC_2)', () => {
  it('title@5 / expire@6(-1) / uinName@7 镜像 title，needSign=false', () => {
    expect(SetGroupSpecialTitle.command).toBe(0x8fc);
    expect(SetGroupSpecialTitle.subCommand).toBe(2);
    expect(SetGroupSpecialTitle.needSign).toBe(false);
    const bytes = encode(
      SetGroupSpecialTitle.reqSchema,
      SetGroupSpecialTitle.serialize({ groupId: 100, targetUid: 'u_x', title: 'A' }),
    );
    expect(bytes).toEqual(
      hexToBytes('08 64 1a 16 0a 03 75 5f 78 2a 01 41 30 ff ff ff ff ff ff ff ff ff 01 3a 01 41'),
    );
    const decoded = decode(SetGroupSpecialTitle.reqSchema, bytes);
    expect(decoded).toEqual({
      groupUin: 100,
      body: { targetUid: 'u_x', specialTitle: 'A', expireTime: -1, uinName: 'A' },
    });
  });
});

describe('SetGroupEssence (0xEAC)', () => {
  it('sequence@2 / random@3，sub 1 设 / 2 撤，needSign=false', async () => {
    expect(SetGroupEssence.command).toBe(0xeac);
    expect(SetGroupEssence.needSign).toBe(false);
    expect(
      SetGroupEssence.resolveSubCommand({ groupId: 1, sequence: 2, random: 3, enable: true }),
    ).toBe(1);
    expect(
      SetGroupEssence.resolveSubCommand({ groupId: 1, sequence: 2, random: 3, enable: false }),
    ).toBe(2);

    const nt = makeNative();
    await SetGroupEssence.invoke(nt, 9, { groupId: 100, sequence: 5, random: 7, enable: true });
    await SetGroupEssence.invoke(nt, 9, { groupId: 100, sequence: 5, random: 7, enable: false });
    expect(nt.calls.map((c) => c.subCommand)).toEqual([1, 2]);
    expect(nt.calls.every((c) => c.command === 0xeac && c.isUid === false)).toBe(true);
    expect(decode(SetGroupEssence.reqSchema, nt.calls[0]!.body)).toEqual({
      groupUin: 100,
      sequence: 5,
      random: 7,
    });
  });
});
