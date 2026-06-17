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

import type {
  Buddy,
  BuddyMsgFtsHit,
  BuddyRequest,
  Category,
  C2cMsg,
  GroupBulletin,
  GroupDetail,
  GroupEssence,
  GroupMember,
  GroupMemberLevelInfo,
  GroupMsg,
  RecentContact,
  UserProfile,
} from '@weq/db';
import type { MsgCacheRecord, SetEmojiItem } from '@weq/codec';
import type { FormattedOnlineStatus, RenderC2cMsg, RenderGroupMsg } from '@weq/service';

export interface UserProfileWire {
  uid: string;
  qid: string;
  uin: string;
  nick: string;
  avatarUrl: string;
  birthYear: number;
  birthMonth: number;
  birthDay: number;
  gender: number;
  age: number;
  signature: string;
  remark: string;
  intimacy: number;
  sigUpdateTime: number;
  isFriend: boolean;
  customStatus?: {
    id?: number;
    desc?: string;
  };
  extRelation?: {
    preselectedIds: number[];
    displayId?: number;
  };
}

export interface GroupDetailWire {
  groupCode: string;
  groupName: string;
  pinnedAnnounce: string;
  description: string;
  remark: string;
  ownerUid: string;
  createTime: number;
  maxMemberCount: number;
  memberCount: number;
  labels: string;
  entranceQ: string;
  leaveFlag: number;
  customLabels: Array<{
    groupCode?: string;
    setterUid?: string;
    labelId?: string;
    setTimestamp?: string;
    content?: string;
  }>;
  address?: {
    setterUid?: string;
    setTimestamp?: string;
    locationId?: number;
    longitude?: number;
    latitude?: number;
    locationName?: string;
  };
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

export interface BuddyWire {
  uid: string;
  qid: string;
  uin: string;
  categoryId: number;
}

export interface CategoryWire {
  id: number;
  name: string;
  buddyCount: number;
}

export interface BuddyRequestWire {
  timestamp: number;
  peerUid: string;
  nick: string;
  isAccepted: number;
  verifyMsg: string;
  source: string;
  status: number;
  sourceGroupCode: string;
  initiator: number;
}

export interface GroupBulletinWire {
  groupCode: string;
  publisherUid: string;
  fid: string;
  msgTime: string;
  ctime: string;
  textContent: string;
}

export interface GroupEssenceWire {
  groupCode: string;
  msgSeq: number;
  msgRandom: number;
  senderUin: string;
  senderNick: string;
  setStatus: number;
  operatorUin: string;
  operatorNick: string;
  timestamp: number;
}

export interface GroupLevelConfigItemWire {
  level: number;
  levelName: string;
}

export interface GroupMemberLevelInfoWire {
  groupCode: string;
  memberLevel: number;
  levelConfigs: GroupLevelConfigItemWire[];
}

export interface MsgSearchHitWire {
  msgId: string;
  chatType: number;
  targetUid: string;
  senderUid: string;
  sendTime: string;
  content: string;
  fileName?: string;
}

export interface OnlineStatusWire extends FormattedOnlineStatus {}

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
    birthYear: p.birthYear,
    birthMonth: p.birthMonth,
    birthDay: p.birthDay,
    gender: p.gender,
    age: p.age,
    signature: p.signature,
    remark: p.remark,
    intimacy: p.intimacy,
    sigUpdateTime: p.sigUpdateTime,
    isFriend: p.isFriend,
    customStatus: p.customStatus,
    extRelation: p.extRelation,
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
    maxMemberCount: d.maxMemberCount,
    memberCount: d.memberCount,
    labels: d.labels,
    entranceQ: d.entranceQ,
    leaveFlag: d.leaveFlag,
    customLabels: d.customLabels.map((label) => ({
      groupCode: label.groupCode?.toString(),
      setterUid: label.setterUid,
      labelId: label.labelId,
      setTimestamp: label.setTimestamp?.toString(),
      content: label.content,
    })),
    address: d.address
      ? {
          setterUid: d.address.setterUid,
          setTimestamp: d.address.setTimestamp?.toString(),
          locationId: d.address.locationId,
          longitude: d.address.longitude,
          latitude: d.address.latitude,
          locationName: d.address.locationName,
        }
      : undefined,
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

export function buddyToWire(b: Buddy): BuddyWire {
  return {
    uid: b.uid,
    qid: b.qid,
    uin: b.uin.toString(),
    categoryId: b.categoryId,
  };
}

export function categoryToWire(c: Category): CategoryWire {
  return {
    id: c.id,
    name: c.name,
    buddyCount: c.buddyCount,
  };
}

export function buddyRequestToWire(r: BuddyRequest): BuddyRequestWire {
  return {
    timestamp: r.timestamp,
    peerUid: r.peerUid,
    nick: r.nick,
    isAccepted: r.isAccepted,
    verifyMsg: r.verifyMsg,
    source: r.source,
    status: r.status,
    sourceGroupCode: r.sourceGroupCode.toString(),
    initiator: r.initiator,
  };
}

export function groupBulletinToWire(b: GroupBulletin): GroupBulletinWire {
  return {
    groupCode: b.groupCode.toString(),
    publisherUid: b.publisherUid,
    fid: b.fid,
    msgTime: b.msgTime.toString(),
    ctime: b.ctime.toString(),
    textContent: b.textContent,
  };
}

export function groupEssenceToWire(e: GroupEssence): GroupEssenceWire {
  return {
    groupCode: e.groupCode.toString(),
    msgSeq: e.msgSeq,
    msgRandom: e.msgRandom,
    senderUin: e.senderUin.toString(),
    senderNick: e.senderNick,
    setStatus: e.setStatus,
    operatorUin: e.operatorUin.toString(),
    operatorNick: e.operatorNick,
    timestamp: e.timestamp,
  };
}

export function groupMemberLevelInfoToWire(info: GroupMemberLevelInfo): GroupMemberLevelInfoWire {
  return {
    groupCode: info.groupCode.toString(),
    memberLevel: info.memberLevel,
    levelConfigs: info.levelConfigs.map((item) => ({
      level: item.level,
      levelName: item.levelName,
    })),
  };
}

export function msgSearchHitToWire(hit: BuddyMsgFtsHit): MsgSearchHitWire {
  return {
    msgId: hit.msgId.toString(),
    chatType: hit.chatType,
    targetUid: hit.targetUid,
    senderUid: hit.senderUid,
    sendTime: hit.sendTime.toString(),
    content: hit.content,
    fileName: hit.fileName,
  };
}

export function onlineStatusToWire(status: FormattedOnlineStatus): OnlineStatusWire {
  return status;
}

export function forwardRecordToWire(record: MsgCacheRecord): unknown {
  return sanitize(record);
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
