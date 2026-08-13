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

/**
 * Domain shape for one row of `hidden_session_storage_table_v1` — a
 * conversation the user hid (「隐藏聊天」). Hiding removes the row from
 * `recent_contact_v3_table` entirely; this table is where it lives instead.
 * Carries no timestamp or preview of its own — callers resolve the real
 * last-message time by querying `c2c_msg_table`/`group_msg_table` for
 * `targetUid` (see `HiddenSessionService`).
 */
export interface HiddenSession {
  /** 43001 — row primary key. Opaque storage key, not a display id. */
  storageKey: string;
  /**
   * 40010 (nested in 43002) — mapped ChatType, or `'unknown'` when the field
   * is absent. One sample (of 3, from a real backup) had no chatType/targetUin
   * at all and a `targetUid` that didn't resolve to a real uid — treat
   * `'unknown'` as genuinely unresolvable, not a bug in the reader.
   */
  chatType: string | number;
  /** 40021 — target uid (c2c peer) or group code (group), when present. */
  targetUid: string;
  /** 40020 — target uin (c2c peer QQ number, as text), when present. */
  targetUin: string;
  /**
   * 49702-49705 — four boolean flags whose exact meaning wasn't pinned down
   * from so few samples (plausibly a c2c/group discriminator on 49704/49705,
   * but unconfirmed). Kept raw rather than guessed.
   */
  flags: { f49702: boolean; f49703: boolean; f49704: boolean; f49705: boolean };
}

/**
 * Domain shape for one row of `service_assistant_contact` — a QQ 服务号
 * (service assistant / official notification channel, chatType 118). Distinct
 * from `RecentContact`: rows here never appear in `recent_contact_v3_table`,
 * and the conversation key is a numeric app id (`appId`), not a uid — messages
 * live in `service_assistant_msg_table` partitioned by that same id (see
 * `C2cPartition`'s `appId` variant).
 */
export interface ServiceAssistantContact {
  /** 41102 — numeric app id; the conversation key (matches msg table's 40035). */
  appId: bigint;
  /** 40094 — display name (e.g. "QQ会员", "功能内测通知"). */
  displayName: string;
  /** 41110 — avatar, a direct CDN URL (not uid-derived). */
  avatarUrl: string;
  /** 40050 — last-message time (unix seconds). */
  lastTime: bigint;
  /** 40001 — latest message id (matches a row in service_assistant_msg_table). */
  lastMsgId: bigint;
}
