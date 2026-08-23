import { describe, expect, it } from 'vitest';
import { ProtoMsg } from '../src/core';
import { MsgDressBody } from '../src/proto/msg/40801';
import { decodeMsgDressColumn } from '../src/domain/msg/msg_dress';

const codec = new ProtoMsg(MsgDressBody);

function column(dress: Record<string, number>): Uint8Array {
  return codec.encode({ dress });
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
