/**
 * `msg` — message-table accessors.
 *
 * One file per chat type (c2c.ts / group.ts) plus forward.ts for the 40900
 * cache. All decode the 40800 BLOB through `@weq/codec` and surface the typed
 * `*Msg` shapes defined in `types.ts`.
 */

export { C2cMsgDb } from './c2c';
export type { C2cMsgDbOptions } from './c2c';

export { GroupMsgDb } from './group';
export type { GroupMsgDbOptions } from './group';

export { ForwardMsgDb } from './forward';
export type { ForwardMsgDbOptions } from './forward';

export type { C2cMsg, GroupMsg } from './types';
