/**
 * Helpers to stringify `bigint` (and bytes) at the IPC boundary.
 *
 * tRPC v11 + electron-trpc 0.7 don't agree on transformer wiring yet, so we
 * ship `bigint` as `string`. Conversion is done here once per router shape —
 * keeps the IPC contract explicit.
 *
 * Renderer-side: every uin / msgId / sendTime arrives as `string`; the
 * renderer can `BigInt(s)` back if it needs arithmetic. Display code is no-op.
 */

import type { C2cMsg, GroupMsg, RecentContact } from '@weq/db';

export interface C2cMsgWire {
  msgId: string;
  targetUid: string;
  targetUin: string;
  senderUid: string;
  senderUin: string;
  sendTime: string;
  elements: unknown[];
}

export interface GroupMsgWire {
  msgId: string;
  targetGroupCode: string;
  senderUid: string;
  senderUin: string;
  sendTime: string;
  elements: unknown[];
}

export interface RecentContactWire {
  /** Mapped ChatType name (or raw number). */
  chatType: string | number;
  senderUid: string;
  targetUid: string;
  /** Peer QQ uin for c2c (string); "0" when absent (e.g. groups/guilds). */
  targetUin: string;
  sendTime: string;
  /** Sanitized preview element (carries `displayText`), or null. */
  preview: unknown | null;
  senderDisplayName: string;
  senderNick: string;
  targetDisplayName: string;
  senderRemark: string;
  /** Local absolute path to the avatar file (unused by the renderer for now). */
  targetAvatar: string;
  targetRemark: string;
}

export function msgToWire(m: C2cMsg): C2cMsgWire {
  return {
    msgId: m.msgId.toString(),
    targetUid: m.targetUid,
    targetUin: m.targetUin.toString(),
    senderUid: m.senderUid,
    senderUin: m.senderUin.toString(),
    sendTime: m.sendTime.toString(),
    elements: sanitize(m.elements),
  };
}

export function groupMsgToWire(m: GroupMsg): GroupMsgWire {
  return {
    msgId: m.msgId.toString(),
    targetGroupCode: m.targetGroupCode,
    senderUid: m.senderUid,
    senderUin: m.senderUin.toString(),
    sendTime: m.sendTime.toString(),
    elements: sanitize(m.elements),
  };
}

export function recentContactToWire(c: RecentContact): RecentContactWire {
  return {
    chatType: c.chatType,
    senderUid: c.senderUid,
    targetUid: c.targetUid,
    targetUin: c.targetUin.toString(),
    sendTime: c.sendTime.toString(),
    preview: c.preview ? sanitize(c.preview) : null,
    senderDisplayName: c.senderDisplayName,
    senderNick: c.senderNick,
    targetDisplayName: c.targetDisplayName,
    senderRemark: c.senderRemark,
    targetAvatar: c.targetAvatar,
    targetRemark: c.targetRemark,
  };
}

/**
 * Deep-sanitize any object to be IPC-safe.
 * - Uint8Array -> hex string
 * - bigint -> string
 */
function sanitize(v: any): any {
  if (v === null || v === undefined) return v;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) {
    return Array.from(v)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  if (Array.isArray(v)) return v.map(sanitize);
  if (typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v)) {
      out[k] = sanitize(v[k]);
    }
    return out;
  }
  return v;
}
