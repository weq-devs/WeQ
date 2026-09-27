/**
 * 推荐好友 / 推荐群 Ark 卡片（取卡 + 发送）的离线单测。
 *
 * 搬运自 SnowLuma 的两个取卡服务（0x12b6_0 好友 / 0x8b7_5 群），字段布局与其
 * `get-buddy-recommend-ark.ts` / `get-group-recommend-ark.ts` 的 byte-oracle
 * 完全一致；这里额外覆盖「取到卡 → 直接发」的第二步：
 *   - 取卡走 OidbSvcTrpcTcp（uinForm：好友 false / 群 true，别抄反）；
 *   - 发送走 MessageSvc.PbSendMsg，卡片是 lightApp 元素（deflate 后的 ark JSON）。
 */

import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  decode,
  encode,
  GetBuddyRecommendArk,
  GetGroupRecommendArk,
  getContactArk,
  ELEM,
  sendBuddyContactArk,
  sendContactArk,
  sendGroupContactArk,
  SEND_MESSAGE_REQUEST,
  SEND_MESSAGE_RESPONSE,
  SEND_MSG_CMD,
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
interface PacketCall {
  pid: number;
  cmd: string;
  body: Uint8Array;
}

/** 假 native：OIDB 按 command 分发取卡回包，SSO 包返回一条发送成功回执。 */
function makeNative(arkByCommand: Map<number, string>) {
  const oidbCalls: OidbCall[] = [];
  const packetCalls: PacketCall[] = [];
  const ack = encode(SEND_MESSAGE_RESPONSE, {
    result: 0,
    timestamp1: 1700000001,
    groupSequence: 777,
    privateSequence: 888,
  });
  return {
    oidbCalls,
    packetCalls,
    sendOidbPacket: async (
      pid: number,
      command: number,
      subCommand: number,
      body: Buffer,
      isUid: boolean,
    ): Promise<Buffer> => {
      oidbCalls.push({ pid, command, subCommand, body: new Uint8Array(body), isUid });
      const ark = arkByCommand.get(command) ?? '';
      const resp =
        command === 0x12b6
          ? encode(GetBuddyRecommendArk.respSchema, { ark })
          : encode(GetGroupRecommendArk.respSchema, { arkJson: ark });
      return Buffer.from(resp);
    },
    sendPacket: async (pid: number, cmd: string, body: Buffer): Promise<Buffer> => {
      packetCalls.push({ pid, cmd, body: new Uint8Array(body) });
      return Buffer.from(ack);
    },
  };
}

const BUDDY_ARK = '{"app":"com.tencent.contact.lua","meta":{"contact":{"type":"qq","id":"10000"}}}';
const GROUP_ARK =
  '{"app":"com.tencent.contact.lua","meta":{"contact":{"type":"group","id":"555"}}}';

describe('取卡 0x12b6_0（推荐好友）', () => {
  it('声明 command/subCommand/uinForm（普通信封，非 uin-form）', () => {
    expect(GetBuddyRecommendArk.command).toBe(0x12b6);
    expect(GetBuddyRecommendArk.subCommand).toBe(0);
    expect(GetBuddyRecommendArk.uinForm).toBe(false);
  });

  it('黄金字节：uin(1) + phone 占位 "-"(2) + 内核硬编码 jumpUrl(3)', () => {
    const bytes = encode(
      GetBuddyRecommendArk.reqSchema,
      GetBuddyRecommendArk.serialize({ uin: 10000 }),
    );
    expect(bytes).toEqual(
      hexToBytes(`
        08 90 4e 12 01 2d 1a 51 6d 71 71 61 70 69 3a 2f 2f 63 61 72 64 2f 73 68
        6f 77 5f 70 73 6c 63 61 72 64 3f 73 72 63 5f 74 79 70 65 3d 69 6e 74 65
        72 6e 61 6c 26 73 6f 75 72 63 65 3d 73 68 61 72 65 63 61 72 64 26 76 65
        72 73 69 6f 6e 3d 31 26 75 69 6e 3d 31 30 30 30 30
      `),
    );
  });

  it('手机号给了就用真值，空串回落 "-"', () => {
    expect(GetBuddyRecommendArk.serialize({ uin: 7, phoneNumber: '123' }).phoneNumber).toBe('123');
    expect(GetBuddyRecommendArk.serialize({ uin: 7, phoneNumber: '' }).phoneNumber).toBe('-');
  });

  it('invoke 走 sendOidbPacket，透传 command/subCommand/isUid 并解出 ark', async () => {
    const nt = makeNative(new Map([[0x12b6, BUDDY_ARK]]));
    const ark = await GetBuddyRecommendArk.invoke(nt, 4242, { uin: 10000 });
    expect(ark).toBe(BUDDY_ARK);
    const call = nt.oidbCalls[0]!;
    expect(call.pid).toBe(4242);
    expect(call.command).toBe(0x12b6);
    expect(call.subCommand).toBe(0);
    expect(call.isUid).toBe(false);
  });

  it('响应缺 ark 字段时返回空串（不炸、也不假装有卡）', () => {
    expect(GetBuddyRecommendArk.deserialize({})).toBe('');
  });
});

