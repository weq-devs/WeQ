/**
 * GetEmojiLikes (0x9083_1) 的离线单元测试：请求编码（黄金字节）+ 路由 + 回包解析。
 *
 * 字段布局与 SnowLuma `get-emoji-likes.ts`（对齐 Windows QQ
 * `EncodeGetMsgEmojiLikesListReq` / `DecodeGetMsgEmojiLikesListRsp`）一致：
 *   f2 groupId、f3 sequence、f4 emojiType、f5 emojiId、f6 cookie、f8 count。
 * 注意 f4/f5 与 0x9082 贴表情的 f4 code / f5 type 顺序**不同**（截图见文件头注释）。
 */

import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/protobuf';
import { GetEmojiLikes } from '../src/index';
import type { GetEmojiLikesParams } from '../src/index';

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((h) => Number.parseInt(h, 16)),
  );

const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');

interface OidbCall {
  pid: number;
  command: number;
  subCommand: number;
  body: Uint8Array;
  isUid: boolean;
  needSign?: boolean;
}

function makeNative(resp: Uint8Array = new Uint8Array(0)) {
  const calls: OidbCall[] = [];
  return {
    calls,
    sendOidbPacket: async (
      pid: number,
      command: number,
      subCommand: number,
      body: Buffer,
      isUid: boolean,
      needSign?: boolean,
    ): Promise<Buffer> => {
      calls.push({ pid, command, subCommand, body: new Uint8Array(body), isUid, needSign });
      return Buffer.from(resp);
    },
  };
}

const PARAMS: GetEmojiLikesParams = {
  groupId: 12345,
  sequence: 99,
  emojiId: '76',
  count: 20,
};

describe('GetEmojiLikes (0x9083_1)', () => {
  it('declares command 0x9083 / subCommand 1，并显式关掉签名', () => {
    expect(GetEmojiLikes.command).toBe(0x9083);
    expect(GetEmojiLikes.subCommand).toBe(1);
    expect(GetEmojiLikes.needSign).toBe(false);
  });

  it('缺省 emojiType=1、count=10，首页 cookie 为空串', () => {
    const body = GetEmojiLikes.serialize({ groupId: 12345, sequence: 99, emojiId: '76' });
    expect(body.emojiType).toBe(1);
    expect(body.count).toBe(10);
    expect(body.cookie).toBe('');
  });

  it('字段号是 2/3/4/5/8：emojiType 在 emojiId 之前（与 0x9082 相反）', () => {
    const bytes = encode(GetEmojiLikes.reqSchema, GetEmojiLikes.serialize(PARAMS));
    expect(bytesToHex(bytes)).toBe('10 b9 60 18 63 20 01 2a 02 37 36 40 14');
    expect(decode(GetEmojiLikes.reqSchema, bytes)).toEqual({
      groupId: 12345n,
      sequence: 99n,
      emojiType: 1,
      emojiId: '76',
      count: 20,
    });
  });

  it('带 cookie 时把续传 cookie 写进 f6', () => {
    const bytes = encode(
      GetEmojiLikes.reqSchema,
      GetEmojiLikes.serialize({ ...PARAMS, cookie: 'next' }),
    );
    expect(decode(GetEmojiLikes.reqSchema, bytes).cookie).toBe('next');
  });

  it('参数非法时在编码前报错', () => {
    expect(() => GetEmojiLikes.serialize({ ...PARAMS, groupId: 0 })).toThrow(/groupId/);
    expect(() => GetEmojiLikes.serialize({ ...PARAMS, sequence: -1 })).toThrow(/sequence/);
    expect(() => GetEmojiLikes.serialize({ ...PARAMS, emojiId: '' })).toThrow(/emojiId/);
    expect(() => GetEmojiLikes.serialize({ ...PARAMS, count: 0 })).toThrow(/count/);
  });

  it('发到 0x9083_1、UIN-form=false、不带签名（白名单里没有 0x908x）', async () => {
    const nt = makeNative();
    await GetEmojiLikes.invoke(nt, 7, PARAMS);
    expect(nt.calls).toHaveLength(1);
    expect(nt.calls[0]).toMatchObject({
      pid: 7,
      command: 0x9083,
      subCommand: 1,
      isUid: false,
      needSign: false,
    });
  });

  it('解析回包：user 列表（uin + 昵称 + 头像）+ cookie + isLast', async () => {
    const resp = encode(GetEmojiLikes.respSchema, {
      users: [{ uin: 10001, nick: 'a', headUrl: 'http://example/1' }, { uin: 20002 }],
      cookie: 'next',
      isLast: false,
    });
    const nt = makeNative(resp);
    const result = await GetEmojiLikes.invoke(nt, 7, PARAMS);
    expect(result).toEqual({
      users: [
        { uin: 10001, nick: 'a', headUrl: 'http://example/1' },
        // 服务端没填的字段归一成空串，调用方才好判断「要不要用本地资料补」。
        { uin: 20002, nick: '', headUrl: '' },
      ],
      cookie: 'next',
      isLast: false,
    });
  });

  it('过滤 uin=0 的占位项', () => {
    const resp = encode(GetEmojiLikes.respSchema, { users: [{ uin: 0 }, { uin: 20002 }] });
    return GetEmojiLikes.invoke(makeNative(resp), 7, PARAMS).then((result) => {
      expect(result.users).toEqual([{ uin: 20002, nick: '', headUrl: '' }]);
    });
  });

  it('空 ack：users 为空、cookie 为空、isLast=true', async () => {
    const nt = makeNative();
    await expect(GetEmojiLikes.invoke(nt, 7, PARAMS)).resolves.toEqual({
      users: [],
      cookie: '',
      isLast: true,
    });
  });

  it('cookie 为空但服务端**显式**写了 isLast=false（18 00）时尊重服务端字段', async () => {
    // 注意不能用 encode({ isLast: false }) 造这个回包：proto3 会把默认值 false
    // 省掉，造出来的是空 body（= 服务端没表态，按 cookie 推断）。真机上服务端
    // 若显式写 0，wire 上是 `18 00`。
    const resp = hexToBytes('18 00');
    const result = await GetEmojiLikes.invoke(makeNative(resp), 7, PARAMS);
    expect(result).toEqual({ users: [], cookie: '', isLast: false });
  });
});
