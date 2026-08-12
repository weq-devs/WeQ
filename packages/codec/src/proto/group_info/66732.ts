/**
 * 66732 — Column in group_ext_list table.
 *
 * Stores the group owner's identity as a nested protobuf:
 *   outer tag 66732 (LEN) → inner { tag 60002: ownerUid, tag 66530: ownerUin }
 */

import { ProtoField, ScalarType } from '../../core';

export const GroupOwnerInfoItemWire = {
  /** Tag 60002: Owner NT-UID string (e.g. "u_Qki1LVaNHR4D7u60dkLRg"). */
  ownerUid: ProtoField(60002, ScalarType.STRING, { optional: true }),
  /** Tag 66530: Owner QQ number (legacy numeric UIN). */
  ownerUin: ProtoField(66530, ScalarType.INT64, { optional: true }),
};

export const GroupOwnerInfoBody = {
  /** Tag 66732: Wrapper field — same number as the column itself. */
  ownerInfo: ProtoField(66732, () => GroupOwnerInfoItemWire, { optional: true }),
};
