/**
 * 43002 — the payload column of `hidden_session_storage_table_v1` (「隐藏聊天」/
 * hidden-session storage: a conversation the user hid from the normal
 * `recent_contact_v3_table` list). Row key is the TEXT column 43001; when a
 * session is hidden it disappears from `recent_contact_v3_table` entirely and
 * only exists here until unhidden.
 *
 * Reverse-engineered from a real android backup (3 rows — small sample, kept
 * conservative): every well-formed row carries chatType(40010) + targetUin
 * (40020) + targetUid(40021), matching the KCHATTYPEC2C=1 convention used
 * elsewhere. One sample row had none of those and only 40021 set to a
 * malformed value (looked like `<selfUid><stray digits>`, not a real uid) —
 * likely a legacy/partial write from an older QQ version; readers must treat
 * a row with a targetUid that doesn't resolve to a known contact as
 * unrenderable rather than guessing its type. The four boolean flags'
 * meaning wasn't pinned down from so few samples (values seen: all-false,
 * or exactly one of 49704/49705 true — plausibly a c2c/group discriminator,
 * but unconfirmed) — kept as raw flags, not renamed.
 */

import { ProtoField, ScalarType } from '../../core';

export const HiddenSessionEntry = {
  chatType: ProtoField(40010, ScalarType.UINT32, { optional: true }),
  targetUin: ProtoField(40020, ScalarType.STRING, { optional: true }),
  targetUid: ProtoField(40021, ScalarType.STRING, { optional: true }),
  flag49702: ProtoField(49702, ScalarType.BOOL, { optional: true }),
  flag49703: ProtoField(49703, ScalarType.BOOL, { optional: true }),
  flag49704: ProtoField(49704, ScalarType.BOOL, { optional: true }),
  flag49705: ProtoField(49705, ScalarType.BOOL, { optional: true }),
};

export const HiddenSessionBody = {
  entry: ProtoField(43002, () => HiddenSessionEntry, { optional: true }),
};
