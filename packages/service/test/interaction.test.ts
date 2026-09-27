/**
 * InteractionService 的离线单测：目标解析（群号 / QQ 号 / uid）+ 两条 OIDB 的
 * 报文断言（0xED3_1 戳一戳、0x9082_1/2 贴表情）。
 *
 * 用记账 native 打桩，断言真正上 wire 的 inner body 与 command/subCommand，
 * 不连任何网络。
 */

import { describe, expect, it } from 'vitest';
import { decode, SendPoke, SetReaction } from '@weq/protocol';
import type { AccountSession } from '@weq/account';
import { InteractionService } from '../src/account/interaction';

/** 最小会话替身：只提供 uidMap。 */
function fakeSession(): AccountSession {
  return {
    context: { uin: 10001 },
    uidMap: {
      uidByUin: (uin: bigint) => (uin === 20002n ? 'u_friend' : undefined),
      uinByUid: (uid: string) => (uid === 'u_friend' ? 20002n : undefined),
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

function fakeNative() {
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
      return Buffer.alloc(0); // 空 ack
    },
  };
}

const PID = 4321;

describe('InteractionService', () => {
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
});
