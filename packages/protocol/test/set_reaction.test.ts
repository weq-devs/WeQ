/**
 * SetReaction (0x9082_1/2) 的离线单元测试：请求编码（黄金字节）+ 路由断言。
 *
 * 字段布局与 SnowLuma `set-reaction.ts` / Lagrange `SetGroupReactionRequest` 一致：
 *   f2 groupUin、f3 sequence、f4 code、f5 type、f6/f7 布尔。
 * type 由 code 长度决定：≤3 → 1（QQ 小黄脸短 id），>3 → 2（Unicode 码点）。
 */

import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/protobuf';
import { SetReaction } from '../src/index';
import type { SetReactionParams } from '../src/index';

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

const SET_QQ_FACE: SetReactionParams = {
  groupId: 12345,
  sequence: 99,
  code: '76',
  isSet: true,
};

describe('SetReaction (0x9082)', () => {
  it('declares command 0x9082（sub 由 isSet 决定）', () => {
    expect(SetReaction.command).toBe(0x9082);
    expect(SetReaction.resolveSubCommand(SET_QQ_FACE)).toBe(1);
    expect(SetReaction.resolveSubCommand({ ...SET_QQ_FACE, isSet: false })).toBe(2);
  });

  it('短 code → type=1（QQ 小黄脸），长 code → type=2（Unicode）', () => {
    expect(SetReaction.serialize(SET_QQ_FACE).type).toBe(1);
    expect(SetReaction.serialize({ ...SET_QQ_FACE, code: '999' }).type).toBe(1);
    expect(SetReaction.serialize({ ...SET_QQ_FACE, code: '128516' }).type).toBe(2);
  });

  it('字段号是 2..7，不是 1..4（写错服务端会报 EmojiType）', () => {
    const bytes = encode(SetReaction.reqSchema, SetReaction.serialize(SET_QQ_FACE));
    expect(bytes).toEqual(hexToBytes('10 b9 60 18 63 22 02 37 36 28 01 30 00 38 00'));
    const decoded = decode(SetReaction.reqSchema, bytes);
    expect(decoded).toEqual({
      groupUin: 12345,
      sequence: 99,
      code: '76',
      type: 1,
      field6: false,
      field7: false,
    });
  });

  it('isSet=false 走 0x9082_2、isSet=true 走 0x9082_1', async () => {
    const nt = makeNative();
    await SetReaction.invoke(nt, 7, SET_QQ_FACE);
    await SetReaction.invoke(nt, 7, { ...SET_QQ_FACE, isSet: false });
    expect(nt.calls.map((c) => c.subCommand)).toEqual([1, 2]);
    expect(nt.calls.every((c) => c.command === 0x9082)).toBe(true);
    expect(nt.calls.every((c) => c.pid === 7 && c.isUid === false)).toBe(true);
  });

  it('参数非法时在编码前报错', () => {
    expect(() => SetReaction.serialize({ ...SET_QQ_FACE, groupId: 0 })).toThrow(/groupId/);
    expect(() => SetReaction.serialize({ ...SET_QQ_FACE, sequence: -1 })).toThrow(/sequence/);
    expect(() => SetReaction.serialize({ ...SET_QQ_FACE, code: '' })).toThrow(/code/);
  });
});
