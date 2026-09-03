/**
 * `direct_node_list_table.40051` (guild_msg.db) - QQ channel DM list preview.
 *
 * Unlike the c2c/group recent-contact preview (`RecentContactBody`, which
 * stores `PreviewElementWire` directly under top-level tag 40051), the guild
 * cache wraps the WHOLE latest "node" message in an envelope: each top-level
 * 40051 is a message record (msgType / ids / time / hash) whose own repeated
 * 40051 carries the `PreviewElementWire`(s). QQ typically persists a single
 * element whose displayText (49093) is what the conversation list renders,
 * e.g. "[动画表情]".
 */

import { ProtoField, ScalarType } from '../../core';
import { PreviewElementWire } from '../msg/element';

/** One guild-DM "latest message" envelope inside the preview column. */
export const DirectNodePreviewEnvelope = {
  /** Message type (tag 40011). */
  msgType: ProtoField(40011, ScalarType.UINT32, { optional: true }),
  /** Peer guild tiny id, text form (tag 40020). */
  peerIdText: ProtoField(40020, ScalarType.STRING, { optional: true }),
  /** Conversation node id, text form (tag 40021). */
  nodeIdText: ProtoField(40021, ScalarType.STRING, { optional: true }),
  /** Direct route gid, text form (tag 40022). */
  directGid: ProtoField(40022, ScalarType.STRING, { optional: true }),
  /** Send status (tag 40041; 2 = success). */
  sendStatus: ProtoField(40041, ScalarType.UINT32, { optional: true }),
  /** Send time, unix seconds (tag 40050). */
  sendTime: ProtoField(40050, ScalarType.UINT32, { optional: true }),
  /** Cached preview element(s), same wire shape as PreviewElementWire. */
  elements: ProtoField(40051, () => PreviewElementWire, { optional: true, repeat: true }),
  /** Opaque hash pair (tags 40090 / 40093), observed identical. */
  hash40090: ProtoField(40090, ScalarType.STRING, { optional: true }),
  hash40093: ProtoField(40093, ScalarType.STRING, { optional: true }),
};

/** The preview column BLOB: repeated 40051 envelope records. */
export const DirectNodePreviewBody = {
  nodes: ProtoField(40051, () => DirectNodePreviewEnvelope, { optional: true, repeat: true }),
};
