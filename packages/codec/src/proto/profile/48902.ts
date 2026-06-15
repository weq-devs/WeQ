/**
 * 48902 — Column in online_status_kv_table in misc.db.
 */

import { ProtoField, ScalarType } from '../../core';

export const OnlineStatusWeatherWire = {
  weather: ProtoField(1, ScalarType.STRING, { optional: true }),
  locationId: ProtoField(2, ScalarType.STRING, { optional: true }),
  zipCode: ProtoField(3, ScalarType.INT32, { optional: true }),
  updateTime: ProtoField(4, ScalarType.UINT64, { optional: true }),
  city: ProtoField(5, ScalarType.STRING, { optional: true }),
  area: ProtoField(6, ScalarType.STRING, { optional: true }),
  weatherDesc: ProtoField(9, ScalarType.STRING, { optional: true }),
};

export const OnlineStatusDetailWire = {
  uin: ProtoField(1002, ScalarType.UINT64, { optional: true }),
  uid: ProtoField(20322, ScalarType.STRING, { optional: true }),
  type: ProtoField(20323, ScalarType.INT32, { optional: true }),
  subType: ProtoField(20324, ScalarType.INT32, { optional: true }),
  statusName: ProtoField(20355, ScalarType.STRING, { optional: true }),
  weather: ProtoField(20337, () => OnlineStatusWeatherWire, { optional: true }),
};

export const OnlineStatusInnerWire = {
  detail: ProtoField(20320, () => OnlineStatusDetailWire, { optional: true }),
};

export const OnlineStatusBody = {
  /** Tag 48902: Outer wrapper. */
  status: ProtoField(48902, () => OnlineStatusInnerWire, { optional: true }),
};
