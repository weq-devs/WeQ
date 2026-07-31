/**
 * End-to-end test: decode a real c2c message body and prove we get "呜呜呜"
 * out without any schema.
 *
 * Source bytes (one row of c2c_msg_table.body, hex):
 *   82 f6 13 21 c8 fc 15 a1 d0 e6 a4 d2 b8 b8 80 6a
 *   d0 fc 15 01 ea 82 16 09 e5 91 9c e5 91 9c e5 91 9c
 *   f0 82 16 00
 *
 * Expected tree (from the decoder, the "呜呜呜" string was the eye-check
 * that proved the decoder is right; the 9-byte varint value was originally
 * mis-arithmetic'd by hand in chat and corrected against the decoder):
 *   tag 40800 LEN(33)
 *     ├ tag 45001 varint = 7638353204859217953
 *     ├ tag 45002 varint = 1
 *     ├ tag 45101 LEN(9) "呜呜呜"
 *     └ tag 45102 varint = 0
 */

import { describe, it, expect } from 'vitest';
import { decode } from '../src/raw';

const SAMPLE = new Uint8Array([
  0x82, 0xf6, 0x13, 0x21, 0xc8, 0xfc, 0x15, 0xa1, 0xd0, 0xe6, 0xa4, 0xd2, 0xb8, 0xb8, 0x80, 0x6a,
  0xd0, 0xfc, 0x15, 0x01, 0xea, 0x82, 0x16, 0x09, 0xe5, 0x91, 0x9c, 0xe5, 0x91, 0x9c, 0xe5, 0x91,
  0x9c, 0xf0, 0x82, 0x16, 0x00,
]);

describe('raw decoder — user sample (呜呜呜)', () => {
  const tree = decode(SAMPLE);

  it('parses one top-level field with tag 40800', () => {
    expect(tree).toHaveLength(1);
    expect(tree[0]!.tag).toBe(40800);
    expect(tree[0]!.wireType).toBe(2);
  });

  it('finds nested as the top guess for tag 40800', () => {
    const topGuess = tree[0]!.guesses[0]!;
    expect(topGuess.kind).toBe('len-nested');
  });

  it('decodes the 4 inner fields', () => {
    const nested = tree[0]!.guesses.find((g) => g.kind === 'len-nested');
    if (nested?.kind !== 'len-nested') throw new Error('no nested guess');
    expect(nested.consumedAll).toBe(true);
    expect(nested.value).toHaveLength(4);
    expect(nested.value.map((f) => f.tag)).toEqual([45001, 45002, 45101, 45102]);
  });

  it('recovers "呜呜呜" from tag 45101', () => {
    const nested = tree[0]!.guesses.find((g) => g.kind === 'len-nested');
    if (nested?.kind !== 'len-nested') throw new Error('no nested guess');
    const textField = nested.value.find((f) => f.tag === 45101);
    expect(textField).toBeDefined();
    const utf8 = textField!.guesses.find((g) => g.kind === 'len-utf8');
    expect(utf8).toBeDefined();
    if (utf8?.kind === 'len-utf8') {
      expect(utf8.value).toBe('呜呜呜');
      // CJK should rank higher than raw bytes
      expect(utf8.confidence).toBeGreaterThan(0.5);
    }
  });

  it('decodes the 9-byte varint at tag 45001 to a bigint without precision loss', () => {
    const nested = tree[0]!.guesses.find((g) => g.kind === 'len-nested');
    if (nested?.kind !== 'len-nested') throw new Error('no nested guess');
    const field = nested.value.find((f) => f.tag === 45001);
    const u64 = field!.guesses.find((g) => g.kind === 'varint-uint64');
    if (u64?.kind !== 'varint-uint64') throw new Error('no varint guess');
    expect(typeof u64.value).toBe('bigint');
    expect(u64.value).toBe(7638353204859217953n);
  });

  it('recognises 45002 = 1 as a bool guess (with bool ranked above raw uint)', () => {
    const nested = tree[0]!.guesses.find((g) => g.kind === 'len-nested');
    if (nested?.kind !== 'len-nested') throw new Error('no nested guess');
    const field = nested.value.find((f) => f.tag === 45002);
    expect(field!.guesses[0]!.kind).toBe('varint-bool');
  });

  it('tracks original byte offsets for hex-view highlighting', () => {
    expect(tree[0]!.start).toBe(0);
    expect(tree[0]!.size).toBe(37); // total payload length

    const nested = tree[0]!.guesses.find((g) => g.kind === 'len-nested');
    if (nested?.kind !== 'len-nested') throw new Error('no nested guess');
    const textField = nested.value.find((f) => f.tag === 45101)!;
    // The 9-byte UTF-8 payload lives at bytes 24..33 (after 4 byte tag+length).
    expect(textField.start).toBe(20);
    expect(textField.size).toBe(13); // 3 byte tag varint + 1 byte length + 9 byte payload
  });
});
