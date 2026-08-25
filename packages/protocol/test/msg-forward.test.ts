/**
 * msg/get-forward 的离线单元测试：
 *   - SsoRecvLongMsg 请求编码（黄金字节，手工按 wire format 构造）
 *   - 响应 -> gzip payload -> LongMsgResult -> MultiMsg msgBody 全链路
 *   - extractPath 抠第一条 / 指定条消息原始字节
 *   - decodeMessage 解析转发消息的 dress（bubble / font / widget）
 */

import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { encode } from '../src/protobuf';
import { extractPath } from '../src/msg/dump';
import {
  LONG_MSG_RESULT,
  PUSH_MSG_BODY,
  RECV_LONG_MSG_RESP,
  RecvLongMsg,
  SSO_RECV_LONG_MSG_CMD,
  decodeMessage,
  fetchForwardRaw,
  type ForwardFetchResult,
} from '../src/index';

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((h) => Number.parseInt(h, 16)),
  );

describe('请求编码（黄金字节）', () => {
  it('SsoRecvLongMsg：info{uid.uid,resId,acquire=true} + settings{field1=2}', () => {
    const bytes = encode(
      RecvLongMsg.reqSchema,
      RecvLongMsg.serialize({ selfUid: 'u_abc', resId: 'res123' }),
    );
    expect(Array.from(bytes)).toEqual(
      Array.from(
        hexToBytes('0a 13 0a 07 12 05 75 5f 61 62 63 12 06 72 65 73 31 32 33 18 01 7a 02 08 02'),
      ),
    );
  });
});

// 一条带 dress 的 PushMsgBody：generalFlags{widgetId=17,font.fontId1=56} +
// bubble{id=9} + text("hi")，responseHead.fromUin=12345。
const DRESS_MSG_OBJ = {
  responseHead: { fromUin: 12345, fromUid: 'u_sender' },
  contentHead: { msgType: 1, sequence: 7, timestamp: 1700000000 },
  body: {
    richText: {
      elems: [
        { generalFlags: { widgetId: 17, font: { fontId1: 56 } } },
        { bubble: { id: 9 } },
        { text: { str: 'hi' } },
      ],
    },
  },
};
const DRESS_MSG = encode(PUSH_MSG_BODY, DRESS_MSG_OBJ);

const SECOND_MSG_OBJ = {
  responseHead: { fromUin: 67890 },
  contentHead: { msgType: 1, sequence: 8 },
  body: { richText: { elems: [{ text: { str: 'second' } }] } },
};
const SECOND_MSG = encode(PUSH_MSG_BODY, SECOND_MSG_OBJ);

// 构造完整响应：RecvLongMsgResp.result.payload = gzip(LongMsgResult)。
const longMsgBytes = encode(LONG_MSG_RESULT, {
  action: [
    { actionCommand: 'MultiMsg', actionData: { msgBody: [DRESS_MSG_OBJ, SECOND_MSG_OBJ] } },
    { actionCommand: 'some-uuid', actionData: { msgBody: [SECOND_MSG_OBJ] } },
  ],
});
const RESP_BYTES = encode(RECV_LONG_MSG_RESP, {
  result: { resId: 'res123', payload: gzipSync(Buffer.from(longMsgBytes)) },
});

const stubNative = {
  sendPacket: async (_pid: number, _cmd: string, _body: Buffer): Promise<Buffer> =>
    Buffer.from(RESP_BYTES),
};

describe('fetchForwardRaw 全链路', () => {
  it('响应解码 + gzip 解压 + MultiMsg 消息列表', async () => {
    const res = await fetchForwardRaw(stubNative, 1, { selfUid: 'u_self', resId: 'res123' });
    expect(res.cmd).toBe(SSO_RECV_LONG_MSG_CMD);
    expect(res.resId).toBe('res123');
    expect(res.error).toBeUndefined();
    expect(res.decodedResponse).toBeTruthy();
    expect(res.payload).not.toBeNull();
    expect(res.inflated).not.toBeNull();
    expect(Array.from(res.inflated!)).toEqual(Array.from(longMsgBytes));
    expect(res.actions).toHaveLength(2);
    expect((res.actions[0] as { actionCommand?: string }).actionCommand).toBe('MultiMsg');
    expect(res.messages).toHaveLength(2);
    expect(res.firstMessageBytes).not.toBeNull();
    expect(Array.from(res.firstMessageBytes!)).toEqual(Array.from(DRESS_MSG));
  });

  it('extractPath 可抠指定条消息原始字节（--index 路径）', () => {
    const multiMsgIndex = 0;
    const second = extractPath(longMsgBytes, [
      { tag: 2, index: multiMsgIndex },
      { tag: 2 },
      { tag: 1, index: 1 },
    ]);
    expect(second).not.toBeNull();
    expect(Array.from(second!)).toEqual(Array.from(SECOND_MSG));
  });

  it('decodeMessage 解析出转发消息的 dress', async () => {
    const res = await fetchForwardRaw(stubNative, 1, { selfUid: 'u_self', resId: 'res123' });
    const decoded = decodeMessage(res.firstMessageBytes!);
    expect(decoded.dress).toEqual({ bubble: 9, font: 56, widget: 17 });
    expect(decoded.head.sequence).toBe(7);
    expect(decoded.sender.uin).toBe(12345);
    const texts = decoded.elements.filter((e) => (e as { kind?: string }).kind === 'text');
    expect((texts[0] as { textContent?: string }).textContent).toBe('hi');
  });

  it('payload 为空时保留原始响应并给出 error', async () => {
    const empty = encode(RECV_LONG_MSG_RESP, { result: { resId: 'res123' } });
    const nt = {
      sendPacket: async (_pid: number, _cmd: string, _body: Buffer): Promise<Buffer> =>
        Buffer.from(empty),
    };
    const res: ForwardFetchResult = await fetchForwardRaw(nt, 1, {
      selfUid: 'u_self',
      resId: 'res123',
    });
    expect(res.error).toMatch(/payload/);
    expect(res.messages).toHaveLength(0);
    expect(res.rawResponse.length).toBe(empty.length);
  });
});
