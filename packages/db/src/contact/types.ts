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
  /**
   * 41148 — the peer's group card, populated on temp c2c-from-group rows
   * (a stranger who messaged you out of a shared group). Empty elsewhere.
   */
  targetGroupNick: string;
  /**
   * 41220 — message-notify level. 1 = notify normally; other values
   * (observed 4) mean 免打扰/muted. Consumers derive a boolean from this
   * (see the renderer's mute resolution).
   */
  notifyLevel: number;
  /**
   * 60001 — the group a temp c2c conversation was started from. 0 when the
   * conversation isn't a temp session.
   */
  tempSourceGroupCode: bigint;
}

/**
 * Domain shape for one row of `recent_contact_top_table` — one pinned (置顶)
 * conversation. The table carries no display info at all; it's a pin registry
 * that consumers join against `RecentContact` via `targetId`.
 */
export interface RecentContactTop {
  /** 41145 — row primary key. Not a conversation identifier. */
  id: bigint;
  /** 40010 — mapped ChatType (same enum as `RecentContact.chatType`). */
  chatType: string | number;
  /** 41103 — when the pin was applied (unix seconds). Pin ordering key. */
  topTime: bigint;
  /** 1000 — c2c peer uid. Empty on group rows. */
  peerUid: string;
  /** 60001 — group code. 0 on c2c rows. */
  groupCode: bigint;
  /**
   * The conversation key, matching `RecentContact.targetUid`: peer uid for c2c,
   * group code (as a string) for groups. Empty if the row has neither.
   */
  targetId: string;
}
