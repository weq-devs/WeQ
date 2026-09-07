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
 * One (peer, calendar-day) bucket of private-chat messages — the atomic unit
 * for the annual report's private-chat highlights page. Direction is derived
 * per row with the same rule as `countByDirection` (40021 is always the peer,
 * so a row whose senderUid differs from the peer was sent by the account).
 */
export interface C2cPeerDayTally {
  /** Conversation peer (column 40021). */
  peerUid: string;
  /** Local calendar day, `YYYY-MM-DD` (derived in SQL with 'localtime'). */
  date: string;
  /** Both sides combined. */
  total: number;
  /** Messages sent by the account itself on that day/peer. */
  mine: number;
}

/**
 * 一「套」装扮（气泡 + 字体 + 挂件的一个具体组合）在时间窗内的使用情况。
 *
 * 以套为单位而不是三类分开统计，是因为 40801 这一列本身记的就是一套：用户当时把
 * 哪个气泡配哪个字体配哪个挂件发了这条消息。年度报告要还原的是「那条消息当年长
 * 什么样」，拆成三张榜就没有那个画面了。
 */
export interface DressOutfitTally {
  /** 0 = 这一项没穿。 */
  bubbleId: number;
  fontId: number;
  widgetId: number;
  /** 穿这套发出的消息条数。 */
  count: number;
  /**
   * 穿这套发出的**真实消息纯文本**样本（已清洗、已截断，见 `tallyDressBlobs`）。
   * 报告拿它把当年的消息重新画一遍 —— 这是整页回忆感的来源。
   */
  samples: string[];
  /** 这套第一次 / 最后一次出现的 sendTime（unix 秒）。0 = 未知。 */
  firstTime: number;
  lastTime: number;
}

/**
 * 装扮使用计数 —— 列 40801 在一个时间窗内的聚合，年度报告「最喜欢的装扮」的原始素材。
 *
 * 三张表各自算一份，调用方相加即可（{@link mergeDressTally}）。计数单位是**消息条数**
 * 而不是「用过几天」：一条消息同时带气泡 + 字体 + 挂件时，三个 map 各加一次，所以
 * 三类的和大于 {@link decorated}。
 *
 * `outfits` 是给报告用的主视图（按套），三个单类 map 只剩「一共穿过几款气泡/字体/
 * 挂件」这类概述用途。
 */
export interface DressTally {
  /** 气泡 itemId → 用它发出的消息条数。 */
  bubble: Record<number, number>;
  /** 聊天字体 itemId → 条数。40801 里字体有 41525 / 41531 两个 tag，解码已归一。 */
  font: Record<number, number>;
  /** 头像挂件 itemId → 条数。 */
  widget: Record<number, number>;
  /** 至少带一项装扮的消息条数 —— 不是三类之和（一条消息可以三项齐全）。 */
  decorated: number;
  /** `"bubbleId:fontId:widgetId"` → 这套的使用情况。 */
  outfits: Record<string, DressOutfitTally>;
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
