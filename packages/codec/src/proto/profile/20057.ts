/**
 * 20057 — Column in profile_info_v6 table.
 *
 * Custom user status.
 */

import { ProtoField, ScalarType } from '../../core';

export const CustomStatusInnerWire = {
  /** Tag 1: Status ID. */
  id: ProtoField(1, ScalarType.INT32, { optional: true }),
  /** Tag 2: Status description string. */
  desc: ProtoField(2, ScalarType.STRING, { optional: true }),
};

export const CustomStatusBody = {
  /** Tag 20057: Outer wrapper. */
  status: ProtoField(20057, () => CustomStatusInnerWire, { optional: true }),
};
