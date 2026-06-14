/**
 * 60241 — Column in group_detail_info_ver1 table.
 *
 * Contains a repeated list of custom group labels.
 */

import { ProtoField, ScalarType } from '../../core';

export const GroupCustomLabelItemWire = {
  /** Tag 60001: Group code. */
  groupCode: ProtoField(60001, ScalarType.INT64, { optional: true }),
  /** Tag 60121: Setter UID. */
  setterUid: ProtoField(60121, ScalarType.STRING, { optional: true }),
  /** Tag 60122: Label index/id. */
  labelId: ProtoField(60122, ScalarType.STRING, { optional: true }),
  /** Tag 60123: Set timestamp. */
  setTimestamp: ProtoField(60123, ScalarType.INT64, { optional: true }),
  /** Tag 60127: Label content. */
  content: ProtoField(60127, ScalarType.STRING, { optional: true }),
};

export const GroupCustomLabelsBody = {
  /** Tag 60241: Repeated custom labels. */
  labels: ProtoField(60241, () => GroupCustomLabelItemWire, { repeat: true }),
};
