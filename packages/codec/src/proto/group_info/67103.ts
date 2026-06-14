/**
 * 67103 — Column in group_member_level_info table.
 *
 * Contains a repeated list of level-to-name mappings.
 */

import { ProtoField, ScalarType } from '../../core';

export const GroupLevelItemWire = {
  /** Tag 67200: Level number (e.g. 1, 2, 3...). */
  level: ProtoField(67200, ScalarType.INT32),
  /** Tag 67201: Level display name (e.g. "潜水", "冒泡"...). */
  levelName: ProtoField(67201, ScalarType.STRING),
};

export const GroupMemberLevelBody = {
  /** Tag 67103: Repeated level items. */
  items: ProtoField(67103, () => GroupLevelItemWire, { repeat: true }),
};
