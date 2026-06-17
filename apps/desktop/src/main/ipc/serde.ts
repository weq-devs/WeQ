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

import type { C2cMsg, GroupMsg, RecentContact, UserProfile, GroupDetail, GroupMember } from '@weq/db';
import type { SetEmojiItem } from '@weq/codec';
import type { RenderC2cMsg, RenderGroupMsg } from '@weq/service';

export interface UserProfileWire {
  uid: string;
  qid: string;
  uin: string;
  nick: string;
  avatarUrl: string;
  gender: number;
  age: number;
  signature: string;
  remark: string;
}

export interface GroupDetailWire {
  groupCode: string;
  groupName: string;
  pinnedAnnounce: string;
  description: string;
  remark: string;
  ownerUid: string;
  createTime: number;
}

export interface GroupMemberWire {
  groupCode: string;
  uid: string;
  uin: string;
  card: string;
  nick: string;
  joinTime: number;
  lastSpeakTime: number;
  muteUntil: number;
  adminFlag: number;
  memberFlag: number;
  customTitle: string;
  memberLevel: number;
}

/**
 * Unified chat-message wire shape for both c2c and group. `conv` is the
 * conversation key the renderer uses (peer uid for c2c, group code for group),
 * and `msgSeq` (column 40003) drives the renderer's seq-window model.
 */
export interface ChatMsgWire {
  kind: 'c2c' | 'group';
  msgId: string;
  msgSeq: string;
  /** Conversation key: peer uid (c2c) or group code (group). */
  conv: string;
  senderUid: string;
  senderUin: string;
  sendTime: string;
  elements: unknown[];
  /** Sticker reactions (贴表情, column 40062); group-only, omitted when none. */
  setEmojiList?: SetEmojiItem[];
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

export function c2cMsgToWire(m: RenderC2cMsg): ChatMsgWire {
  return {
    kind: 'c2c',
    msgId: m.msgId.toString(),
    msgSeq: m.msgSeq.toString(),
    conv: m.targetUid,
    senderUid: m.senderUid,
    senderUin: m.senderUin.toString(),
    sendTime: m.sendTime.toString(),
    elements: sanitize(m.elements),
  };
}

export function groupMsgToWire(m: RenderGroupMsg): ChatMsgWire {
  return {
    kind: 'group',
    msgId: m.msgId.toString(),
    msgSeq: m.msgSeq.toString(),
    conv: m.targetGroupCode,
    senderUid: m.senderUid,
    senderUin: m.senderUin.toString(),
    sendTime: m.sendTime.toString(),
    elements: sanitize(m.elements),
    setEmojiList: m.setEmojiList,
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

export function userProfileToWire(p: UserProfile): UserProfileWire {
  return {
    uid: p.uid,
    qid: p.qid,
    uin: p.uin.toString(),
    nick: p.nick,
    avatarUrl: p.avatarUrl,
    gender: p.gender,
    age: p.age,
    signature: p.signature,
    remark: p.remark,
  };
}

export function groupDetailToWire(d: GroupDetail): GroupDetailWire {
  return {
    groupCode: d.groupCode.toString(),
    groupName: d.groupName,
    pinnedAnnounce: d.pinnedAnnounce,
    description: d.description,
    remark: d.remark,
    ownerUid: d.ownerUid,
    createTime: d.createTime,
  };
}

export function groupMemberToWire(m: GroupMember): GroupMemberWire {
  return {
    groupCode: m.groupCode.toString(),
    uid: m.uid,
    uin: m.uin.toString(),
    card: m.card,
    nick: m.nick,
    joinTime: m.joinTime,
    lastSpeakTime: m.lastSpeakTime,
    muteUntil: m.muteUntil,
    adminFlag: m.adminFlag,
    memberFlag: m.memberFlag,
    customTitle: m.customTitle,
    memberLevel: m.memberLevel,
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
    return Buffer.from(v).toString('hex');
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
