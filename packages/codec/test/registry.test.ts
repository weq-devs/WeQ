/**
 * End-to-end tests against the 呜呜呜 sample bytes.
 *
 * Three paths exercised:
 *   1. Raw schema-free decode + tag-dictionary naming — the BLOB lightbox path.
 *   2. ProtoMsg(MsgBody).decode — Layer 1 round-trip wire decode.
 *   3. decodeElement — Layer 2 dispatch to TextElement.
 *
 * encodeElement now forwards exactly what the caller supplied; there is no
 * "default value" auto-injection (removed in the codec refactor). Round-trip
 * tests prove field preservation and the wire-purity tests prove omitted
 * fields stay off the wire.
 */

import { describe, it, expect } from 'vitest';
import { ProtoMsg } from '../src/core';
import { decode, buildEditTree } from '../src/raw';
import { lookupTag } from '../src/dictionary';
import { MsgBody } from '../src/proto/msg/40800';
import { ElementWire } from '../src/proto/msg/element';
import {
  decodeElement,
  encodeElement,
  ElementType,
  FaceSubType,
  type ArkElement,
  type ArkPayload,
  type FaceElement,
} from '../src/element';
import { SAMPLE_GAME_CENTER_AD } from '../src/element/ark';

const SAMPLE = new Uint8Array([
  0x82, 0xf6, 0x13, 0x21, 0xc8, 0xfc, 0x15, 0xa1, 0xd0, 0xe6, 0xa4, 0xd2, 0xb8, 0xb8, 0x80, 0x6a,
  0xd0, 0xfc, 0x15, 0x01, 0xea, 0x82, 0x16, 0x09, 0xe5, 0x91, 0x9c, 0xe5, 0x91, 0x9c, 0xe5, 0x91,
  0x9c, 0xf0, 0x82, 0x16, 0x00,
]);

describe('raw decode + tag dictionary', () => {
  it('names the 40800 envelope', () => {
    const tree = buildEditTree(SAMPLE);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.tag).toBe(40800);
    expect(lookupTag(40800).names[0]!.name).toBe('elements');
    expect(tree[0]!.children).not.toBeNull();
  });

  it('names the inner element fields without walking a schema hierarchy', () => {
    const tree = buildEditTree(SAMPLE);
    const byTag = new Map(tree[0]!.children!.map((c) => [c.tag, c]));

    expect(lookupTag(45002).names[0]!.name).toBe('elementType');
    expect(byTag.get(45002)!.value).toEqual({ kind: 'bool', on: true });

    expect(lookupTag(45101).names[0]!.name).toBe('textContent');
    expect(byTag.get(45101)!.value).toEqual({ kind: 'utf8', text: '呜呜呜' });
  });
});

describe('typed decode via ProtoMsg + decodeElement', () => {
  it('parses the envelope into ElementWire structs', () => {
    const body = new ProtoMsg(MsgBody).decode(SAMPLE);
    expect(body.elements).toBeDefined();
    expect(body.elements).toHaveLength(1);

    const wire = body.elements![0]!;
    expect(wire.elementType).toBe(1);
    expect(wire.textContent).toBe('呜呜呜');
    expect(wire.elementId).toBe(7638353204859217953n);
    expect(wire.textReserve).toBe(0);
  });

  it('lifts the ElementWire into a TextElement via decodeElement', () => {
    const body = new ProtoMsg(MsgBody).decode(SAMPLE);
    const wire = body.elements![0]!;
    const el = decodeElement(wire);

    expect(el.kind).toBe('text');
    if (el.kind === 'text') {
      expect(el.textContent).toBe('呜呜呜');
      expect(el.elementId).toBe(7638353204859217953n);
      // All wire fields are lifted: 45102 was 0 on the wire, must be on the element.
      expect(el.textReserve).toBe(0);
    }
  });

  it('falls back to UnknownElement for unregistered elementType', () => {
    const fakeWire = { elementType: 9999, elementId: 42n } as any;
    const el = decodeElement(fakeWire);
    expect(el.kind).toBe('unknown');
    if (el.kind === 'unknown') {
      expect(el.elementType).toBe(9999);
      expect(el.elementId).toBe(42n);
    }
  });
});

