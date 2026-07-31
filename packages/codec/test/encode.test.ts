/**
 * Editable-tree round-trips.
 *
 * The load-bearing property is byte identity: rebuilding an untouched tree must
 * reproduce the input exactly, and editing one field must leave every unrelated
 * byte alone. If that ever breaks, saving a BLOB from the lightbox silently
 * rewrites parts of a live QQ message the user never looked at.
 */

import { describe, it, expect } from 'vitest';
import {
  buildEditTree,
  encodeEditTree,
  updateNode,
  removeNode,
  appendNode,
  newNode,
  reinterpret,
  valueAlternatives,
  toHex,
  PbEncodeError,
  type PbNode,
} from '../src/raw';

/** Same real 40800 row as raw.test.ts: {45001, 45002, 45101 "呜呜呜", 45102}. */
const SAMPLE = new Uint8Array([
  0x82, 0xf6, 0x13, 0x21, 0xc8, 0xfc, 0x15, 0xa1, 0xd0, 0xe6, 0xa4, 0xd2, 0xb8, 0xb8, 0x80, 0x6a,
  0xd0, 0xfc, 0x15, 0x01, 0xea, 0x82, 0x16, 0x09, 0xe5, 0x91, 0x9c, 0xe5, 0x91, 0x9c, 0xe5, 0x91,
  0x9c, 0xf0, 0x82, 0x16, 0x00,
]);

/** Depth-first search for a tag, so tests don't hard-code child indices. */
function find(nodes: PbNode[], tag: number): PbNode {
  const hit = tryFind(nodes, tag);
  if (!hit) throw new Error(`tag ${tag} not in tree`);
  return hit;
}

function tryFind(nodes: PbNode[], tag: number): PbNode | null {
  for (const n of nodes) {
    if (n.tag === tag) return n;
    if (n.children) {
      const hit = tryFind(n.children, tag);
      if (hit) return hit;
    }
  }
  return null;
}

describe('buildEditTree', () => {
  it('mirrors the decoded structure', () => {
    const tree = buildEditTree(SAMPLE);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.tag).toBe(40800);
    expect(tree[0]!.value.kind).toBe('nested');
    expect(tree[0]!.children!.map((c) => c.tag)).toEqual([45001, 45002, 45101, 45102]);
  });

  it('starts every node clean', () => {
    const tree = buildEditTree(SAMPLE);
    expect(tree[0]!.dirty).toBe(false);
    expect(tree[0]!.children!.every((c) => !c.dirty)).toBe(true);
  });

  it('picks the decoder-preferred reading per field', () => {
    const tree = buildEditTree(SAMPLE);
    expect(find(tree, 45101).value).toEqual({ kind: 'utf8', text: '呜呜呜' });
    // 45002 = 1, so bool outranks raw uint (see raw.test.ts).
    expect(find(tree, 45002).value).toEqual({ kind: 'bool', on: true });
  });

  it('never leaves a node nested-but-childless', () => {
    // `08 00 00` parses as one field (tag 1, varint 0) plus a trailing 00 that
    // is not a valid tag — a PARTIAL nested match. Honoring it would render an
    // un-expandable "0 个字段" row; it must fall back to bytes/utf8 instead.
    const partial = new Uint8Array([0x0a, 0x03, 0x08, 0x00, 0x00]);
    const tree = buildEditTree(partial);
    const node = tree[0]!;
    expect(node.value.kind).not.toBe('nested');
    expect(encodeEditTree(tree, partial)).toEqual(partial);
  });

  it('keeps a real md5 blob as bytes rather than a bogus message', () => {
    const md5 = new Uint8Array([
      0xa4, 0x62, 0x31, 0x83, 0x28, 0xac, 0x23, 0x1a, 0xb0, 0x05, 0x78, 0x1b, 0x36, 0x23, 0x37,
      0x8d,
    ]);
    const buf = new Uint8Array([0xb2, 0xdb, 0x15, md5.length, ...md5]);
    const node = buildEditTree(buf)[0]!;
    expect(node.value).toEqual({ kind: 'bytes', hex: toHex(md5) });
    expect(node.children).toBeNull();
  });
});