describe('取卡 0x8b7_5（推荐群）', () => {
  it('声明 command/subCommand/uinForm（uin-form 信封）', () => {
    expect(GetGroupRecommendArk.command).toBe(0x8b7);
    expect(GetGroupRecommendArk.subCommand).toBe(5);
    expect(GetGroupRecommendArk.uinForm).toBe(true);
  });

  it('黄金字节：reqType=1(1) + groupCode(2) + flag=1(5)', () => {
    const bytes = encode(
      GetGroupRecommendArk.reqSchema,
      GetGroupRecommendArk.serialize({ groupId: 123456789 }),
    );
    expect(bytes).toEqual(hexToBytes('08 01 10 95 9a ef 3a 28 01'));
  });

  it('invoke 走 uin-form 信封并解出 arkJson', async () => {
    const nt = makeNative(new Map([[0x8b7, GROUP_ARK]]));
    const ark = await GetGroupRecommendArk.invoke(nt, 4242, { groupId: 555 });
    expect(ark).toBe(GROUP_ARK);
    const call = nt.oidbCalls[0]!;
    expect(call.command).toBe(0x8b7);
    expect(call.subCommand).toBe(5);
    expect(call.isUid).toBe(true);
  });
});

describe('getContactArk 取卡路由', () => {
  it('kind=qq 走 0x12b6_0，kind=group 走 0x8b7_5', async () => {
    const nt = makeNative(
      new Map([
        [0x12b6, BUDDY_ARK],
        [0x8b7, GROUP_ARK],
      ]),
    );
    expect(await getContactArk(nt, 1, { kind: 'qq', contactId: 10000 })).toBe(BUDDY_ARK);
    expect(await getContactArk(nt, 1, { kind: 'group', contactId: 555 })).toBe(GROUP_ARK);
    expect(nt.oidbCalls.map((c) => c.command)).toEqual([0x12b6, 0x8b7]);
  });
});

