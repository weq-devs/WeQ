/**
 * MCP 用的纯 JSON 视图（CyberChef「Protobuf Decode」风格）。
 */

import { describe, it, expect } from 'vitest';
import {
  decodeProtobuf,
  decodeJce,
  hexToBytes,
  newJsonRenderCtx,
  RV_MAX_DEPTH,
  rvNodesToJsonView,
  type RvNode,
} from '../src/raw';

const HEX = (s: string): Uint8Array => {
  const out = hexToBytes(s);
  if (!out) throw new Error(`bad hex: ${s}`);
  return out;
};

describe('aiview: protobuf → 纯 JSON', () => {
  // 08 96 01 | 12 02 68 69 | 1a 02 20 01 | 28 01 28 02 28 03 | 30 ff…01 | 39 <3.14f64>
  const PB_HEX =
    '08 96 01 12 02 68 69 1a 02 20 01 28 01 28 02 28 03 ' +
    '30 ff ff ff ff ff ff ff ff ff 01 39 1f 85 eb 51 b8 1e 09 40';
  const nodes = decodeProtobuf(HEX(PB_HEX));

  it('字段号当键、嵌套内联、重复 tag 合并成数组', () => {
    const ctx = newJsonRenderCtx();
    const json = rvNodesToJsonView(nodes, ctx);
    expect(json['1']).toBe(150);
    expect(json['2']).toBe('hi');
    expect(json['3']).toEqual({ '4': 1 }); // 自动展开的嵌套 message
    expect(json['5']).toEqual([1, 2, 3]);
    // 超出 2^53 的 varint / fixed64 用字符串保精度
    expect(json['6']).toBe('18446744073709551615');
    expect(json['7']).toBe('4614253070214989087');
  });

  it('记录出现过的 tag，供字段名图例使用', () => {
    const ctx = newJsonRenderCtx();
    rvNodesToJsonView(nodes, ctx);
    expect([...ctx.tags].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('不可读字节 → 0x 前缀 hex；空 bytes → 空串', () => {
    const ctx = newJsonRenderCtx();
    const json = rvNodesToJsonView(
      [
        { tag: 1, value: { k: 'bytes', bytes: HEX('00 ff 10') } },
        { tag: 2, value: { k: 'bytes', bytes: new Uint8Array() } },
      ],
      ctx,
    );
    expect(json['1']).toBe('0x00ff10');
    expect(json['2']).toBe('');
  });

  it('超大 bytes 截断并标记 truncatedHex', () => {
    const ctx = newJsonRenderCtx();
    const big = new Uint8Array(6000).fill(0xff);
    const json = rvNodesToJsonView([{ tag: 9, value: { k: 'bytes', bytes: big } }], ctx);
    expect(ctx.truncatedHex).toBe(true);
    expect(String(json['9'])).toContain('…(+');
    expect(String(json['9']).startsWith('0xffff')).toBe(true);
  });

  it('JCE LIST / MAP → 数组 / 对象', () => {
    const JCE_HEX =
      '0a ' +
      '16 02 68 69 ' +
      '22 00 00 00 2a ' +
      '79 02 00 00 00 03 00 01 00 02 00 03 ' +
      '88 00 01 06 01 6b 16 01 76 ' +
      'bd 00 00 06 08 01 12 02 68 69 ' +
      '0b';
    const ctx = newJsonRenderCtx();
    const json = rvNodesToJsonView(decodeJce(HEX(JCE_HEX)), ctx);
    const root = json['0'] as Record<string, unknown>;
    expect(root['1']).toBe('hi');
    expect(root['2']).toBe(42);
    expect(root['7']).toEqual([1, 2, 3]);
    expect(root['8']).toEqual({ k: 'v' });
    expect(root['11']).toEqual({ '1': 1, '2': 'hi' });
  });
});

describe('aiview: 深度保护', () => {
  it('嵌套消息超过 RV_MAX_DEPTH 后退回 bytes', () => {
    // 手工构造 20 层嵌套：每层 tag=1 LEN 包住下一层
    let inner = new Uint8Array([0x08, 0x01]); // 1: 1
    for (let i = 0; i < 20; i++) {
      const out = new Uint8Array(inner.length + 2);
      out[0] = 0x0a;
      out[1] = inner.length;
      out.set(inner, 2);
      inner = out;
    }
    const nodes: RvNode[] = decodeProtobuf(inner);
    // 沿「单链嵌套」一路往下数：
    //   levels = 带 nested 的 bytes 节点个数（根那层的 LEN 节点算 1）
    //   leaf  = 该链最深的那个 bytes 值，必须已经不再带 nested
    let levels = 0;
    let leaf: Extract<RvNode['value'], { k: 'bytes' }> | undefined;
    let cur: RvNode[] | undefined = nodes;
    while (cur) {
      const v = cur[0]?.value;
      if (v?.k !== 'bytes') break;
      leaf = v;
      if (!v.nested) break;
      levels += 1;
      cur = v.nested;
    }
    // 20 层输入远超上限：带 nested 的节点是 depth 0..RV_MAX_DEPTH-2，
    // 到 RV_MAX_DEPTH 停止下钻，最后一层只留原始 bytes。
    expect(levels).toBe(RV_MAX_DEPTH - 1);
    expect(leaf?.nested).toBeUndefined();
    expect(leaf?.bytes.length).toBeGreaterThan(0);

    // 最深处节点必须是原始 bytes（不再带 nested），能当 hex 读出。
    const ctx = newJsonRenderCtx();
    rvNodesToJsonView(nodes, ctx);
    expect(ctx.tags.size).toBeGreaterThan(0);
  });
});
