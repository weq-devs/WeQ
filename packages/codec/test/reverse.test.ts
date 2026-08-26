/**
 * Protobuf / JCE 逆向解析器测试。
 *
 * JCE 样例字节按 QQHook TarsParser 的编码规则手算：
 *   头字节：低 4 位 type、高 4 位 tag，tag==15 扩展；
 *   容器 size 用 read(0, 0, true)：一个 tag=0 的带头字段；
 *   数值大端、byte/short/int/long 带符号。
 */

import { describe, it, expect } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  decodeJce,
  decodeProtobuf,
  groupRvNodes,
  hexToBytes,
  parseInput,
  rvNodesToJson,
  rvValueToJson,
  tryDecodeJce,
  tryDecodeProtobuf,
  tryUtf8,
  twoComplement,
  type RvNode,
  type RvValue,
} from '../src/raw';

// ---------------------------------------------------------------- helpers

const HEX = (s: string): Uint8Array => {
  const out = hexToBytes(s);
  if (!out) throw new Error(`bad hex: ${s}`);
  return out;
};

const asObj = (v: RvValue): Extract<RvValue, { k: 'obj' }> => {
  if (v.k !== 'obj') throw new Error('not obj');
  return v;
};

// ---------------------------------------------------------------- 输入解码

describe('reverse input helpers', () => {
  it('hexToBytes / bytesToHex round trip', () => {
    const b = HEX('0A 16 02 68 69');
    expect(bytesToHex(b)).toBe('0a16026869');
    expect(hexToBytes('0a:16:02:68:69')).toEqual(b);
    expect(hexToBytes('xyz')).toBeNull();
    expect(hexToBytes('abc')).toBeNull();
  });

  it('base64 round trip', () => {
    const b = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const s = bytesToBase64(b);
    expect(s).toBe('AAEC+vv8/f7/');
    expect(base64ToBytes(s)).toEqual(b);
    expect(base64ToBytes('!!!')).toBeNull();
  });

  it('parseInput auto-detects hex and base64', () => {
    expect(bytesToHex(parseInput('0a 16 02 68 69'))).toBe('0a16026869');
    expect(bytesToHex(parseInput('0A:16:02:68:69', 'hex'))).toBe('0a16026869');
    expect(bytesToHex(parseInput('AAEC+vvs', 'base64'))).toBe('000102fafbec');
    expect(() => parseInput('!!!')).toThrow();
  });

  it('tryUtf8 strict check', () => {
    expect(tryUtf8(new TextEncoder().encode('hello中文'))).toBe('hello中文');
    expect(tryUtf8(new Uint8Array([0xff, 0xfe]))).toBeNull();
    expect(tryUtf8(new Uint8Array([]))).toBeNull();
  });

  it('twoComplement matches Java signed semantics', () => {
    expect(twoComplement(0xffn, 8)).toBe(-1n);
    expect(twoComplement(0x80n, 8)).toBe(-128n);
    expect(twoComplement(0xffffn, 16)).toBe(-1n);
    expect(twoComplement(0xffffffffn, 32)).toBe(-1n);
  });
});

// ---------------------------------------------------------------- protobuf

const PB_HEX =
  '08 96 01 12 02 68 69 1a 02 20 01 28 01 28 02 28 03 ' +
  '30 ff ff ff ff ff ff ff ff ff 01 39 1f 85 eb 51 b8 1e 09 40';

