/**
 * 48902 — Column in online_status_kv_table in misc.db.
 */

import { ProtoField, ScalarType } from '../../core';

/** subType=2000 时已核对；其他扩展状态不套用此结构。 */
export const OnlineStatusCustomWire = {
  faceId: ProtoField(1, ScalarType.UINT32, { optional: true }),
  text: ProtoField(2, ScalarType.STRING, { optional: true }),
  faceType: ProtoField(3, ScalarType.UINT32, { optional: true }),
};

export const OnlineStatusDetailWire = {
  uin: ProtoField(1002, ScalarType.UINT64, { optional: true }),
  uid: ProtoField(20322, ScalarType.STRING, { optional: true }),
  type: ProtoField(20323, ScalarType.INT32, { optional: true }),
  subType: ProtoField(20324, ScalarType.INT32, { optional: true }),
  statusName: ProtoField(20355, ScalarType.STRING, { optional: true }),
  extendedPayload: ProtoField(20337, ScalarType.BYTES, { optional: true }),
};

export const OnlineStatusInnerWire = {
  detail: ProtoField(20320, () => OnlineStatusDetailWire, { optional: true }),
};

export const OnlineStatusBody = {
  /** Tag 48902: Outer wrapper. */
  status: ProtoField(48902, () => OnlineStatusInnerWire, { optional: true }),
};
