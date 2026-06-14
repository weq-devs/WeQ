/**
 * 20072 — Column in profile_info_v6 table.
 *
 * Extension relations (e.g. BFF, couples, etc.).
 */

import { ProtoField, ScalarType } from '../../core';

export const GroupRelationInnerWire = {
  /** Tag 20073: Preselected relation IDs. */
  preselectedIds: ProtoField(20073, ScalarType.INT32, { repeat: true }),
  /** Tag 20074: Display relation ID. */
  displayId: ProtoField(20074, ScalarType.INT32, { optional: true }),
};

export const GroupRelationBody = {
  /** Tag 20072: Outer wrapper. */
  relation: ProtoField(20072, () => GroupRelationInnerWire, { optional: true }),
};
