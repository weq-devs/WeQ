/**
 * SendGroupJoinRequest (OIDB 0x11ec_1) 的离线单元测试。
 *
 * 1. 用**真机抓包**的 request 字节喂给 schema，逐字段核对（证明字段号/类型对得上）；
 * 2. 抓包 request 解码后再编码，逐字节还原（证明 force 字段与字段顺序一致）；
 * 3. 用「抓包值 + answer='喵'」编码，逐字节对上（auth_key 透传、answer 可为中文）；
 * 4. 参数校验（groupCode / authKey 必填）。
 *
 * 抓包来源（2026-10-15）：群号 142598355；field3 = ""（空 answer），
 * field5(authKey) = `rBklRBfbSj5gfZ7fx9/48OnjUtROIC+kE13enEI09ndvwd9PWuRmseA2WjLoIVFU`。
 */

import { describe, expect, it } from 'vitest';
import { decode, encode, type ProtoMessage } from '../src/protobuf';
import { SendGroupJoinRequest } from '../src/index';
import type { SendGroupJoinRequestParams } from '../src/index';

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((h) => Number.parseInt(h, 16)),
  );

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');

/** 抓包密码原值：64 个 ASCII 字符的 base64（解出 48 字节）。 */
const CAPTURED_AUTH_KEY = 'rBklRBfbSj5gfZ7fx9/48OnjUtROIC+kE13enEI09ndvwd9PWuRmseA2WjLoIVFU';

/** 真机抓包：body.f2（request）的 251 字节。 */
const CAPTURED_REQUEST_HEX = `
  08 01 10 A1 1F 1A 00 22 A9 01 3C 3F 78 6D 6C 20
  76 65 72 73 69 6F 6E 3D 22 31 2E 30 22 20 65 6E
  63 6F 64 69 6E 67 3D 22 75 74 66 2D 38 22 3F 3E
  0A 3C 6D 73 67 20 74 65 6D 70 6C 61 74 65 49 44
  3D 22 31 22 20 62 72 69 65 66 3D 22 22 20 73 65
  72 76 69 63 65 49 44 3D 22 31 30 34 22 3E 3C 69
  74 65 6D 20 6C 61 79 6F 75 74 3D 22 32 22 3E 3C
  70 69 63 74 75 72 65 20 63 6F 76 65 72 3D 22 22
  2F 3E 3C 74 69 74 6C 65 3E E6 96 B0 E4 BA BA E5
  85 A5 E7 BE A4 3C 2F 74 69 74 6C 65 3E 3C 2F 69
  74 65 6D 3E 3C 73 6F 75 72 63 65 2F 3E 3C 2F 6D
  73 67 3E 2A 40 72 42 6B 6C 52 42 66 62 53 6A 35
  67 66 5A 37 66 78 39 2F 34 38 4F 6E 6A 55 74 52
  4F 49 43 2B 6B 45 31 33 65 6E 45 49 30 39 6E 64
  76 77 64 39 50 57 75 52 6D 73 65 41 32 57 6A 4C
  6F 49 56 46 55 32 00 3A 00 42 00
`;

/** 真机抓包：body 的 259 字节（f1 = groupCode，f2 = request）。 */
const CAPTURED_BODY_HEX = `
  08 D3 C1 FF 43 12 FB 01 08 01 10 A1 1F 1A 00 22
  A9 01 3C 3F 78 6D 6C 20 76 65 72 73 69 6F 6E 3D
  22 31 2E 30 22 20 65 6E 63 6F 64 69 6E 67 3D 22
  75 74 66 2D 38 22 3F 3E 0A 3C 6D 73 67 20 74 65
  6D 70 6C 61 74 65 49 44 3D 22 31 22 20 62 72 69
  65 66 3D 22 22 20 73 65 72 76 69 63 65 49 44 3D
  22 31 30 34 22 3E 3C 69 74 65 6D 20 6C 61 79 6F
  75 74 3D 22 32 22 3E 3C 70 69 63 74 75 72 65 20
  63 6F 76 65 72 3D 22 22 2F 3E 3C 74 69 74 6C 65
  3E E6 96 B0 E4 BA BA E5 85 A5 E7 BE A4 3C 2F 74
  69 74 6C 65 3E 3C 2F 69 74 65 6D 3E 3C 73 6F 75
  72 63 65 2F 3E 3C 2F 6D 73 67 3E 2A 40 72 42 6B
  6C 52 42 66 62 53 6A 35 67 66 5A 37 66 78 39 2F
  34 38 4F 6E 6A 55 74 52 4F 49 43 2B 6B 45 31 33
  65 6E 45 49 30 39 6E 64 76 77 64 39 50 57 75 52
  6D 73 65 41 32 57 6A 4C 6F 49 56 46 55 32 00 3A
  00 42 00
`;

/** body.f2 的 schema（抓包里 request 那一层）。 */
const REQUEST_SCHEMA = SendGroupJoinRequest.reqSchema.fields[1]!.type as ProtoMessage;

interface DecodedRequest {
  field1: number;
  sourceId: number;
  answer: string;
  richMsg: string;
  authKey: string;
  field6: Record<string, unknown>;
  field7: Record<string, unknown>;
  field8: Record<string, unknown>;
}

