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

import type { Element, SetEmojiItem, MsgDecoration } from '@weq/codec';

export interface C2cMsg {
  msgId: bigint;
  /** In-conversation sequence number (column 40003). */
  msgSeq: bigint;
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
  /**
   * Message type (column 40011). QQ rewrites this to 1 on recall/delete;
   * paired with {@link subType} it forms the `(1,1)` deleted signature.
   * Optional: only the render read-paths select it (SELECT_COLUMNS).
   */
  msgType?: bigint;
  /** Sub message type (column 40012); see {@link msgType}. */
  subType?: bigint;
  /** Per-message decoration (column 40801): bubble/font/widget itemIds. */
  decoration?: MsgDecoration;
}

export interface GroupMsg {
  msgId: bigint;
  /** In-group sequence number (column 40003). */
  msgSeq: bigint;
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
  /**
   * Message type (column 40011). QQ rewrites this to 1 on recall/delete;
   * paired with {@link subType} it forms the `(1,1)` deleted signature.
   * Optional: only the render read-paths select it (SELECT_COLUMNS).
   */
  msgType?: bigint;
  /** Sub message type (column 40012); see {@link msgType}. */
  subType?: bigint;
  /** Per-message decoration (column 40801): bubble/font/widget itemIds. */
  decoration?: MsgDecoration;
}

/**
 * The conversation's seq window for a time range, returned by
 * `*MsgDb.listSeqDesc` — powers the export 「消息补全」seq 空窗扫描.
 *
 * `seqs` holds only the seqs (40003 > 0) whose sendTime (40050) falls inside
 * the requested window; `below` / `above` are the boundary anchors outside it
 * (newest older-than-`start`, oldest newer-than-`end`), used to clamp the
 * backfill's bottom gap so it doesn't pull the whole pre-window history.
 */
export interface SeqWindow {
  /** Seq whose sendTime ∈ [startTime, endTime], newest-first. */
  seqs: bigint[];
  /** Newest seq with sendTime < startTime; null when no start bound or none exists. */
  below: bigint | null;
  /** Oldest seq with sendTime > endTime; null when no end bound or none exists. */
  above: bigint | null;
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
  /**
   * In-conversation sequence (column 40003) — identical to the main msg table's
   * msgSeq for the same msgId, so it can drive a reply-style jump straight from
   * the search hit (no msgId→seq reverse lookup needed).
   */
  msgSeq: bigint;
  /** Chat type (column 40010) — value of `ChatType` (1 = c2c, 2 = group, …). */
  chatType: number;
  /** Conversation target — peer uid for c2c, group code for group (column 40021). */
  targetUid: string;
  /** Sender uid (column 40020). */
  senderUid: string;
  /** Seconds since epoch (column 40050). */
  sendTime: bigint;
  /** The flattened, searchable message text (column 41701). */
  content: string;
  /** Optional file name (column 41702). */
  fileName?: string;
}
