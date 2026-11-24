/**
 * GroupModerationService 的离线单测：断言每条指令真正上 wire 的 command / cmd
 * 与 inner body，不连任何网络。
 *
 * 报文编码本身已在 @weqbot/protocol 的单测里覆盖（group_admin / recall），这里只验
 * 服务层到协议的转发与参数映射。
 */

import { describe, expect, it } from 'vitest';
import { GroupModerationService } from '../src/account/group_moderation';
import {
  RecallPrivate,
  decode,
  MuteGroupAll,
  MUTE_ALL_PERMANENT,
  SetGroupSearch,
} from '@weqbot/protocol';

interface OidbCall {
  pid: number;
  command: number;
  subCommand: number;
  body: Uint8Array;
  uinForm: boolean;
  needSign: boolean;
  signMode: number;
}
interface TrpcCall {
  pid: number;
  cmd: string;
  body: Uint8Array;
  needSign: boolean;
}

function fakeNative(
  groupDetail = Buffer.alloc(0),
  otherReply: (command: number) => Buffer = () => Buffer.alloc(0),
) {
  const oidb: OidbCall[] = [];
  const trpc: TrpcCall[] = [];
  return {
    oidb,
    trpc,
    sendOidbPacket: async (
      pid: number,
      command: number,
      subCommand: number,
      body: Buffer,
      uinForm: boolean,
      needSign: boolean,
      signMode: number,
    ): Promise<Buffer> => {
      oidb.push({
        pid,
        command,
        subCommand,
        body: new Uint8Array(body),
        uinForm,
        needSign,
        signMode,
      });
      return command === 0x88d ? groupDetail : otherReply(command);
    },
    sendPacket: async (
      pid: number,
      cmd: string,
      body: Buffer,
      needSign: boolean,
    ): Promise<Buffer> => {
      trpc.push({ pid, cmd, body: new Uint8Array(body), needSign });
      return Buffer.alloc(0);
    },
  };
}

const PID = 4321;

function makeService(nt: ReturnType<typeof fakeNative>) {
  return new GroupModerationService(nt, () => PID);
}

function groupSearchDetail(keywordFlag: number, numberFlag: number) {
  return Buffer.from([
    0x0a,
    0x0f,
    0x08,
    0xb9,
    0x60,
    0x1a,
    0x0a,
    0xa8,
    0x01,
    0xb9,
    0x60,
    0x90,
    0x05,
    keywordFlag,
    0x98,
    0x05,
    numberFlag,
  ]);
}

