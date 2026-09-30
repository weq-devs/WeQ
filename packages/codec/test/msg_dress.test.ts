import { describe, expect, it } from 'vitest';
import { ProtoMsg } from '../src/core';
import { MsgDressBody, MsgDressWire } from '../src/proto/msg/40801';
import { decodeMsgDressColumn, decodeMsgDressWire } from '../src/domain/msg/msg_dress';

const codec = new ProtoMsg(MsgDressBody);
const wireCodec = new ProtoMsg(MsgDressWire);

function column(dress: Record<string, number>): Uint8Array {
  return codec.encode({ dress });
}

function wire(dress: Record<string, number>): Uint8Array {
  return wireCodec.encode(dress);
}

describe('decodeMsgDressColumn font id', () => {
  it('prefers tag 41525', () => {
    const result = decodeMsgDressColumn(column({ fontId: 20671, flag41531: 0x1234 }));
    expect(result?.fontId).toBe(20671);
  });

  it('falls back to the byte-swapped tag 41531 value when 41525 is zero', () => {
    // stored=0x1234 -> ((0x34 << 8) | 0x12) = 0x3412.
    const result = decodeMsgDressColumn(column({ fontId: 0, flag41531: 0x1234 }));
    expect(result?.fontId).toBe(0x3412);
  });

  it('does not create a decoration for a zero fallback font id', () => {
    const result = decodeMsgDressColumn(column({ fontId: 0, flag41531: 0 }));
    expect(result).toBeNull();
  });
});

/**
 * 40801 与消息元素（PushMsgBody）里的装扮是**恒等映射**：41525 → tag 56、
 * 41531 → tag 15。因此解码必须同时保留两个槽位的原始 wire 值，供转发原样写回。
 *
 * 回归点：`41531` 的低 16 位是交换过的 itemId、bit 16 是标志位（真机实测
 * `41531 = 116182 = 0x1C5D6`，元素 tag 15 也是 116182）。只看 `fontId`（已掩掉
 * bit 16 的解码值）再自己编码回去，标志位就没了。
 */
describe('decodeMsgDressColumn 保留 font 两个槽位的原始 wire 值', () => {
  const REAL_FONT2_RAW = 116182; // 真机一行的 41531；低 16 位 0xC5D6 还原成 54981

  it('41531 原值连同 bit 16 一起保留（就是元素的 tag 15）', () => {
    const result = decodeMsgDressColumn(
      column({ fontId: 0, flag41531: REAL_FONT2_RAW, bubbleId: 2116371, widgetId: 104228 }),
    );
    expect(result).toEqual({
      bubbleId: 2116371,
      fontId: 54981, // 解码值（掩掉 bit 16 后字节交换）
      widgetId: 104228,
      fontId1Raw: 0,
      fontId2Raw: REAL_FONT2_RAW, // 原值：bit 16 还在
    });
  });

  it('41525（font1）非零时同样原样保留', () => {
    const result = decodeMsgDressColumn(column({ fontId: 20671, flag41531: 0 }));
    expect(result?.fontId1Raw).toBe(20671);
    expect(result?.fontId).toBe(20671);
  });

  it('只有标志位的 41531（65536，low16=0）在 bubble/widget 也为空时仍算「无装扮」', () => {
    const result = decodeMsgDressColumn(column({ fontId: 0, flag41531: 65536 }));
    expect(result).toBeNull();
  });
});

describe('decodeMsgDressWire (40900 内形态, 无外层 40801 包)', () => {
  it('decodes a raw MsgDressWire payload into decoration ids', () => {
    const bytes = wire({ bubbleId: 2072805, fontId: 20671, widgetId: 104228 });
    expect(decodeMsgDressWire(bytes)).toEqual({
      bubbleId: 2072805,
      fontId: 20671,
      widgetId: 104228,
      fontId1Raw: 20671,
      fontId2Raw: 0,
    });
  });

  it('falls back to the byte-swapped tag 41531 value when 41525 is zero', () => {
    const bytes = wire({ fontId: 0, flag41531: 0x1234 });
    expect(decodeMsgDressWire(bytes)?.fontId).toBe(0x3412);
  });

  it('41531 的 bit 16 标志位在 wire 形态下也保留在 fontId2Raw 里', () => {
    const bytes = wire({ fontId: 0, flag41531: 116182 });
    expect(decodeMsgDressWire(bytes)?.fontId2Raw).toBe(116182);
  });

  it('returns null for empty or invalid bytes', () => {
    expect(decodeMsgDressWire(new Uint8Array(0))).toBeNull();
    expect(decodeMsgDressWire(new Uint8Array([0xff, 0xff]))).toBeNull();
  });
});
