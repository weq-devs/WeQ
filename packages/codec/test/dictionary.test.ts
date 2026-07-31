/**
 * The flat tag dictionary that names fields in the BLOB lightbox's Protobuf tab.
 *
 * The whole feature rests on one premise: a tag above 1000 means the same thing
 * everywhere in QQ NT's schemas, so one flat lookup works at any tree depth. The
 * ambiguity test below pins the known exceptions — if a new schema reuses a tag
 * with a different meaning, that test fails and the UI's amber "ambiguous" badge
 * gets a new member rather than the tree quietly showing a wrong name.
 */

import { describe, it, expect } from 'vitest';
import { TAG_DICTIONARY, lookupTag, GLOBAL_TAG_MIN } from '../src/dictionary';

describe('lookupTag', () => {
  it('never names tags below the global threshold', () => {
    for (const tag of [1, 2, 3, 100, GLOBAL_TAG_MIN - 1]) {
      const r = lookupTag(tag);
      expect(r.status).toBe('small');
      expect(r.names).toHaveLength(0);
    }
  });

  it('names the message columns we rely on elsewhere', () => {
    const expected: Array<[number, string]> = [
      [40011, 'msgType'],
      [40050, 'sendTime'],
      [40800, 'elements'],
      [45002, 'elementType'],
      [45101, 'textContent'],
    ];
    for (const [tag, name] of expected) {
      const r = lookupTag(tag);
      expect(r.status, `tag ${tag}`).toBe('known');
      expect(r.names[0]!.name).toBe(name);
    }
  });

  it('reports undeclared tags above the threshold as undefined', () => {
    const r = lookupTag(47999);
    expect(r.status).toBe('undefined');
    expect(r.names).toHaveLength(0);
  });

  it('reaches schemas only referenced through nested messageRef closures', () => {
    // MuteInfoWire is reached via RecentContactBody.preview.muteInfo — it is
    // exported, but its own nested MutedUserWire fields prove we descend.
    expect(lookupTag(48531).status).toBe('known');
    expect(lookupTag(48531).names[0]!.name).toBe('timestamp');
  });

  it('carries the declaring schema so the UI can show provenance', () => {
    const r = lookupTag(45101);
    // Which schema wins is arbitrary when several declare the same name — only
    // that a path is recorded matters for the tooltip.
    expect(r.names[0]!.source).toMatch(/^[\w/]+\./);
    expect(r.names[0]!.kind).toBe('scalar');
  });
});

describe('ambiguous tags', () => {
  /** Every tag ≥1000 that more than one schema names differently. */
  const EXPECTED: Record<number, string[]> = {
    1005: ['uid', 'key'],
    1006: ['nickname', 'value'],
    20002: ['nick', 'groupNick'],
    40010: ['isSender', 'chatType'],
    40020: ['origSenderUid', 'senderUid'],
    40021: ['origReceiverUid', 'peerUid'],
    40900: ['subMsgs', 'msgs'],
    48902: ['info', 'status'],
    60001: ['groupCode', 'groupUin'],
  };

  it('is exactly the known set — a new one means the flat premise slipped', () => {
    const found = [...TAG_DICTIONARY.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([tag]) => tag)
      .sort((a, b) => a - b);
    expect(found).toEqual(
      Object.keys(EXPECTED)
        .map(Number)
        .sort((a, b) => a - b),
    );
  });

  it('returns every candidate name so the UI can list them all', () => {
    for (const [tag, names] of Object.entries(EXPECTED)) {
      const r = lookupTag(Number(tag));
      expect(r.status, `tag ${tag}`).toBe('ambiguous');
      expect(r.names.map((n) => n.name).sort()).toEqual([...names].sort());
    }
  });
});