describe('GroupModerationService', () => {
  it.each([
    [
      'require_approval',
      '0a0f08b9601a0aa801b960208001c00301',
      '08b960120cb80100c0018080c030e80101',
    ],
    ['no_approval', '0a0e08b9601a09a801b9602000c00301', '08b960120eb801808040c0018080c030e80101'],
    [
      'no_approval_under_100',
      '0a0e08b9601a09a801b9602000c00301',
      '08b960120fb80180808020c0018080c030e80101',
    ],
  ] as const)('成员邀请设置 %s 时同包写入开关及审核档位', async (value, detail, expectedBody) => {
    const nt = fakeNative(Buffer.from(detail, 'hex'));
    await makeService(nt).setAdvancedSetting(12345, { key: 'invitePolicy', value }, () => {});
    const writes = nt.oidb.filter(({ command }) => command === 0x89a);
    expect(writes).toMatchObject([{ subCommand: 8, uinForm: false, needSign: true, signMode: 3 }]);
    expect(Buffer.from(writes[0]!.body).toString('hex')).toBe(expectedBody);
  });

  it('允许邀请时按审核规则读回，禁止邀请只提交开关', async () => {
    const nt = fakeNative(Buffer.from('0a1108b9601a0ca801b9602000c00381808020', 'hex'));
    const service = makeService(nt);
    expect((await service.advancedSettings(12345)).invitePolicy).toBe('no_approval_under_100');
    await service.setAdvancedSetting(12345, { key: 'invitePolicy', value: 'disabled' }, () => {});
    const writes = nt.oidb.filter(({ command }) => command === 0x89a);
    expect(
      writes.map(({ subCommand, body }) => [subCommand, Buffer.from(body).toString('hex')]),
    ).toEqual([[8, '08b9601203e80100']]);
  });

  it('读回档位已相同时不重复保存成员邀请', async () => {
    const nt = fakeNative(Buffer.from('0a1108b9601a0ca801b9602000c00381808020', 'hex'));
    await makeService(nt).setAdvancedSetting(
      12345,
      { key: 'invitePolicy', value: 'no_approval_under_100' },
      () => {},
    );
    expect(nt.oidb.some(({ command }) => command === 0x89a)).toBe(false);
  });

  it('成员邀请请求被拒时只发送一次并报告错误', async () => {
    const nt = fakeNative(Buffer.from('0a0f08b9601a0aa801b960208001c00301', 'hex'), (command) => {
      if (command === 0x89a) throw new Error('OIDB error 1006: ');
      return Buffer.alloc(0);
    });
    await expect(
      makeService(nt).setAdvancedSetting(
        12345,
        { key: 'invitePolicy', value: 'no_approval' },
        () => {},
      ),
    ).rejects.toThrow('QQ 拒绝修改邀请审核方式（1006）');
    expect(nt.oidb.filter(({ command }) => command === 0x89a)).toHaveLength(1);
  });

  it('机器人开关与审核使用各自的开关值，写入单项不覆盖其他字段', async () => {
    const nt = fakeNative(groupSearchDetail(0, 0), (command) =>
      command === 0xef0 ? Buffer.from('0a0b08b9601a06e80102f00102', 'hex') : Buffer.alloc(0),
    );
    const service = makeService(nt);
    expect(await service.advancedSettings(12345)).toMatchObject({
      robotMemberSwitch: true,
      robotMemberExamine: true,
    });
    await service.setAdvancedSetting(12345, { key: 'robotMemberSwitch', value: false }, () => {});
    await service.setAdvancedSetting(12345, { key: 'robotMemberExamine', value: false }, () => {});
    expect(
      nt.oidb
        .filter(({ command }) => command === 0xf00)
        .map(({ body }) => Buffer.from(body).toString('hex')),
    ).toEqual(['08b960120808b9601203e80101', '08b960120808b9601203f00101']);
  });

  it('历史可见和机器人设置不依赖旧值，读改写的成员权限仍须原位', async () => {
    const nt = fakeNative();
    const service = makeService(nt);
    await service.setAdvancedSetting(12345, { key: 'newMemberHistory', value: true }, () => {});
    await service.setAdvancedSetting(12345, { key: 'robotMemberSwitch', value: true }, () => {});
    expect(nt.oidb.map(({ command }) => command)).toEqual([0x89a, 0xf00]);
    await expect(
      service.setAdvancedSetting(12345, { key: 'allowMemberCreateGroup', value: true }, () => {}),
    ).rejects.toThrow();
    expect(nt.oidb.map(({ command }) => command)).toEqual([0x89a, 0xf00, 0x88d]);
  });

  it('从群详情补读机器人扩展，成功返回扩展时使用 QQ 的缺省值', async () => {
    const nt = fakeNative(Buffer.from('0a0f08b9601a0aa801b960ea0603e80101', 'hex'));
    expect(await makeService(nt).advancedSettings(12345)).toMatchObject({
      robotMemberSwitch: false,
      robotMemberExamine: false,
    });
  });

  it.each([
    ['keyword_or_number', 'disabled', 0, 0, 1, 1],
    ['number_only', 'keyword_or_number', 1, 0, 0, 0],
    ['disabled', 'number_only', 1, 1, 1, 0],
  ] as const)(
    '群搜索方式 %s 读回正确，切为 %s 时提交完整字段',
    async (mode, next, keyword, number, nextKeyword, nextNumber) => {
      const nt = fakeNative(groupSearchDetail(keyword, number));
      const service = makeService(nt);
      expect((await service.advancedSettings(12345)).searchMode).toBe(mode);
      await service.setAdvancedSetting(12345, { key: 'searchMode', value: next }, () => {});
      const writes = nt.oidb.filter(({ command }) => command === 0x89a);
      expect(writes).toHaveLength(1);
      expect(writes[0]?.subCommand).toBe(0);
      expect(decode(SetGroupSearch.reqSchema, writes[0]!.body)).toMatchObject({
        groupUin: 12345n,
        settings: { noFingerOpen: nextKeyword, noCodeFingerOpen: nextNumber },
      });
    },
  );

  it('群搜索回包若只允许关键词搜索，状态仍为未知', async () => {
    const nt = fakeNative(groupSearchDetail(0, 1));
    const service = makeService(nt);
    expect((await service.advancedSettings(12345)).searchMode).toBeNull();
    expect(nt.oidb.some(({ command }) => command === 0x89a)).toBe(false);
  });

  it('群详情读回失败时，管理员仍能明确提交一个完整的搜索档位', async () => {
    const nt = fakeNative(Buffer.from('0a0508b9601048', 'hex'));
    const service = makeService(nt);
    await expect(service.advancedSettings(12345)).rejects.toThrow('72');
    nt.oidb.length = 0;
    await service.setAdvancedSetting(12345, { key: 'searchMode', value: 'number_only' }, () => {});
    expect(nt.oidb.map(({ command, subCommand }) => [command, subCommand])).toEqual([[0x89a, 0]]);
    expect(decode(SetGroupSearch.reqSchema, nt.oidb[0]!.body)).toMatchObject({
      groupUin: 12345n,
      settings: { noFingerOpen: 1, noCodeFingerOpen: 0 },
    });
  });

  it('全员禁言和解除都发送明确的 state', async () => {
    const nt = fakeNative();
    const service = makeService(nt);
    await service.muteAll({ groupId: 12345, enable: true });
    await service.muteAll({ groupId: 12345, enable: false });
    expect(nt.oidb.map((call) => decode(MuteGroupAll.reqSchema, call.body))).toEqual([
      { groupUin: 12345, muteState: { state: MUTE_ALL_PERMANENT } },
      { groupUin: 12345, muteState: { state: 0 } },
    ]);
  });
  it('recallMessage(group) 走 SsoGroupRecallMsg，不签名，带 groupUin + sequence', async () => {
    const nt = fakeNative();
    await makeService(nt).recallMessage({ kind: 'group', conv: '12345', sequence: 7, random: 9 });
    expect(nt.oidb).toHaveLength(0);
    const call = nt.trpc[0]!;
    expect(call.pid).toBe(PID);
    expect(call.cmd).toBe('trpc.msg.msg_svc.MsgService.SsoGroupRecallMsg');
    expect(call.needSign).toBe(false);
    // f1 type=1, f2 groupUin=12345, f3 info{ sequence=7, random=9 }, f4 settings 空 message
    expect(Array.from(call.body)).toEqual([
      0x08, 0x01, 0x10, 0xb9, 0x60, 0x1a, 0x04, 0x08, 0x07, 0x10, 0x09, 0x22, 0x00,
    ]);
  });

  it('recallMessage(c2c) 走 SsoC2CRecallMsg，签名，targetUid + 私聊定位字段', async () => {
    const nt = fakeNative();
    await makeService(nt).recallMessage({
      kind: 'c2c',
      conv: 'u_peer',
      clientSequence: 17,
      sequence: 2,
      random: 3,
      timestamp: 4,
    });
    const call = nt.trpc[0]!;
    expect(call.cmd).toBe('trpc.msg.msg_svc.MsgService.SsoC2CRecallMsg');
    expect(call.needSign).toBe(true);
    // 开头是 f1 type=1、f3 targetUid='u_peer'
    expect(Array.from(call.body.slice(0, 2))).toEqual([0x08, 0x01]);
    expect(new TextDecoder().decode(call.body)).toContain('u_peer');
    expect(decode(RecallPrivate.reqSchema, call.body)).toMatchObject({
      targetUid: 'u_peer',
      info: { clientSequence: 17, messageSequence: 2, random: 3, timestamp: 4 },
    });
  });

  it('setMemberCard 走 0x8fc_3，targetUid + card', async () => {
    const nt = fakeNative();
    await makeService(nt).setMemberCard({ groupId: '12345', targetUid: 'u_x', card: '卡' });
    const call = nt.oidb[0]!;
    expect(call.pid).toBe(PID);
    expect(call.command).toBe(0x8fc);
    expect(call.subCommand).toBe(3);
    expect(new TextDecoder().decode(call.body)).toContain('u_x');
  });

  it('kickMember 走 0x8a0_1', async () => {
    const nt = fakeNative();
    await makeService(nt).kickMember({ groupId: 12345, targetUid: 'u_x' });
    const call = nt.oidb[0]!;
    expect(call.command).toBe(0x8a0);
    expect(call.subCommand).toBe(1);
  });

  it('muteMember 走 0x1253_1，duration 秒', async () => {
    const nt = fakeNative();
    await makeService(nt).muteMember({ groupId: 12345, targetUid: 'u_x', duration: 600 });
    const call = nt.oidb[0]!;
    expect(call.command).toBe(0x1253);
    expect(call.subCommand).toBe(1);
    expect(new TextDecoder().decode(call.body)).toContain('u_x');
  });

  it('setAdmin 走 0x1096_1，enable 映射到 isAdmin', async () => {
    const nt = fakeNative();
    const svc = makeService(nt);
    await svc.setAdmin({ groupId: 12345, targetUid: 'u_x', enable: true });
    await svc.setAdmin({ groupId: 12345, targetUid: 'u_x', enable: false });
    expect(nt.oidb.map((c) => c.command)).toEqual([0x1096, 0x1096]);
    expect(nt.oidb.map((c) => c.subCommand)).toEqual([1, 1]);
    // isAdmin 是 bool tag3：true = 0x18 0x01，false 省略
    expect(nt.oidb[0]!.body).toContain(1);
    expect(nt.oidb[1]!.body.length).toBeLessThan(nt.oidb[0]!.body.length);
  });

  it('空 targetUid 在编码前报错（不发包）', async () => {
    const nt = fakeNative();
    const svc = makeService(nt);
    await expect(svc.kickMember({ groupId: 1, targetUid: '  ' })).rejects.toThrow(/uid/);
    expect(nt.oidb).toHaveLength(0);
  });
});
