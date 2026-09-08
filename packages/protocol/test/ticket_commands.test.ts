/**
 * 从 nt_helper `protocol/service/*` 搬到 TS 的在线命令 spec：
 *   - FetchClientKey 0x102A_1
 *   - FetchDownloadRkeys 0x9067_202（NTV2 请求头）
 *   - RequestDecryptKey 0xCDE_2
 *   - FetchPskeyOidb 0x102A_0
 *
 * 请求字节直接对齐 Rust prost 的 encode 规则（默认值不上 wire）；响应按真实
 * 抓到的内层 body 形状断言。
 */

import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/protobuf';
import {
  FetchClientKey,
  FetchDownloadRkeys,
  FetchPskeyOidb,
  RequestDecryptKey,
} from '../src/index';

const hexBytes = (hex: string): Uint8Array =>
  Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((h) => Number.parseInt(h, 16)),
  );

describe('FetchClientKey (0x102A_1)', () => {
  it('sends an empty request body', () => {
    expect(encode(FetchClientKey.reqSchema, FetchClientKey.serialize())).toEqual(new Uint8Array());
  });

  it('applies the keyIndex / expireTime zero-defaults exactly like Rust', () => {
    // field2=19, field3="abc", field4=1800
    const decoded = decode(FetchClientKey.respSchema, hexBytes('10 13 1a 03 61 62 63 20 88 0e'));
    expect(FetchClientKey.deserialize(decoded)).toEqual({
      clientKey: 'abc',
      keyIndex: '19',
      ttlSeconds: 1800,
    });
  });
});

describe('FetchDownloadRkeys (0x9067_202)', () => {
  it('serializes the NTV2 request header exactly like prost', () => {
    const bytes = encode(FetchDownloadRkeys.reqSchema, FetchDownloadRkeys.serialize({}));
    expect(Array.from(bytes)).toEqual(
      Array.from(
        hexBytes(`
          0a 13
            0a 05 08 01 10 ca 01
            12 06 a8 06 02 b0 06 01
            1a 02 08 02
          22 06 08 0a 08 14 08 02
        `),
      ),
    );
  });

  it('parses downloadRkey response entries and drops empty rkeys', () => {
    const resp = hexBytes(`
      22 14
        0a 10 0a 08 26 72 6b 65 79 2d 31 30 10 80 f5 24 28 0a
        0a 00
    `);
    const decoded = decode(FetchDownloadRkeys.respSchema, resp);
    expect(FetchDownloadRkeys.deserialize(decoded)).toEqual([
      {
        rkey: '&rkey-10',
        type: 10,
        ttlSeconds: 604800,
        createTime: 0,
      },
    ]);
  });
});

describe('RequestDecryptKey (0xCDE_2)', () => {
  it('lowercases and wraps the db salt at field 2', () => {
    const salt = 'AB'.repeat(64);
    const bytes = encode(
      RequestDecryptKey.reqSchema,
      RequestDecryptKey.serialize({ dbSalt: salt }),
    );
    const body = new Uint8Array([
      0x12,
      0x83,
      0x01,
      0x0a,
      0x80,
      0x01,
      ...new TextEncoder().encode('ab'.repeat(64)),
    ]);
    expect(Array.from(bytes)).toEqual(Array.from(body));
  });

  it('extracts db_key from the info message', () => {
    const resp = hexBytes('12 0b 0a 09 61 62 63 64 65 66 30 31 32');
    expect(RequestDecryptKey.deserialize(decode(RequestDecryptKey.respSchema, resp))).toBe(
      'abcdef012',
    );
  });
});

describe('FetchPskeyOidb (0x102A_0)', () => {
  it('requests exactly one domain', () => {
    const bytes = encode(
      FetchPskeyOidb.reqSchema,
      FetchPskeyOidb.serialize({ domain: 'qun.qq.com' }),
    );
    expect(bytes).toEqual(new TextEncoder().encode('\x0a\x0aqun.qq.com'));
  });

  it('matches the requested domain case-sensitively', () => {
    const decoded = decode(
      FetchPskeyOidb.respSchema,
      hexBytes('0a 18 0a 0a 71 75 6e 2e 71 71 2e 63 6f 6d 12 0a 70 5f 73 6b 65 79 2d 71 75 6e'),
    );
    expect(() => FetchPskeyOidb.deserialize(decoded)).toThrow();
  });
});
