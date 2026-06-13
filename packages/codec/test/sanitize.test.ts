/**
 * Wire-type sanitizer tests.
 *
 * Proves that a field whose ON-WIRE type conflicts with the schema declaration
 * is silently dropped (rather than crashing the whole decode), while:
 *   - correctly-typed siblings survive,
 *   - other elements in the same body survive,
 *   - fully valid buffers are returned byte-identical (no needless re-encode).
 *
 * Conflicting bytes are synthesized with an "evil" schema that declares a tag
 * with the wrong scalar type, so we can emit a payload whose wire type the real
 * schema would reject.
 */

import { describe, it, expect } from 'vitest';
import { ProtoMsg, ProtoField, ScalarType } from '../src/core';
import { sanitizeBytes } from '../src/raw';
import { writeVarint } from '../src/raw';
import { ElementWire } from '../src/proto/msg/element';
import { MsgBody } from '../src/proto/msg/40800';
import { decodeElement } from '../src/element';

const realElement = new ProtoMsg(ElementWire);
const body = new ProtoMsg(MsgBody);

/** tag+wiretype key byte(s). */
function key(tag: number, wire: number): Uint8Array {
  return writeVarint((BigInt(tag) << 3n) | BigInt(wire));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Wrap one element's bytes as a MsgBody tag-40800 (LEN) field. */
function asBodyElement(elementBytes: Uint8Array): Uint8Array {
  return concat(key(40800, 2), writeVarint(BigInt(elementBytes.length)), elementBytes);
}

describe('sanitizeBytes', () => {
  it('drops a field whose wire type conflicts with the schema (UINT32 tag sent as LEN)', () => {
    // 80975 (mfaceFlag80975) is UINT32 in ElementWire. Encode it as a STRING.
    const Evil = {
      elementType: ProtoField(45002, ScalarType.UINT32, { optional: true }),
      emojiPackId: ProtoField(80810, ScalarType.UINT32, { optional: true }),
      mfaceType: ProtoField(80901, ScalarType.UINT32, { optional: true }),
      badField: ProtoField(80975, ScalarType.STRING, { optional: true }),
    };
    const bytes = new ProtoMsg(Evil).encode({
      elementType: 11,
      emojiPackId: 4242,
      mfaceType: 2,
      badField: 'oops',
    });

    const clean = sanitizeBytes(bytes, ElementWire);
    const wire = realElement.decode(clean);

    expect(wire.elementType).toBe(11);
    expect(wire.emojiPackId).toBe(4242);
    expect(wire.mfaceType).toBe(2);
    expect(wire.mfaceFlag80975).toBeUndefined(); // conflicting field gone
  });

  it('drops the reverse conflict too (STRING tag sent as varint)', () => {
    // 80824 (emojiId) is STRING in ElementWire. Encode it as a UINT32.
    const Evil = {
      elementType: ProtoField(45002, ScalarType.UINT32, { optional: true }),
      emojiId: ProtoField(80824, ScalarType.UINT32, { optional: true }),
      mfaceType: ProtoField(80901, ScalarType.UINT32, { optional: true }),
    };
    const bytes = new ProtoMsg(Evil).encode({ elementType: 11, emojiId: 7, mfaceType: 3 });

    const wire = realElement.decode(sanitizeBytes(bytes, ElementWire));
    expect(wire.elementType).toBe(11);
    expect(wire.mfaceType).toBe(3);
    expect(wire.emojiId).toBeUndefined();
  });

  it('leaves a fully valid buffer byte-identical', () => {
    const bytes = realElement.encode({
      elementType: 11,
      emojiPackId: 1,
      emojiId: 'key',
      mfaceType: 2,
      previewWidth: 100,
      previewHeight: 80,
      isAnimated: true,
      mfaceFlag80983: '{"a":1}',
    });
    const clean = sanitizeBytes(bytes, ElementWire);
    expect(clean).toBe(bytes); // unchanged → same reference
  });

  it('does not touch repeated string fields (callSummary)', () => {
    const bytes = realElement.encode({
      elementType: 21,
      callSummary: ['a', 'bb', 'ccc'],
    });
    const wire = realElement.decode(sanitizeBytes(bytes, ElementWire));
    expect(wire.callSummary).toEqual(['a', 'bb', 'ccc']);
  });

  it('recursively cleans elements inside a MsgBody and keeps siblings', () => {
    // Element 1: an mface with a conflicting 80975 (UINT32 sent as LEN).
    const EvilMface = {
      elementType: ProtoField(45002, ScalarType.UINT32, { optional: true }),
      emojiPackId: ProtoField(80810, ScalarType.UINT32, { optional: true }),
      badField: ProtoField(80975, ScalarType.STRING, { optional: true }),
    };
    const badMface = new ProtoMsg(EvilMface).encode({
      elementType: 11,
      emojiPackId: 99,
      badField: 'derail',
    });
    // Element 2: a perfectly valid text element.
    const goodText = realElement.encode({ elementType: 1, textContent: 'hi' });

    const rawBody = concat(asBodyElement(badMface), asBodyElement(goodText));

    // Sanitized body decodes without throwing and preserves BOTH elements.
    const decoded = body.decode(sanitizeBytes(rawBody, MsgBody));
    const els = (decoded.elements ?? []).map(decodeElement);

    expect(els).toHaveLength(2);
    expect(els[0]!.kind).toBe('mface');
    expect((els[0] as any).emojiPackId).toBe(99);
    expect((els[0] as any).mfaceFlag80975).toBeUndefined();
    expect(els[1]!.kind).toBe('text');
    expect((els[1] as any).textContent).toBe('hi');
  });
});

describe('FILE element resilience', () => {
  it('round-trips a fully-populated FILE element', () => {
    const input = {
      elementType: 3,
      subType: 7,
      fileName: 'doc.pdf',
      filePath: '/tmp/doc.pdf',
      fileSize: 1234,
      md5Bytes: new Uint8Array([1, 2, 3]),
      md5Bytes2: new Uint8Array([4, 5, 6]),
      contentHash: new Uint8Array([7, 8]),
      imgWidth: 0,
      imgHeight: 0,
      fileFlag45415: 1,
      fileToken: 'tok',
      transferFlag45504: 'tf',
      uploadTime: 999,
      picTransferState: 2,
      transferVersion: 3,
      transferState: 4,
      fileFlag45409: new Uint8Array([9]),
      fileFlag45501: 1,
      videoToken: 'vtok',
      fileFlag45512: false,
      fileFlag45514: true,
    };
    const wire = realElement.decode(sanitizeBytes(realElement.encode(input), ElementWire));
    const el = decodeElement(wire) as any;
    expect(el.kind).toBe('file');
    expect(el.subType).toBe(7);
    expect(el.fileName).toBe('doc.pdf');
    expect(el.md5Bytes2).toEqual(new Uint8Array([4, 5, 6]));
    expect(el.videoToken).toBe('vtok');
    expect(el.fileFlag45512).toBe(false);
  });

  it('decodes a FILE element missing "required" fields without throwing (fields just absent)', () => {
    // Only elementType + a couple fields present — the rest of the "required"
    // FILE fields are simply missing on the wire.
    const sparse = realElement.encode({ elementType: 3, fileName: 'only-name' });
    let el: any;
    expect(() => {
      el = decodeElement(realElement.decode(sanitizeBytes(sparse, ElementWire)));
    }).not.toThrow();
    expect(el.kind).toBe('file');
    expect(el.fileName).toBe('only-name');
    expect(el.fileSize).toBeUndefined();
    expect(el.md5Bytes2).toBeUndefined();
    expect(el.subType).toBeUndefined();
  });

  it('drops a FILE field with a conflicting wire type, keeps the rest', () => {
    // 45512 (fileFlag45512) is BOOL (varint) in ElementWire; send it as a LEN.
    const Evil = {
      elementType: ProtoField(45002, ScalarType.UINT32, { optional: true }),
      fileName: ProtoField(45402, ScalarType.STRING, { optional: true }),
      bad45512: ProtoField(45512, ScalarType.STRING, { optional: true }),
    };
    const bytes = new ProtoMsg(Evil).encode({ elementType: 3, fileName: 'f', bad45512: 'x' });
    const el = decodeElement(realElement.decode(sanitizeBytes(bytes, ElementWire))) as any;
    expect(el.kind).toBe('file');
    expect(el.fileName).toBe('f');
    expect(el.fileFlag45512).toBeUndefined();
  });
});

describe('VIDEO element resilience', () => {
  it('round-trips a fully-populated VIDEO element (incl. renamed videoToken @45510)', () => {
    const input = {
      elementType: 5,
      subType: 2,
      fileName: 'clip.mp4',
      fileSize: 9999,
      md5Bytes: new Uint8Array([1]),
      contentHash: new Uint8Array([2]),
      imgWidth: 1280,
      imgHeight: 720,
      fileFlag45415: 1,
      isOriginal: true,
      fileToken: 'ftok',
      uploadTime: 100,
      picTransferState: 1,
      transferVersion: 1,
      uploadTimestamp: 200,
      fileTTL: 86400,
      summary: ['[视频]'],
      videoDuration: 30,
      videoWidth: 1280,
      videoHeight: 720,
      videoFlag45421: new Uint8Array([3]),
      coverFileName: 'cover.jpg',
      videoFlag45423: false,
      videoToken: 'vtok',
      expireTimestamp: 1700000000,
      validPeriodSec: 604800,
      secondExpireTimestamp: 1701000000,
      channelParams: new Uint8Array([4, 5]),
      videoFlag45863: 7,
    };
    const el = decodeElement(realElement.decode(sanitizeBytes(realElement.encode(input), ElementWire))) as any;
    expect(el.kind).toBe('video');
    expect(el.videoDuration).toBe(30);
    expect(el.coverFileName).toBe('cover.jpg');
    expect(el.videoToken).toBe('vtok'); // 45510, now a string
    expect(el.secondExpireTimestamp).toBe(1701000000);
    expect(el.summary).toEqual(['[视频]']);
  });

  it('decodes a VIDEO element missing "required" fields without throwing', () => {
    const sparse = realElement.encode({ elementType: 5, fileName: 'v.mp4' });
    let el: any;
    expect(() => {
      el = decodeElement(realElement.decode(sanitizeBytes(sparse, ElementWire)));
    }).not.toThrow();
    expect(el.kind).toBe('video');
    expect(el.fileName).toBe('v.mp4');
    expect(el.videoDuration).toBeUndefined();
    expect(el.videoToken).toBeUndefined();
  });
});