describe('encodeEditTree — byte identity', () => {
  it('reproduces the input exactly when nothing was edited', () => {
    const tree = buildEditTree(SAMPLE);
    expect(encodeEditTree(tree, SAMPLE)).toEqual(SAMPLE);
  });

  it('is stable across repeated encodes', () => {
    const tree = buildEditTree(SAMPLE);
    const once = encodeEditTree(tree, SAMPLE);
    expect(encodeEditTree(buildEditTree(once), once)).toEqual(SAMPLE);
  });

  it('preserves non-canonical varint padding on untouched fields', () => {
    // A 2-byte encoding of tag-1 varint 1 — legal but not what writeVarint emits.
    const padded = new Uint8Array([0x08, 0x81, 0x00]);
    const tree = buildEditTree(padded);
    expect(encodeEditTree(tree, padded)).toEqual(padded);
  });
});

describe('encodeEditTree — targeted edits', () => {
  it('changes only the edited field and its length prefix', () => {
    const tree = buildEditTree(SAMPLE);
    const text = find(tree, 45101);
    // Same byte length (3 CJK chars → 3 CJK chars) so surrounding offsets hold.
    const edited = updateNode(tree, text.id, (n) => ({
      ...n,
      value: { kind: 'utf8', text: '喵喵喵' },
    }));
    const out = encodeEditTree(edited, SAMPLE);

    expect(out).toHaveLength(SAMPLE.length);
    // Everything before the 45101 payload (offset 24) is untouched.
    expect(out.subarray(0, 24)).toEqual(SAMPLE.subarray(0, 24));
    // And so is the 45102 field that follows it.
    expect(out.subarray(33)).toEqual(SAMPLE.subarray(33));
    expect(toHex(out.subarray(24, 33))).toBe(toHex(new TextEncoder().encode('喵喵喵')));
  });

  it('marks only the root-to-node path dirty', () => {
    const tree = buildEditTree(SAMPLE);
    const edited = updateNode(tree, find(tree, 45101).id, (n) => ({
      ...n,
      value: { kind: 'utf8', text: 'x' },
    }));
    expect(edited[0]!.dirty).toBe(true);
    const kids = edited[0]!.children!;
    expect(kids.filter((c) => c.dirty).map((c) => c.tag)).toEqual([45101]);
  });

  it('re-lengths the parent when an edit changes the payload size', () => {
    const tree = buildEditTree(SAMPLE);
    const edited = updateNode(tree, find(tree, 45101).id, (n) => ({
      ...n,
      value: { kind: 'utf8', text: '好' },
    }));
    const out = encodeEditTree(edited, SAMPLE);
    expect(out).toHaveLength(SAMPLE.length - 6);
    const back = buildEditTree(out);
    expect(find(back, 45101).value).toEqual({ kind: 'utf8', text: '好' });
    expect(find(back, 45001).value).toEqual(find(tree, 45001).value);
  });

  it('round-trips a varint edit', () => {
    const tree = buildEditTree(SAMPLE);
    const edited = updateNode(tree, find(tree, 45001).id, (n) => ({
      ...n,
      value: { kind: 'varint', text: '42' },
    }));
    const back = buildEditTree(encodeEditTree(edited, SAMPLE));
    expect(find(back, 45001).value).toEqual({ kind: 'varint', text: '42' });
    // The 9-byte varint collapsing to 1 byte must shrink the parent's LEN too.
    expect(encodeEditTree(edited, SAMPLE)).toHaveLength(SAMPLE.length - 8);
  });
});

