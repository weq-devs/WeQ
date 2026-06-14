/**
 * 60242 — Column in group_detail_info_ver1 table.
 *
 * Contains group location/address details.
 */

import { ProtoField, ScalarType } from '../../core';

export const GroupAddressBody = {
  /** Tag 60131: Setter UID. */
  setterUid: ProtoField(60131, ScalarType.STRING, { optional: true }),
  /** Tag 60132: Set timestamp. */
  setTimestamp: ProtoField(60132, ScalarType.INT64, { optional: true }),
  /** Tag 60133: Location ID. */
  locationId: ProtoField(60133, ScalarType.INT32, { optional: true }),
  /** Tag 60134: Longitude * 10^6. */
  longitude: ProtoField(60134, ScalarType.INT32, { optional: true }),
  /** Tag 60135: Latitude * 10^6. */
  latitude: ProtoField(60135, ScalarType.INT32, { optional: true }),
  /** Tag 60136: Location name. */
  locationName: ProtoField(60136, ScalarType.STRING, { optional: true }),
};