describe('reverse protobuf decode', () => {
  const nodes = decodeProtobuf(HEX(PB_HEX));

  it('parses top-level fields', () => {
    expect(nodes.map((n) => n.tag)).toEqual([1, 2, 3, 5, 5, 5, 6, 7]);
  });

  it('varint keeps bigint precision', () => {
    const t6 = nodes.find((n) => n.tag === 6);
    expect(t6?.value.k).toBe('int');
    if (t6?.value.k === 'int') expect(t6.value.raw).toBe(18446744073709551615n);
  });

  it('LEN fields stay bytes; nested protobuf is a conversion offer', () => {
    const t3 = nodes.find((n) => n.tag === 3);
    expect(t3?.value.k).toBe('bytes');
    if (t3?.value.k !== 'bytes') throw new Error('not bytes');
    const nested = tryDecodeProtobuf(t3.value.bytes);
    expect(nested).not.toBeNull();
    expect(rvNodesToJson(nested!)).toEqual({ '4': 1 });
  });

  it('fixed64 keeps raw bits for 3.14', () => {
    const t7 = nodes.find((n) => n.tag === 7);
    expect(t7?.value.k).toBe('fixed');
    if (t7?.value.k === 'fixed') {
      expect(bytesToHex(t7.value.bytes)).toBe('1f85eb51b81e0940');
    }
  });

  it('{tag: value} JSON: utf8 bytes as text, repeated tags as arrays', () => {
    const json = rvNodesToJson(nodes);
    expect(json['1']).toBe(150);
    expect(json['2']).toBe('hi');
    expect(json['3']).toBe('2001'); // 0x20 0x01 含控制字符 → hex
    expect(json['5']).toEqual([1, 2, 3]);
    expect(json['6']).toBe('18446744073709551615'); // 超出 2^53 → 字符串
    expect(json['7']).toBe('4614253070214989087'); // 超出 2^53 → 字符串
  });

  it('tryDecodeProtobuf rejects JCE bytes', () => {
    expect(tryDecodeProtobuf(HEX('0a 16 02 68 69 22 00 00 00 2a'))).toBeNull();
  });
});

// ---------------------------------------------------------------- JCE

/**
 * 一个完整的 JCE 结构体（顶层 STRUCT_BEGIN tag0 → ... → STRUCT_END）：
 *   tag1  STRING1 "hi"
 *   tag2  INT 42
 *   tag3  ZERO_TAG 0
 *   tag4  BYTE -1 (0xff)
 *   tag5  LONG 0x0102030405060708
 *   tag6  DOUBLE 1.5
 *   tag7  LIST[3] {1, 2, 3}   （size = tag0 INT 字段）
 *   tag8  MAP{"k":"v"}        （size = tag0 BYTE 字段）
 *   tag9  SIMPLE_LIST deadbeef
 *   tag10 STRUCT{ tag1 BYTE 7 }
 *   tag11 SIMPLE_LIST = protobuf {1:1, 2:"hi"}  ← 混合嵌套
 */
const JCE_HEX =
  '0a ' + // STRUCT_BEGIN tag0
  '16 02 68 69 ' + // 1: "hi"
  '22 00 00 00 2a ' + // 2: 42
  '3c ' + // 3: zero
  '40 ff ' + // 4: -1
  '53 01 02 03 04 05 06 07 08 ' + // 5: long
  '65 3f f8 00 00 00 00 00 00 ' + // 6: 1.5
  '79 02 00 00 00 03 00 01 00 02 00 03 ' + // 7: list
  '88 00 01 06 01 6b 16 01 76 ' + // 8: map
  '9d 00 00 04 de ad be ef ' + // 9: simple list
  'aa 10 07 0b ' + // 10: nested struct
  'bd 00 00 06 08 01 12 02 68 69 ' + // 11: simple list = protobuf
  '0b'; // STRUCT_END

