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

describe('decodeMsgDressWire (40900 内形态, 无外层 40801 包)', () => {
  it('decodes a raw MsgDressWire payload into decoration ids', () => {
    const bytes = wire({ bubbleId: 2072805, fontId: 20671, widgetId: 104228 });
    expect(decodeMsgDressWire(bytes)).toEqual({
      bubbleId: 2072805,
      fontId: 20671,
      widgetId: 104228,
    });
  });

  it('falls back to the byte-swapped tag 41531 value when 41525 is zero', () => {
    const bytes = wire({ fontId: 0, flag41531: 0x1234 });
    expect(decodeMsgDressWire(bytes)?.fontId).toBe(0x3412);
  });

  it('returns null for empty or invalid bytes', () => {
    expect(decodeMsgDressWire(new Uint8Array(0))).toBeNull();
    expect(decodeMsgDressWire(new Uint8Array([0xff, 0xff]))).toBeNull();
  });
});