describe('structural edits', () => {
  it('removes a field and leaves the siblings byte-identical', () => {
    const tree = buildEditTree(SAMPLE);
    const out = encodeEditTree(removeNode(tree, find(tree, 45102).id), SAMPLE);
    const back = buildEditTree(out);
    expect(back[0]!.children!.map((c) => c.tag)).toEqual([45001, 45002, 45101]);
    // 45102 is the trailing 4 bytes; only the parent's LEN byte (index 3) and
    // that tail should differ.
    expect(out).toHaveLength(SAMPLE.length - 4);
    expect(out[3]).toBe(SAMPLE[3]! - 4);
    expect(out.subarray(4)).toEqual(SAMPLE.subarray(4, SAMPLE.length - 4));
  });

  it('appends a field inside a nested message', () => {
    const tree = buildEditTree(SAMPLE);
    const added = appendNode(tree, tree[0]!.id, {
      ...newNode(45999, 0),
      value: { kind: 'varint', text: '7' },
    });
    const back = buildEditTree(encodeEditTree(added, SAMPLE));
    expect(back[0]!.children!.map((c) => c.tag)).toEqual([45001, 45002, 45101, 45102, 45999]);
    expect(find(back, 45999).value).toEqual({ kind: 'varint', text: '7' });
  });

  it('appends a field at the root', () => {
    const tree = buildEditTree(SAMPLE);
    const added = appendNode(tree, null, {
      ...newNode(40801, 2),
      value: { kind: 'utf8', text: 'hello' },
    });
    const out = encodeEditTree(added, SAMPLE);
    expect(out.subarray(0, SAMPLE.length)).toEqual(SAMPLE);
    const back = buildEditTree(out);
    expect(back.map((n) => n.tag)).toEqual([40800, 40801]);
    expect(find(back, 40801).value).toEqual({ kind: 'utf8', text: 'hello' });
  });

  it('supports each fixed / float / bytes / bool kind', () => {
    const cases: PbNode[] = [
      { ...newNode(50001, 0), value: { kind: 'bool', on: true } },
      { ...newNode(50002, 0), value: { kind: 'zigzag', text: '-3' } },
      { ...newNode(50003, 1), value: { kind: 'fixed', bits: 64, text: '123456789' } },
      { ...newNode(50004, 5), value: { kind: 'float', bits: 32, text: '1.5' } },
      { ...newNode(50005, 2), value: { kind: 'bytes', hex: 'deadbeef' } },
    ];
    let tree = buildEditTree(new Uint8Array(0));
    for (const c of cases) tree = appendNode(tree, null, c);
    const out = encodeEditTree(tree, new Uint8Array(0));
    const back = buildEditTree(out);
    expect(back.map((n) => n.tag)).toEqual([50001, 50002, 50003, 50004, 50005]);
    expect(find(back, 50003).value).toEqual({ kind: 'fixed', bits: 64, text: '123456789' });
    expect(find(back, 50005).value).toEqual({ kind: 'bytes', hex: 'deadbeef' });
  });
});

describe('reinterpret', () => {
  it('switching a leaf reading does not change the bytes', () => {
    const tree = buildEditTree(SAMPLE);
    const bool = find(tree, 45002);
    const alt = valueAlternatives(0, new Uint8Array([0x01]));
    const asVarint = alt.find((v) => v.kind === 'varint')!;
    const switched = reinterpret(tree, bool.id, asVarint, SAMPLE);
    expect(encodeEditTree(switched, SAMPLE)).toEqual(SAMPLE);
    expect(find(switched, 45002).dirty).toBe(false);
  });

  it('re-entering a nested view keeps byte identity', () => {
    const tree = buildEditTree(SAMPLE);
    const root = tree[0]!;
    // 40800's payload starts at index 4 (3-byte tag varint + 1-byte LEN).
    const payload = SAMPLE.subarray(4);
    const alts = valueAlternatives(2, payload);
    const nested = alts.find((v) => v.kind === 'nested');
    expect(nested).toBeDefined();

    // Flatten to raw bytes, then descend again — children must be re-derived
    // with origins absolute in SAMPLE, or the encoder slices the wrong bytes.
    const flat = reinterpret(tree, root.id, { kind: 'bytes', hex: toHex(payload) }, SAMPLE);
    expect(encodeEditTree(flat, SAMPLE)).toEqual(SAMPLE);

    const back = reinterpret(flat, root.id, nested!, SAMPLE);
    expect(back[0]!.children!.map((c) => c.tag)).toEqual([45001, 45002, 45101, 45102]);
    expect(encodeEditTree(back, SAMPLE)).toEqual(SAMPLE);
  });
});

describe('encode errors', () => {
  it('rejects a non-numeric varint with the tag path', () => {
    const tree = buildEditTree(SAMPLE);
    const bad = updateNode(tree, find(tree, 45001).id, (n) => ({
      ...n,
      value: { kind: 'varint', text: 'abc' },
    }));
    try {
      encodeEditTree(bad, SAMPLE);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PbEncodeError);
      expect((e as PbEncodeError).path).toEqual([40800, 45001]);
    }
  });

  it('rejects odd-length hex', () => {
    const tree = buildEditTree(SAMPLE);
    const bad = updateNode(tree, find(tree, 45101).id, (n) => ({
      ...n,
      value: { kind: 'bytes', hex: 'abc' },
    }));
    expect(() => encodeEditTree(bad, SAMPLE)).toThrow(PbEncodeError);
  });
});