describe('encodeElement wire purity', () => {
  it('round-trips textReserve when caller provides it', () => {
    const wire = encodeElement({
      kind: 'text',
      elementId: 1n,
      textContent: 'hi',
      textReserve: 5,
    });
    expect(wire.textReserve).toBe(5);

    const bytes = new ProtoMsg(MsgBody).encode({ elements: [wire] });
    const back = new ProtoMsg(MsgBody).decode(bytes);
    expect(back.elements![0]!.textReserve).toBe(5);
  });

  it('omits textReserve when caller does not provide it', () => {
    const wire = encodeElement({
      kind: 'text',
      elementId: 1n,
      textContent: 'hi',
    });
    expect(wire.textReserve).toBeUndefined();

    const bytes = new ProtoMsg(MsgBody).encode({ elements: [wire] });
    const tree = decode(bytes);
    const inner = tree[0]!.guesses.find((g) => g.kind === 'len-nested');
    if (inner?.kind === 'len-nested') {
      const tags = new Set(inner.value.map((f) => f.tag));
      expect(tags.has(45102)).toBe(false);
    }
  });

  it('does not emit untouched fields without explicit caller values', () => {
    const codec = new ProtoMsg(ElementWire);
    const bytes = codec.encode({
      elementId: 1n,
      elementType: ElementType.TEXT,
      textContent: 'hi',
    });
    const raw = decode(bytes);
    const tags = new Set(raw.map((f) => f.tag));
    expect(tags.has(45103)).toBe(false);
    expect(tags.has(45110)).toBe(false);
    expect(tags.has(49154)).toBe(false);
    expect(tags.has(49155)).toBe(false);
  });

  it('ProtoMsg.encode itself does NOT auto-inject defaults', () => {
    // Pure wire serializer — only emits what the caller supplied. Defaults
    // are an element-layer concern, not a wire-layer concern.
    const codec = new ProtoMsg(ElementWire);
    const bytes = codec.encode({
      elementId: 1n,
      elementType: ElementType.TEXT,
      textContent: 'hi',
      // textReserve omitted — must NOT appear in bytes at this level
    });
    const raw = decode(bytes);
    const tags = new Set(raw.map((f) => f.tag));
    expect(tags.has(45102)).toBe(false);
  });

  it('omits truly optional fields with no default on round-trip', () => {
    const codec = new ProtoMsg(ElementWire);
    const bytes = codec.encode({
      elementId: 1n,
      elementType: ElementType.TEXT,
      textContent: 'hi',
    });
    const back = codec.decode(bytes);
    expect(back.elementType).toBe(1);
    expect(back.textContent).toBe('hi');
    expect(back.roaming).toBeUndefined();
    expect(back.msgSyncFlag).toBeUndefined();
  });
});

describe('FaceElement (elementType=6)', () => {
  it('round-trips a super-emoji dice', () => {
    const original: FaceElement = {
      kind: 'face',
      elementId: 99n,
      subType: FaceSubType.SUPER_EMOJI,
      faceId: 358,
      faceText: '骰子',
      innerId: '4',
    };

    const wire = encodeElement(original);
    const bytes = new ProtoMsg(MsgBody).encode({ elements: [wire] });
    const decoded = new ProtoMsg(MsgBody).decode(bytes);
    const back = decodeElement(decoded.elements![0]!);

    expect(back.kind).toBe('face');
    if (back.kind === 'face') {
      expect(back.elementId).toBe(99n);
      expect(back.subType).toBe(FaceSubType.SUPER_EMOJI);
      expect(back.faceId).toBe(358);
      expect(back.faceText).toBe('骰子');
      expect(back.innerId).toBe('4');
    }
  });

  it('drops innerId when not provided (non-interactive face)', () => {
    const plain: FaceElement = {
      kind: 'face',
      elementId: 1n,
      subType: FaceSubType.QQ_BUILTIN_NEW,
      faceId: 1,
      faceText: '微笑',
    };
    const wire = encodeElement(plain);
    const bytes = new ProtoMsg(MsgBody).encode({ elements: [wire] });
    const back = decodeElement(new ProtoMsg(MsgBody).decode(bytes).elements![0]!);
    expect(back.kind).toBe('face');
    if (back.kind === 'face') expect(back.innerId).toBeUndefined();
  });

  it('silently ignores unknown wire tags during decode', () => {
    // Hand-craft an envelope containing an UNDECLARED tag 47699, sandwiched
    // between declared fields. protobuf-ts should treat 47699 as an unknown
    // field, not error out.
    //
    // 47699 must stay OUTSIDE ElementWire — an earlier version of this test
    // used 47608, which was later modelled as `faceFlag47608` (BYTES), so the
    // varint payload below started decoding as a length prefix and blew up.
    const codec = new ProtoMsg(ElementWire);
    const knownBytes = codec.encode({
      elementId: 5n,
      elementType: ElementType.FACE,
      subType: 2,
      faceId: 1,
      faceText: 'x',
    });

    const unknownTagVarint = encodeVarint(BigInt(47699 << 3) | 0n);
    const valueVarint = encodeVarint(99n);
    const merged = new Uint8Array([...knownBytes, ...unknownTagVarint, ...valueVarint]);

    // Must not throw.
    const back = codec.decode(merged);
    expect(back.elementType).toBe(6);
    expect(back.faceId).toBe(1);
  });
});

describe('ArkElement (elementType=10)', () => {
  it('round-trips a game-center ad ark card via JSON string', () => {
    const json = JSON.stringify(SAMPLE_GAME_CENTER_AD);
    const original: ArkElement = {
      kind: 'ark',
      elementId: 42n,
      arkData: json,
    };

    const wire = encodeElement(original);
    const bytes = new ProtoMsg(MsgBody).encode({ elements: [wire] });
    const back = decodeElement(new ProtoMsg(MsgBody).decode(bytes).elements![0]!);

    expect(back.kind).toBe('ark');
    if (back.kind === 'ark') {
      // Byte-exact JSON survives the wire layer (no key reorder).
      expect(back.arkData).toBe(json);
      // And the parsed shape matches the typed sample.
      const parsed = JSON.parse(back.arkData) as ArkPayload;
      expect(parsed.app).toBe('com.tencent.gamecenter.mall');
      expect(parsed.view).toBe('pubAdArkView');
      expect(parsed.meta.template3!.actId).toBe(3062270);
      expect(parsed.config?.token).toBe(SAMPLE_GAME_CENTER_AD.config?.token);
    }
  });
});

function encodeVarint(v: bigint): number[] {
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}
