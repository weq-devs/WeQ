/**
 * 25011 — Column in category_list_v2 table.
 *
 * This column directly contains repeated tag 25011 items.
 */

import { ProtoField, ScalarType } from '../../core';

export const CategoryItemWire = {
  /** Tag 25007: Category ID/Index. */
  id: ProtoField(25007, ScalarType.INT32, { optional: true }),
  /** Tag 25008: Category display name. */
  name: ProtoField(25008, ScalarType.STRING, { optional: true }),
  /** Tag 25009: Usually same as id. */
  id2: ProtoField(25009, ScalarType.INT32, { optional: true }),
  /** Tag 25010: Number of buddies in this category. */
  buddyCount: ProtoField(25010, ScalarType.INT32, { optional: true }),
};

export const CategoryListBody = {
  /** The root message of the column consists of repeated tag 25011. */
  items: ProtoField(25011, () => CategoryItemWire, { repeat: true }),
};
