/**
 * SendPoke (0xED3_1) 的离线单元测试：请求编码（黄金字节）+ 空 ack 解析。
 *
 * 字段布局与 SnowLuma `send-poke.ts`、Lagrange `DED3ReqBody`、NapCat
 * `OidbSvcTrpcTcp0XED3_1` 三边一致：
 *   f1 uin（被戳的人）、f2 groupUin（群号）、f5 friendUin（私聊对方）、f6 ext。
 *
 * 传输层由 `@weq/native` 的 `sendOidbPacket` 负责套 OIDB 信封，所以这里直接
 * mock 该原语，断言 inner body 字节与 command/subCommand。
 */

import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/protobuf';
import { SendPoke } from '../src/index';
import type { SendPokeParams } from '../src/index';

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
      return Buffer.alloc(0); // 空 ack
    },
  };
}

const GROUP_POKE: SendPokeParams = { isGroup: true, peerUin: 12345, targetUin: 67890 };
const FRIEND_POKE: SendPokeParams = { isGroup: false, peerUin: 67890, targetUin: 11111 };

describe('SendPoke (0xED3_1)', () => {
  it('declares command 0xed3 sub 1 (SSO: OidbSvcTrpcTcp.0xed3_1)', () => {
    expect(SendPoke.command).toBe(0xed3);
    expect(SendPoke.subCommand).toBe(1);
  });

  it('群聊：groupUin = 群号，uin = 目标成员，friendUin 省略', () => {
    expect(SendPoke.serialize(GROUP_POKE)).toEqual({
      uin: 67890,
      groupUin: 12345,
      friendUin: 0,
      ext: 0,
    });
    const bytes = encode(SendPoke.reqSchema, SendPoke.serialize(GROUP_POKE));
    // f1 uin=67890 → 08 b2 92 04；f2 groupUin=12345 → 10 b9 60
    expect(bytes).toEqual(hexToBytes('08 b2 92 04 10 b9 60'));
  });

  it('私聊：friendUin（tag 5）= 对方 uin，groupUin 省略', () => {
    const bytes = encode(SendPoke.reqSchema, SendPoke.serialize(FRIEND_POKE));
    // f1 uin=11111 → 08 e7 56；f5 friendUin=67890 → 28 b2 92 04
    expect(bytes).toEqual(hexToBytes('08 e7 56 28 b2 92 04'));
  });

  it('缺省 targetUin 时 uin 回落到 peerUin', () => {
    expect(SendPoke.serialize({ isGroup: true, peerUin: 999 }).uin).toBe(999);
    expect(SendPoke.serialize({ isGroup: false, peerUin: 999 }).uin).toBe(999);
  });

  it('ext 恒为 0 且不上 wire', () => {
    expect(SendPoke.serialize(GROUP_POKE).ext).toBe(0);
    const bytes = encode(SendPoke.reqSchema, SendPoke.serialize(GROUP_POKE));
    // f6 ext 若在 wire 上会出现 tag 0x30；此处不应有。
    expect(Array.from(bytes)).not.toContain(0x30);
  });

  it('invoke 走 sendOidbPacket 并透传 pid / command / subCommand', async () => {
    const nt = makeNative();
    const result = await SendPoke.invoke(nt, 4242, GROUP_POKE);
    expect(result).toBeUndefined();
    expect(nt.calls).toHaveLength(1);
    const call = nt.calls[0]!;
    expect(call.pid).toBe(4242);
    expect(call.command).toBe(0xed3);
    expect(call.subCommand).toBe(1);
    expect(call.isUid).toBe(false);
    expect(call.body).toEqual(hexToBytes('08 b2 92 04 10 b9 60'));
  });

  it('回包按空 body 解析不报错', () => {
    expect(SendPoke.deserialize(decode(SendPoke.respSchema, new Uint8Array(0)))).toBeUndefined();
  });
});