describe('reverse JCE decode (QQHook TarsParser semantics)', () => {
  const nodes = decodeJce(HEX(JCE_HEX));

  it('wraps the struct as a tag-0 obj field (对齐 QQHook)', () => {
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.tag).toBe(0);
    const fields = asObj(nodes[0]!.value).fields;
    expect(fields.map((n) => n.tag)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('decodes scalars with Java big-endian signed semantics', () => {
    const fields = asObj(nodes[0]!.value).fields;
    expect(rvValueToJson(fields[0]!.value)).toBe('hi');
    expect(rvValueToJson(fields[1]!.value)).toBe(42);
    expect(rvValueToJson(fields[2]!.value)).toBe(0);
    expect(rvValueToJson(fields[3]!.value)).toBe(-1);
    expect(rvValueToJson(fields[4]!.value)).toBe('72623859790382856');
    expect(rvValueToJson(fields[5]!.value)).toBe(1.5);
  });

  it('decodes LIST with head-based size', () => {
    const fields = asObj(nodes[0]!.value).fields;
    const v = fields[6]!.value;
    expect(v.k).toBe('list');
    if (v.k === 'list') {
      expect(v.items.map((it) => rvValueToJson(it.value))).toEqual([1, 2, 3]);
    }
  });

  it('decodes MAP', () => {
    const fields = asObj(nodes[0]!.value).fields;
    const v = fields[7]!.value;
    expect(v.k).toBe('map');
    if (v.k === 'map') {
      expect(v.entries).toHaveLength(1);
      expect(v.entries[0]!.value.tag).toBe(1);
      expect(rvValueToJson(v.entries[0]!.key)).toBe('k');
      expect(rvValueToJson(v.entries[0]!.value.value)).toBe('v');
    }
  });

  it('decodes SIMPLE_LIST as bytes', () => {
    const fields = asObj(nodes[0]!.value).fields;
    const v = fields[8]!.value;
    expect(v.k).toBe('bytes');
    if (v.k === 'bytes') expect(bytesToHex(v.bytes)).toBe('deadbeef');
  });

  it('decodes nested STRUCT', () => {
    const fields = asObj(nodes[0]!.value).fields;
    const v = fields[9]!.value;
    expect(v.k).toBe('obj');
    if (v.k === 'obj') {
      expect(v.fields).toHaveLength(1);
      expect(v.fields[0]!.tag).toBe(1);
      expect(rvValueToJson(v.fields[0]!.value)).toBe(7);
    }
  });

  it('JCE + protobuf 混合嵌套：SIMPLE_LIST 内容可按 protobuf 解析', () => {
    const fields = asObj(nodes[0]!.value).fields;
    const v = fields[10]!.value;
    expect(v.k).toBe('bytes');
    if (v.k !== 'bytes') throw new Error('not bytes');
    const nested = tryDecodeProtobuf(v.bytes);
    expect(nested).not.toBeNull();
    expect(rvNodesToJson(nested!)).toEqual({ '1': 1, '2': 'hi' });
  });

  it('{tag: value} JSON round trip', () => {
    const json = rvNodesToJson(nodes);
    expect(json).toEqual({
      '0': {
        '1': 'hi',
        '2': 42,
        '3': 0,
        '4': -1,
        '5': '72623859790382856',
        '6': 1.5,
        '7': [1, 2, 3],
        '8': { k: 'v' },
        '9': 'deadbeef',
        '10': { '1': 7 },
        '11': '080112026869',
      },
    });
  });

  it('tryDecodeJce rejects protobuf bytes', () => {
    expect(tryDecodeJce(HEX('08 96 01 12 02 68 69'))).toBeNull();
  });

  it('extended tag (>= 15) support', () => {
    // 头字节 0xf6：tag 半字节 = 15 → 扩展 tag 0x14(20)，type 6 STRING1
    const out = decodeJce(HEX('f6 14 01 61'));
    expect(out).toHaveLength(1);
    expect(out[0]!.tag).toBe(20);
    expect(rvValueToJson(out[0]!.value)).toBe('a');
  });
});

// ---------------------------------------------------------------- grouping

describe('reverse grouping', () => {
  const mk = (tag: number, n: bigint): RvNode => ({
    tag,
    value: { k: 'int', raw: n, bits: 0, signed: false },
  });

  it('groupRvNodes keeps insertion order and merges same tags', () => {
    const groups = groupRvNodes([mk(1, 1n), mk(2, 2n), mk(1, 3n)]);
    expect(groups.map((g) => g.tag)).toEqual([1, 2]);
    expect(groups[0]!.values).toHaveLength(2);
  });
});
