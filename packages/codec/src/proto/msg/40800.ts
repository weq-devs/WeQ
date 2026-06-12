/**
 * 40800 — the column that holds the protobuf for one message row's body.
 *
 * The BLOB contains a REPEATED ElementWire envelope. Each tag-40800 entry is
 * exactly one element. C2C and group rows use the same shape here — the
 * row-level differences (sender uid, peer uid, …) live in row.ts schemas
 * for each chat type.
 */

import { ProtoField } from '../../core';
import { ElementWire } from './element';

export const MsgBody = {
  elements: ProtoField(40800, () => ElementWire, { optional: true, repeat: true }),
};
