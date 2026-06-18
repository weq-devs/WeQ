/**
 * Domain `RecentContact` shape — one row of `recent_contact_v3_table`, i.e.
 * one conversation in the recent-chats list.
 *
 * Column origins are noted per-field. The 40051 BLOB is decoded by `@weq/codec`
 * into a `PreviewElement` (the latest message rendered as an element, carrying
 * the out-of-conversation display text). Numeric ids/timestamps stay `bigint`
 * to preserve 64-bit precision; the service layer stringifies at the JSON
 * boundary.
 */

import type { PreviewElement } from '@weq/codec';

export interface RecentContact {
  /** 40003 — message sequence number. */
  msgSeq: bigint;
  /** 40010 — mapped ChatType (enum member name, or raw number if out of range). */
  chatType: string | number;
  /** 40020 — sender uid. */
  senderUid: string;
  /** 40021 — conversation target uid (peer uid for c2c, group code for group). */
  targetUid: string;
  /** 40030 — conversation target QQ uin (peer uin for c2c; 0 when absent). */
  targetUin: bigint;
  /** 40050 — latest message timestamp (unix seconds). */
  sendTime: bigint;
  /** 40051 — latest-message preview element (carries displayText). null if absent / undecodable. */
  preview: PreviewElement | null;
  /** 40090 — sender display name (mainly the group card). */
  senderDisplayName: string;
  /** 40093 — sender nickname. */
  senderNick: string;
  /** 40094 — conversation display name. */
  targetDisplayName: string;
  /** 40095 — sender's remark name. */
  senderRemark: string;
  /** 41110 — conversation avatar. */
  targetAvatar: string;
  /** 41135 — conversation remark name. */
  targetRemark: string;
}
