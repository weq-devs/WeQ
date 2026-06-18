/**
 * `msg` — message-table accessors.
 *
 * One file per chat type (c2c.ts / group.ts) plus forward.ts for the 40900
 * cache and buddy_msg_fts.ts for the full-text-search index. The msg-table
 * accessors decode the 40800 BLOB through `@weq/codec` and surface the typed
 * `*Msg` shapes defined in `types.ts`.
 */

export { C2cMsgDb } from './c2c';
export type { C2cMsgDbOptions, C2cPartition } from './c2c';

export { GroupMsgDb } from './group';
export type { GroupMsgDbOptions } from './group';

export { ForwardMsgDb } from './forward';
export type { ForwardMsgDbOptions } from './forward';

export { BuddyMsgFtsDb } from './buddy_msg_fts';
export type { BuddyMsgFtsDbOptions } from './buddy_msg_fts';

export { GroupMsgFtsDb } from './group_msg_fts';
export type { GroupMsgFtsDbOptions } from './group_msg_fts';

export { decodeBody } from './util';
export type { C2cMsg, GroupMsg, BuddyMsgFtsHit } from './types';
