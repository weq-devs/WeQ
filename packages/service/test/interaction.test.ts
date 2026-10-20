/**
 * InteractionService 的离线单测：目标解析（群号 / QQ 号 / uid）+ 两条 OIDB 的
 * 报文断言（0xED3_1 戳一戳、0x9082_1/2 贴表情）。
 *
 * 用记账 native 打桩，断言真正上 wire 的 inner body 与 command/subCommand，
 * 不连任何网络。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  decode,
  encode,
  GetEmojiLikes,
  SendGroupSignup,
  SendGroupSign,
  SendPoke,
  SetReaction,
} from '@weq/protocol';
import type { AccountSession } from '@weq/account';
import { InteractionService } from '../src/account/interaction';

/**
 * 最小会话替身：`uidMap` 给戳一戳解析用，`profileInfo.getProfileByUin` 给「本地资料
 * 补昵称头像」用（传 null 表示本地库没这个人）。
 */
function fakeSession(
  profiles: Record<string, { nick?: string; remark?: string; avatarUrl?: string }> = {},
): AccountSession {
  return {
    context: { uin: 10001 },
    uidMap: {
      uidByUin: (uin: bigint) => (uin === 20002n ? 'u_friend' : undefined),
      uinByUid: (uid: string) => (uid === 'u_friend' ? 20002n : undefined),
    },
    profileInfo: {
      getProfileByUin: async (uin: bigint) => {
        const hit = profiles[String(uin)];
        if (!hit) return null;
        return { nick: hit.nick ?? '', remark: hit.remark ?? '', avatarUrl: hit.avatarUrl ?? '' };
      },
    },
  } as unknown as AccountSession;
}

interface OidbCall {
  pid: number;
  command: number;
  subCommand: number;
  body: Uint8Array;
  isUid: boolean;
}

/** `response` 缺省就是空 ack；需要回包内容时传一个已编码的 body。 */
function fakeNative(response?: Uint8Array) {
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
      return Buffer.from(response ?? new Uint8Array(0));
    },
  };
}

const PID = 4321;

