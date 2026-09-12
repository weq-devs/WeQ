/**
 * Guild (QQ 频道) domain shapes - direct-message (频道私聊) accessors.
 *
 * Two databases are involved:
 *   - `guild_msg.db` carries BOTH the DM conversation list
 *     (`direct_node_list_table`) and the shared message table
 *     (`guild_msg_table`, partitioned by node id 40027).
 *   - `guild1.db` carries the profile cache
 *     (`t_GPro_CommonUserProfile_v2`, keyed by tiny id).
 */

import type { Element, MsgDecoration, PreviewElement } from '@weq/codec';

/** One 频道私聊 conversation row (`direct_node_list_table`). */
export interface GuildDirectSession {
  /**
   * Conversation node id (column 40027 / 40021). This is the ONLY key that
   * reaches `guild_msg_table` rows efficiently (40027 = indexed partition).
   */
  nodeId: bigint;
  /** Column 40022 - the direct route gid (TEXT, primary key). */
  directGid: string;
  /** Column 40050 - newest message time (unix seconds). */
  lastTime: bigint;
  /** Column 40003 - newest message seq. */
  lastSeq: bigint;
  /** Column 42051 - the peer's guild tiny id. */
  peerTinyId: bigint;
  /** Column 42052 - the guild this conversation happened in. */
  guildId: bigint;
  /** Column 42053 - the guild's display name. */
  guildName: string;
  /** Column 42054 - the peer's global (cross-guild) nickname. */
  nickGlobal: string;
  /** Column 42055 - the peer's nickname inside this guild. */
  nickChannel: string;
  /**
   * Column 40051 - cached latest message, decoded into a preview element.
   * Null when the column is empty. Channel elements frequently carry no
   * display text in this cache, so consumers must tolerate an empty view.
   */
  preview: PreviewElement | null;
}

/** One 频道私聊 message row (`guild_msg_table`). */
export interface GuildDirectMsg {
  /** Column 40001 - message id. */
  msgId: bigint;
  /** Column 40003 - per-conversation sequence number. */
  msgSeq: bigint;
  /** Column 40027 - conversation node id (the session key). */
  nodeId: bigint;
  /** Column 40026 (also 40025 as text) - author tiny id. */
  senderTinyId: bigint;
  /**
   * Column 40013 - send origin. 0 = the peer sent it; any other value (2
   * observed) = this account's own device sent it.
   */
  sendType: bigint;
  /** Column 40050 - send time (unix seconds). */
  sendTime: bigint;
  /** Column 40800 - decoded element list. */
  elements: Element[];
  /** Column 40011 - message type. */
  msgType?: bigint;
  /** Column 40012 - message sub type. */
  subType?: bigint;
  /** Column 40801 - per-message decoration (bubble/font/widget). */
  decoration?: MsgDecoration;
}

/** One profile cache row (`guild1.db` -> t_GPro_CommonUserProfile_v2). */
export interface GuildCommonProfile {
  /** Column tiny_id_ - guild tiny id (primary key). */
  tinyId: bigint;
  /** Column nick_name_ - global nickname. */
  nick: string;
  /** Column avatar_meta_ - the avatar handle QQ stores (see avatar URL rules). */
  avatarMeta: string;
}