describe('sendContactArk 取卡 → 直接发送', () => {
  it('两步都跑了：先 OIDB 取卡，再 PbSendMsg 发 lightApp 卡片到群', async () => {
    const nt = makeNative(new Map([[0x12b6, BUDDY_ARK]]));
    const result = await sendContactArk(nt, 4242, {
      peerType: 'group',
      targetId: 666,
      kind: 'qq',
      contactId: 10000,
    });

    expect(result.arkJson).toBe(BUDDY_ARK);
    expect(result.kind).toBe('qq');
    expect(result.contactId).toBe(10000);
    expect(result.receipt.ok).toBe(true);
    expect(result.receipt.scene).toBe('group');

    // 第 1 步：取卡
    expect(nt.oidbCalls).toHaveLength(1);
    expect(nt.oidbCalls[0]!.command).toBe(0x12b6);
    // 第 2 步：发送
    expect(nt.packetCalls).toHaveLength(1);
    expect(nt.packetCalls[0]!.cmd).toBe(SEND_MSG_CMD);

    const sent = decode(SEND_MESSAGE_REQUEST, nt.packetCalls[0]!.body) as {
      routingHead: { grp: { groupCode: bigint } };
      messageBody: { richText: { elems: Record<string, unknown>[] } };
    };
    expect(sent.routingHead.grp.groupCode).toBe(666n);

    // 卡片本体：lightApp.data = 0x01 头 + deflate(ark JSON)，原样就是取到的那份。
    const elem = decode(ELEM, encode(ELEM, sent.messageBody.richText.elems[0]!)) as {
      lightApp: { data: Uint8Array };
    };
    const payload = Buffer.from(elem.lightApp.data);
    expect(payload[0]).toBe(0x01);
    expect(inflateSync(payload.subarray(1)).toString('utf8')).toBe(BUDDY_ARK);
  });

  it('私聊发送：routingHead.c2c 用 userUin，可带 userUid', async () => {
    const nt = makeNative(new Map([[0x8b7, GROUP_ARK]]));
    const result = await sendContactArk(nt, 4242, {
      peerType: 'c2c',
      targetId: 10000,
      kind: 'group',
      contactId: 555,
      userUid: 'u_abc',
    });
    expect(result.receipt.scene).toBe('c2c');
    const sent = decode(SEND_MESSAGE_REQUEST, nt.packetCalls[0]!.body) as {
      routingHead: { c2c: { uin: number; uid?: string } };
    };
    expect(sent.routingHead.c2c).toEqual({ uin: 10000, uid: 'u_abc' });
  });

  it('sendBuddyContactArk / sendGroupContactArk 是 kind 预置的薄封装', async () => {
    const nt = makeNative(
      new Map([
        [0x12b6, BUDDY_ARK],
        [0x8b7, GROUP_ARK],
      ]),
    );
    const buddy = await sendBuddyContactArk(nt, 1, {
      peerType: 'group',
      targetId: 2,
      contactId: 3,
    });
    expect(buddy.kind).toBe('qq');
    expect(buddy.arkJson).toBe(BUDDY_ARK);

    const group = await sendGroupContactArk(nt, 1, {
      peerType: 'group',
      targetId: 2,
      contactId: 3,
    });
    expect(group.kind).toBe('group');
    expect(group.arkJson).toBe(GROUP_ARK);
  });

  it('取到空卡时不发送，直接报错（不发空白卡）', async () => {
    const nt = makeNative(new Map());
    await expect(
      sendContactArk(nt, 1, { peerType: 'group', targetId: 2, kind: 'qq', contactId: 3 }),
    ).rejects.toThrow(/ark JSON 为空/);
    expect(nt.packetCalls).toHaveLength(0);
  });

  it('targetId / contactId 非法时在取卡前就报错', async () => {
    const nt = makeNative(new Map([[0x12b6, BUDDY_ARK]]));
    await expect(
      sendContactArk(nt, 1, { peerType: 'group', targetId: 0, kind: 'qq', contactId: 3 }),
    ).rejects.toThrow(/targetId 必须是正整数/);
    expect(nt.oidbCalls).toHaveLength(0);
    expect(nt.packetCalls).toHaveLength(0);
  });

  it('服务端拒绝下发时不抛，receipt.ok=false 如实透出', async () => {
    const nt = makeNative(new Map([[0x12b6, BUDDY_ARK]]));
    const ack = encode(SEND_MESSAGE_RESPONSE, { result: 12, errMsg: 'blocked' });
    nt.sendPacket = async (pid: number, cmd: string, body: Buffer): Promise<Buffer> => {
      nt.packetCalls.push({ pid, cmd, body: new Uint8Array(body) });
      return Buffer.from(ack);
    };
    const result = await sendContactArk(nt, 1, {
      peerType: 'group',
      targetId: 2,
      kind: 'qq',
      contactId: 3,
    });
    expect(result.receipt.ok).toBe(false);
    expect(result.receipt.result).toBe(12);
    expect(result.receipt.errMsg).toBe('blocked');
  });
});