describe('InteractionService', () => {
  describe('sendGroupSign (0xEB7_1)', () => {
    it('从当前会话取本人 UIN，群号与本人以字符串写入原命令', async () => {
      const nt = fakeNative();
      const svc = new InteractionService(nt, fakeSession(), () => PID);
      await svc.sendGroupSign('12345');
      expect(nt.calls[0]).toMatchObject({
        pid: PID,
        command: SendGroupSign.command,
        subCommand: SendGroupSign.subCommand,
        isUid: false,
      });
      expect(decode(SendGroupSign.reqSchema, nt.calls[0]!.body)).toMatchObject({
        signInInfo: { uin: '10001', groupId: '12345' },
      });
    });
    it('原生拒绝按原错误上抛，不吞成成功或自动重发', async () => {
      const sendOidbPacket = vi.fn(async () => {
        throw new Error('synthetic sign rejected');
      });
      const svc = new InteractionService({ sendOidbPacket }, fakeSession(), () => PID);
      await expect(svc.sendGroupSign(12345)).rejects.toThrow('synthetic sign rejected');
      expect(sendOidbPacket).toHaveBeenCalledOnce();
    });
  });
  describe('sendPoke (0xED3_1)', () => {
    it('群聊：targetId 是群号、targetUin 是被戳成员', async () => {
      const nt = fakeNative();
      const svc = new InteractionService(nt, fakeSession(), () => PID);
      await svc.sendPoke({ peerType: 'group', targetId: '12345', targetUin: '20002' });
      const call = nt.calls[0]!;
      expect(call.pid).toBe(PID);
      expect(call.command).toBe(0xed3);
      expect(call.subCommand).toBe(1);
      expect(call.isUid).toBe(false);
      // 外层 body 是 inner body 的裸字节（信封由 native 套）。
      const body = decode(SendPoke.reqSchema, call.body);
      // 默认值 0（friendUin / ext）按 proto3 省略，解码后不出现。
      expect(body).toEqual({ uin: 20002, groupUin: 12345 });
    });

    it('私聊：targetId 收 QQ 号或 uid 都能解析成 uin，且只填 friendUin', async () => {
      const nt = fakeNative();
      const svc = new InteractionService(nt, fakeSession(), () => PID);
      await svc.sendPoke({ peerType: 'c2c', targetId: '20002' });
      await svc.sendPoke({ peerType: 'c2c', targetId: 'u_friend' });
      for (const call of nt.calls) {
        expect(call.command).toBe(0xed3);
        const body = decode(SendPoke.reqSchema, call.body);
        expect(body.uin).toBe(20002);
        expect(body.friendUin).toBe(20002);
        expect(body.groupUin ?? 0).toBe(0);
      }
    });

    it('群聊不传 targetUin 时 uin 回落到群号', async () => {
      const nt = fakeNative();
      const svc = new InteractionService(nt, fakeSession(), () => PID);
      await svc.sendPoke({ peerType: 'group', targetId: '12345' });
      expect(decode(SendPoke.reqSchema, nt.calls[0]!.body).uin).toBe(12345);
    });

    it('解析不到的 uid / 非法目标报可读错误（不发包）', async () => {
      const nt = fakeNative();
      const svc = new InteractionService(nt, fakeSession(), () => PID);
      await expect(svc.sendPoke({ peerType: 'c2c', targetId: 'u_nobody' })).rejects.toThrow(/uid/);
      await expect(svc.sendPoke({ peerType: 'group', targetId: '' })).rejects.toThrow(/不能为空/);
      await expect(svc.sendPoke({ peerType: 'c2c', targetId: '0' })).rejects.toThrow(/不合法/);
      expect(nt.calls).toHaveLength(0);
    });
  });

  describe('setMessageReaction (0x9082)', () => {
    it('set=true 走 sub 1、set=false 走 sub 2，body 字段号 2..7', async () => {
      const nt = fakeNative();
      const svc = new InteractionService(nt, fakeSession(), () => PID);
      await svc.setMessageReaction({ groupId: '12345', sequence: 99, code: '76', isSet: true });
      await svc.setMessageReaction({ groupId: 12345, sequence: 99, code: '76', isSet: false });
      expect(nt.calls.map((c) => c.subCommand)).toEqual([1, 2]);
      expect(decode(SetReaction.reqSchema, nt.calls[0]!.body)).toEqual({
        groupUin: 12345,
        sequence: 99,
        code: '76',
        type: 1,
        field6: false,
        field7: false,
      });
    });

    it('长 code 判定为 Unicode（type=2）', async () => {
      const nt = fakeNative();
      const svc = new InteractionService(nt, fakeSession(), () => PID);
      await svc.setMessageReaction({
        groupId: '12345',
        sequence: 1,
        code: '128516',
        isSet: true,
      });
      expect(decode(SetReaction.reqSchema, nt.calls[0]!.body).type).toBe(2);
    });
  });

  describe('getMessageReactionUsers (0x9083_1)', () => {
    it('走 0x9083 / sub 1，body 字段号 2/3/4/5/8', async () => {
      const nt = fakeNative();
      const svc = new InteractionService(nt, fakeSession(), () => PID);
      await svc.getMessageReactionUsers({ groupId: '12345', sequence: 99, emojiId: '76' });
      const call = nt.calls[0]!;
      expect(call.pid).toBe(PID);
      expect(call.command).toBe(0x9083);
      expect(call.subCommand).toBe(1);
      expect(call.isUid).toBe(false);
      // 首页不传 cookie，count 缺省 10 由协议层填。
      expect(decode(GetEmojiLikes.reqSchema, call.body)).toEqual({
        groupId: 12345n,
        sequence: 99n,
        emojiType: 1,
        emojiId: '76',
        count: 10,
      });
    });

    it('长 emojiId 自动判成 Unicode（type=2），显式 emojiType 优先', async () => {
      const nt = fakeNative();
      const svc = new InteractionService(nt, fakeSession(), () => PID);
      await svc.getMessageReactionUsers({ groupId: '12345', sequence: 1, emojiId: '128516' });
      await svc.getMessageReactionUsers({
        groupId: '12345',
        sequence: 1,
        emojiId: '76',
        emojiType: 2,
        cookie: 'next',
      });
      expect(decode(GetEmojiLikes.reqSchema, nt.calls[0]!.body).emojiType).toBe(2);
      expect(decode(GetEmojiLikes.reqSchema, nt.calls[1]!.body).emojiType).toBe(2);
      // 续传 cookie 走 f6。
      expect(decode(GetEmojiLikes.reqSchema, nt.calls[1]!.body).cookie).toBe('next');
    });

    it('服务端给了昵称/头像就直接用，不再碰本地资料库', async () => {
      const resp = encode(GetEmojiLikes.respSchema, {
        users: [{ uin: 10001, nick: '服务端昵称', headUrl: 'https://cdn/1' }],
        cookie: 'next',
        isLast: false,
      });
      const svc = new InteractionService(
        fakeNative(resp),
        fakeSession({ '10001': { nick: '本地昵称', avatarUrl: 'https://local/1' } }),
        () => PID,
      );
      const page = await svc.getMessageReactionUsers({
        groupId: '12345',
        sequence: 1,
        emojiId: '76',
      });
      expect(page).toEqual({
        users: [{ uin: '10001', nick: '服务端昵称', avatarUrl: 'https://cdn/1' }],
        cookie: 'next',
        isLast: false,
      });
    });

    it('服务端字段为空时用本地备注/头像补，本地也没有则留空串', async () => {
      const resp = encode(GetEmojiLikes.respSchema, {
        users: [{ uin: 10001 }, { uin: 20002, nick: '半个昵称' }, { uin: 30003 }],
      });
      const svc = new InteractionService(
        fakeNative(resp),
        fakeSession({
          '10001': { nick: '本地昵称', remark: '备注', avatarUrl: 'https://local/1' },
          '20002': { nick: '本地2', avatarUrl: 'https://local/2' },
        }),
        () => PID,
      );
      const page = await svc.getMessageReactionUsers({
        groupId: '12345',
        sequence: 1,
        emojiId: '76',
      });
      expect(page.users).toEqual([
        // 有备注先显示备注。
        { uin: '10001', nick: '备注', avatarUrl: 'https://local/1' },
        // 服务端给了昵称但没给头像：只补头像。
        { uin: '20002', nick: '半个昵称', avatarUrl: 'https://local/2' },
        // 本地查无此人：留给渲染层退化成 QQ 号 + qlogo。
        { uin: '30003', nick: '', avatarUrl: '' },
      ]);
      // 空 ack：名单为空、cookie 为空、isLast=true。
      expect(page.cookie).toBe('');
      expect(page.isLast).toBe(true);
    });
  });

  describe('sendGroupSignup (0x921b_0)', () => {
    it('走 0x921b / sub 0，groupCode 与标题详情进 body', async () => {
      const nt = fakeNative();
      const svc = new InteractionService(nt, fakeSession(), () => PID);
      await svc.sendGroupSignup({ groupCode: '673646675', title: '找搭子', detail: '一起去' });
      const call = nt.calls[0]!;
      expect(call.command).toBe(0x921b);
      expect(call.subCommand).toBe(0);
      const decoded = decode(SendGroupSignup.reqSchema, call.body) as {
        request: { groupCode: bigint; title: string; detail: string };
      };
      expect(decoded.request.groupCode).toBe(673646675n);
      expect(decoded.request.title).toBe('找搭子');
      expect(decoded.request.detail).toBe('一起去');
    });

    it('PC/Linux 的 319 平台拒绝被翻译成可读错误（不静默成功）', async () => {
      const nt = fakeNative();
      nt.sendOidbPacket = async () => {
        throw new Error(
          'Reply status error: 319 ([oidb] rule type not match appid,https://iwiki.woa.com/x)',
        );
      };
      const svc = new InteractionService(nt, fakeSession(), () => PID);
      await expect(
        svc.sendGroupSignup({ groupCode: '673646675', title: 't', detail: 'd' }),
      ).rejects.toThrow(/319 .*rule type not match appid/);
      await expect(
        svc.sendGroupSignup({ groupCode: '673646675', title: 't', detail: 'd' }),
      ).rejects.toThrow(/不是参数写错/);
    });
  });
});
