/**
 * `collection.db → collection_list_info_table` wire schemas.
 *
 * The two protobuf BLOB columns each wrap their body under a single top-level
 * field whose tag equals the column id:
 *
 *   column 180004  →  { author:  AuthorInfo }
 *   column 180015  →  { content: CollectionContent }   (tagged union, see summary.ts)
 *
 * Decode a row by feeding the raw column bytes to `new ProtoMsg(...)`:
 *
 *   const { author } = new ProtoMsg(CollectionAuthorColumn).decode(blob180004);
 *   const { content } = new ProtoMsg(CollectionContentColumn).decode(blob180015);
 */

import { ProtoField } from '../../core';
import { AuthorInfo } from './common';
import { CollectionContent } from './summary';

/** Column 180004 — author/owner identity envelope. */
export const CollectionAuthorColumn = {
  author: ProtoField(180004, () => AuthorInfo, { optional: true }),
};

/** Column 180015 — content summary union. */
export const CollectionContentColumn = {
  content: ProtoField(180015, () => CollectionContent, { optional: true }),
};

export * from './common';
export * from './summary';
