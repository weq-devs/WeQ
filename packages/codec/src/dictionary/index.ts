/**
 * Global tag → field-name dictionary, built from every wire schema in
 * `../proto`.
 *
 * QQ NT's protobuf uses tag numbers as a flat namespace once you get past the
 * small ones: a tag above 1000 means the same thing wherever it appears, so a
 * single flat lookup works at ANY depth of a decoded tree — no need to walk a
 * schema hierarchy alongside the bytes. Small tags (1, 2, 3, …) are reused
 * freely by nested messages and carry no global meaning, so we never name them.
 *
 * That premise holds for 665 of the 674 (tag, name) pairs in the tree. The
 * remaining 9 tags genuinely disagree between schemas (40010 is `isSender` on
 * an element but `chatType` in the unread blob, 1005 is `uid` or `key`, …), so
 * `lookupTag` reports those as `ambiguous` with every candidate name rather
 * than silently picking one.
 *
 * MAINTENANCE: new files under `proto/` must be added to `MODULES` below.
 * `import.meta.glob` would automate it but is Vite-only — this package also
 * runs in the Electron main process and under vitest.
 */

import type { ProtoMessageType, ProtoFieldType } from '../core';
import type { ScalarType } from '../core';

import * as collection from '../proto/collection';
import * as groupCustomLabels from '../proto/group_info/60241';
import * as groupAddress from '../proto/group_info/60242';
import * as groupBulletin from '../proto/group_info/64205';
import * as groupMemberLevel from '../proto/group_info/67103';
import * as groupList from '../proto/group_info/group_list';
import * as groupNotify from '../proto/group_info/notify';
import * as recentContact from '../proto/msg/40051';
import * as msgEmoji from '../proto/msg/40062';
import * as msgBody from '../proto/msg/40800';
import * as msgCache from '../proto/msg/40900';
import * as msgUnread from '../proto/msg/48902';
import * as msgElement from '../proto/msg/element';
import * as profileCustomStatus from '../proto/profile/20057';
import * as profileGroupRelation from '../proto/profile/20072';
import * as profileExt from '../proto/profile/21000';
import * as profileCategory from '../proto/profile/25011';
import * as profileOnlineStatus from '../proto/profile/48902';
import * as friendInfo from '../proto/user_info/friend_info';

const MODULES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['collection', collection],
  ['group_info/60241', groupCustomLabels],
  ['group_info/60242', groupAddress],
  ['group_info/64205', groupBulletin],
  ['group_info/67103', groupMemberLevel],
  ['group_info/group_list', groupList],
  ['group_info/notify', groupNotify],
  ['msg/40051', recentContact],
  ['msg/40062', msgEmoji],
  ['msg/40800', msgBody],
  ['msg/40900', msgCache],
  ['msg/48902', msgUnread],
  ['msg/element', msgElement],
  ['profile/20057', profileCustomStatus],
  ['profile/20072', profileGroupRelation],
  ['profile/21000', profileExt],
  ['profile/25011', profileCategory],
  ['profile/48902', profileOnlineStatus],
  ['user_info/friend_info', friendInfo],
];

/** Tags at or below this are position-dependent inside nested messages. */
export const GLOBAL_TAG_MIN = 1001;

/** One schema's take on what a tag means. */
export interface TagName {
  /** Field name as written in the schema. */
  name: string;
  /** Where it was declared, e.g. `msg/element.ElementWire` — shown in tooltips. */
  source: string;
  kind: 'scalar' | 'message';
  /** Only set when `kind === 'scalar'`. */
  scalarType?: ScalarType;
}

/** Same object shape the schema loader in `raw/registry` recognizes. */
function isProtoMessage(v: unknown): v is ProtoMessageType {
  if (!v || typeof v !== 'object') return false;
  const fields = Object.values(v as Record<string, unknown>);
  if (fields.length === 0) return false;
  for (const f of fields) {
    if (!f || typeof f !== 'object') return false;
    const k = (f as { kind?: unknown }).kind;
    if (k !== 'scalar' && k !== 'message') return false;
  }
  return true;
}

function build(): Map<number, TagName[]> {
  const dict = new Map<number, TagName[]>();
  // Nested schemas are reached through `messageRef()` closures and are often
  // not exported; the visited set both gives full coverage and breaks the
  // self-reference cycles (MsgCache.subMsgs → MsgCache).
  const visited = new Set<ProtoMessageType>();

  function record(field: ProtoFieldType, name: string, source: string): void {
    if (field.no < GLOBAL_TAG_MIN) return;
    const entry: TagName = {
      name,
      source,
      kind: field.kind,
      ...(field.kind === 'scalar' ? { scalarType: field.type } : {}),
    };
    const existing = dict.get(field.no);
    if (!existing) {
      dict.set(field.no, [entry]);
      return;
    }
    // Same name from another schema is the expected case — keep one entry.
    if (existing.some((e) => e.name === name)) return;
    existing.push(entry);
  }

  function visit(schema: ProtoMessageType, label: string): void {
    if (visited.has(schema)) return;
    visited.add(schema);
    for (const [name, field] of Object.entries(schema)) {
      record(field, name, label);
      if (field.kind === 'message') {
        visit(field.type(), `${label}.${name}`);
      }
    }
  }

  for (const [path, ns] of MODULES) {
    for (const [exportName, value] of Object.entries(ns)) {
      if (isProtoMessage(value)) visit(value, `${path}.${exportName}`);
    }
  }
  return dict;
}

/** tag → every distinct name declared for it. Only holds tags ≥ {@link GLOBAL_TAG_MIN}. */
export const TAG_DICTIONARY: ReadonlyMap<number, readonly TagName[]> = build();

export type TagStatus =
  /** Below the global-namespace threshold — meaning depends on the parent message. */
  | 'small'
  /** Exactly one schema name. */
  | 'known'
  /** Multiple schemas disagree — all candidates returned. */
  | 'ambiguous'
  /** Above the threshold but never declared anywhere. */
  | 'undefined';

export interface TagLookup {
  status: TagStatus;
  /** Empty unless status is `known` or `ambiguous`. */
  names: readonly TagName[];
}

const EMPTY: readonly TagName[] = [];

export function lookupTag(tag: number): TagLookup {
  if (tag < GLOBAL_TAG_MIN) return { status: 'small', names: EMPTY };
  const names = TAG_DICTIONARY.get(tag);
  if (!names) return { status: 'undefined', names: EMPTY };
  return { status: names.length > 1 ? 'ambiguous' : 'known', names };
}
