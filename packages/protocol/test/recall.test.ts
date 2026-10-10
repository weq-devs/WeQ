/**
 * 消息撤回（SsoGroupRecallMsg / SsoC2CRecallMsg）离线单元测试：命令串 + needSign +
 * 请求编码。
 *
 * 对照 SnowLuma `core/src/bridge/apis/message.ts` recallGroup / recallPrivate。
 * 签名：白名单里只有 SsoC2CRecallMsg，所以群聊不签名、私聊签名。
 */

import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/protobuf';
import { RecallGroup, RecallPrivate } from '../src/index';

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((h) => Number.parseInt(h, 16)),
  );

interface TrpcCall {
  pid: number;
  cmd: string;
  body: Uint8Array;
  needSign: boolean;
}

function makeNative() {
  const calls: TrpcCall[] = [];
  return {
    calls,
    sendPacket: async (
      pid: number,
      cmd: string,
      body: Buffer,
      needSign: boolean,
    ): Promise<Buffer> => {
      calls.push({ pid, cmd, body: new Uint8Array(body), needSign });
      return Buffer.alloc(0);
    },
  };
}

describe('RecallGroup (SsoGroupRecallMsg)', () => {
  it('命令串 + needSign=false（不在白名单）', () => {
    expect(RecallGroup.cmd).toBe('trpc.msg.msg_svc.MsgService.SsoGroupRecallMsg');
    expect(RecallGroup.needSign).toBe(false);
  });

  it('编码：type@1 / groupUin@2 / info{ sequence@1 }@3 / settings@4', () => {
    const bytes = encode(
      RecallGroup.reqSchema,
      RecallGroup.serialize({ groupId: 100, sequence: 5 }),
    );
    expect(bytes).toEqual(hexToBytes('08 01 10 64 1a 02 08 05 22 00'));
    // proto3 默认省略 0：info 里只有 sequence、settings 是空 message（22 00）。
    expect(decode(RecallGroup.reqSchema, bytes)).toEqual({
      type: 1,
      groupUin: 100,
      info: { sequence: 5 },
      settings: {},
    });
  });

  it('路由到 raw SSO + needSign=false', async () => {
    const nt = makeNative();
    await RecallGroup.invoke(nt, 9, { groupId: 100, sequence: 5 });
    expect(nt.calls).toHaveLength(1);
    expect(nt.calls[0]).toMatchObject({ pid: 9, cmd: RecallGroup.cmd, needSign: false });
  });

  it('非法参数在编码前报错', () => {
    expect(() => RecallGroup.serialize({ groupId: 0, sequence: 5 })).toThrow(/groupId/);
    expect(() => RecallGroup.serialize({ groupId: 100, sequence: 0 })).toThrow(/sequence/);
  });
});

describe('RecallPrivate (SsoC2CRecallMsg)', () => {
  it('命令串 + needSign=true（白名单）', () => {
    expect(RecallPrivate.cmd).toBe('trpc.msg.msg_svc.MsgService.SsoC2CRecallMsg');
    expect(RecallPrivate.needSign).toBe(true);
  });

  it('messageId = (0x01000000 << 32) | random，type=1，targetUid@3', () => {
    const bytes = encode(
      RecallPrivate.reqSchema,
      RecallPrivate.serialize({
        targetUid: 'u_x',
        clientSequence: 1,
        messageSequence: 2,
        random: 3,
        timestamp: 4,
      }),
    );
    const decoded = decode(RecallPrivate.reqSchema, bytes) as {
      type: number;
      targetUid: string;
      info: {
        clientSequence: number;
        messageSequence: number;
        timestamp: number;
        messageId: bigint;
      };
    };
    expect(decoded.type).toBe(1);
    expect(decoded.targetUid).toBe('u_x');
    expect(decoded.info.clientSequence).toBe(1);
    expect(decoded.info.messageSequence).toBe(2);
    expect(decoded.info.timestamp).toBe(4);
    expect(decoded.info.messageId).toBe((0x01000000n << 32n) | 3n);
  });

  it('路由到 raw SSO + needSign=true', async () => {
    const nt = makeNative();
    await RecallPrivate.invoke(nt, 9, {
      targetUid: 'u_x',
      clientSequence: 1,
      messageSequence: 2,
      random: 3,
      timestamp: 4,
    });
    expect(nt.calls[0]).toMatchObject({ pid: 9, cmd: RecallPrivate.cmd, needSign: true });
  });
});
