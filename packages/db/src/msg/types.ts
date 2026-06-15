/**
 * Domain `*Msg` shapes — what consumers above the db layer see.
 *
 * The codec decoded the 40800 protobuf BLOB into `Element[]`; the db class
 * pulls the row columns (msgId, target, sender, sendTime) and assembles them
 * with the decoded elements into these shapes.
 *
 * `target*` identifies the conversation: for c2c it's the peer, for group it's
 * the group. Numeric ids stay `bigint` to preserve 64-bit precision; the
 * service stringifies them at the JSON boundary.
 */

import type { Element, SetEmojiItem } from '@weq/codec';

export interface C2cMsg {
  msgId: bigint;
  /** Conversation target — peer uid (column 40021). */
  targetUid: string;
  /** Conversation target — peer QQ uin (column 40030). */
  targetUin: bigint;
  /** Sender uid (column 40020). */
  senderUid: string;
  /** Sender QQ uin (column 40033). */
  senderUin: bigint;
  /** Seconds since epoch (column 40050). */
  sendTime: bigint;
  elements: Element[];
}

export interface GroupMsg {
  msgId: bigint;
  /** Conversation target — group code / 群号 (column 40021). */
  targetGroupCode: string;
  /** Sender uid (column 40020). */
  senderUid: string;
  /** Sender QQ uin (column 40033). */
  senderUin: bigint;
  /** Seconds since epoch (column 40050). */
  sendTime: bigint;
  elements: Element[];
  setEmojiList?: SetEmojiItem[];
}

/**
 * One hit from the full-text-search index (`buddy_msg_fts` table).
 *
 * The FTS table stores already-flattened plain text per message — no 40800
 * protobuf BLOB to decode, just the `content` column (41701). The other
 * columns are the identity keys needed to locate the original message in
 * `nt_msg.db`.
 */
export interface BuddyMsgFtsHit {
  /** Message id (column 40001) — joins back to c2c/group msg tables. */
  msgId: bigint;
  /** Chat type (column 40010) — value of `ChatType` (1 = c2c, 2 = group, …). */
  chatType: number;
  /** Conversation target — peer uid for c2c, group code for group (column 40021). */
  targetUid: string;
  /** Sender uid (column 40020). */
  senderUid: string;
  /** The flattened, searchable message text (column 41701). */
  content: string;
}