describe('SendGroupJoinRequest (0x11ec_1)', () => {
  it('声明 command 0x11ec / subCommand 1 / needSign true', () => {
    expect(SendGroupJoinRequest.command).toBe(0x11ec);
    expect(SendGroupJoinRequest.subCommand).toBe(1);
    expect(SendGroupJoinRequest.needSign).toBe(true);
  });

  it('能逐字段解出真机抓包的 request', () => {
    const decoded = decode(
      REQUEST_SCHEMA,
      hexToBytes(CAPTURED_REQUEST_HEX),
    ) as unknown as DecodedRequest;
    expect(decoded.field1).toBe(1);
    expect(decoded.sourceId).toBe(4001);
    expect(decoded.answer).toBe('');
    expect(String(decoded.richMsg).includes('<title>新人入群</title>')).toBe(true);
    expect(decoded.authKey).toBe(CAPTURED_AUTH_KEY);
    expect(decoded.field6).toEqual({});
    expect(decoded.field7).toEqual({});
    expect(decoded.field8).toEqual({});
  });

  it('抓包 request 解码后再编码，逐字节还原（force 字段 / 字段顺序一致）', () => {
    const bytes = hexToBytes(CAPTURED_REQUEST_HEX);
    const decoded = decode(REQUEST_SCHEMA, bytes);
    expect(bytesToHex(encode(REQUEST_SCHEMA, decoded))).toBe(bytesToHex(bytes));
  });

  it('serialize 出的整条 body（含 groupCode）逐字节等于抓包', () => {
    const params: SendGroupJoinRequestParams = {
      groupCode: 142598355,
      authKey: CAPTURED_AUTH_KEY,
    };
    const body = encode(SendGroupJoinRequest.reqSchema, SendGroupJoinRequest.serialize(params));
    expect(bytesToHex(body)).toBe(bytesToHex(hexToBytes(CAPTURED_BODY_HEX)));
  });

  it('用抓包参数编码，逐字节还原整条 request（answer 空）', () => {
    const params: SendGroupJoinRequestParams = { groupCode: 142598355, authKey: CAPTURED_AUTH_KEY };
    const body = encode(SendGroupJoinRequest.reqSchema, SendGroupJoinRequest.serialize(params));
    // body = f1(groupCode) + f2(request)；取 f2 之后的 request 字节与抓包比对
    const decoded = decode(SendGroupJoinRequest.reqSchema, body) as unknown as {
      request: unknown;
    };
    expect(bytesToHex(encode(REQUEST_SCHEMA, decoded.request as Record<string, unknown>))).toBe(
      bytesToHex(hexToBytes(CAPTURED_REQUEST_HEX)),
    );
  });

  it('answer 用中文「喵」也能编码（UTF-8，f3 force 上 wire）', () => {
    const params: SendGroupJoinRequestParams = {
      groupCode: 142598355,
      answer: '喵',
      authKey: CAPTURED_AUTH_KEY,
    };
    const bytes = encode(SendGroupJoinRequest.reqSchema, SendGroupJoinRequest.serialize(params));
    const decoded = decode(SendGroupJoinRequest.reqSchema, bytes) as unknown as {
      request: DecodedRequest;
    };
    expect(decoded.request.answer).toBe('喵');
    // f3 = `1a 03 e5 96 b5`，抓包里是 `1a 00`；request 因此长 3 字节。
    const requestBytes = encode(
      REQUEST_SCHEMA,
      decoded.request as unknown as Record<string, unknown>,
    );
    expect(requestBytes.length).toBe(hexToBytes(CAPTURED_REQUEST_HEX).length + 3);
    // 抓包里 f3 = `1a 00`（空 answer，位于 offset 5..6）；新包里换成 `1a 03 e5 96 b5`，
    // 其余字节逐字节不变。
    const captured = hexToBytes(CAPTURED_REQUEST_HEX);
    const expected = new Uint8Array([
      ...captured.slice(0, 6), // 到 `1a`（f3 tag）为止，不含空的长度字节 00
      3,
      0xe5,
      0x96,
      0xb5, // 喵
      ...captured.slice(7), // f4 起
    ]);
    expect(bytesToHex(requestBytes)).toBe(bytesToHex(expected));
  });

  it('用抓包参数编码整条 body（groupCode + request），逐字节还原抓包', () => {
    const params: SendGroupJoinRequestParams = {
      groupCode: 142598355,
      authKey: CAPTURED_AUTH_KEY,
    };
    const body = encode(SendGroupJoinRequest.reqSchema, SendGroupJoinRequest.serialize(params));
    const decoded = decode(SendGroupJoinRequest.reqSchema, body) as unknown as {
      groupCode: bigint;
      request: unknown;
    };
    expect(decoded.groupCode).toBe(142598355n);
    // body = f1(groupCode) + f2(request)；request 逐字节等于抓包，整条 body 也照此复原。
    expect(bytesToHex(encode(REQUEST_SCHEMA, decoded.request as Record<string, unknown>))).toBe(
      bytesToHex(hexToBytes(CAPTURED_REQUEST_HEX)),
    );
  });

  it('groupCode 非正 / authKey 缺失时抛错', () => {
    expect(() => SendGroupJoinRequest.serialize({ groupCode: 0, authKey: 'x' })).toThrow();
    expect(() => SendGroupJoinRequest.serialize({ groupCode: 1, authKey: '' })).toThrow(/authKey/);
  });
});
