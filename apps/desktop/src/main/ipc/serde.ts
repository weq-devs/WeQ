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
  GroupNotify,
  RecentContact,
  UserProfile,
} from '@weq/db';
import { decodeElement, type MsgCacheRecord, type SetEmojiItem } from '@weq/codec';
import { toRenderElements, type FormattedOnlineStatus, type RenderC2cMsg, type RenderGroupMsg } from '@weq/service';
import type { GroupNotice } from '@weq/service';

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

export interface GroupNotifyWire {
  msgTime: number;
  status: number;
  verifyStatus: number;
  groupUin: string;
  groupName: string;
  operatedUid: string;
  operatedNick: string;
  operatorUid: string;
  operatorNick: string;
  opTime: number;
  remark: string;
  systemRemark: string;
  sourceTable: string;
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
  /** In-conversation seq (column 40003) — the jump anchor for click-to-locate. */
  msgSeq: string;
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
  /** Latest message seq (string). */
  msgSeq: string;
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
    msgSeq: c.msgSeq.toString(),
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
    // Only surface a real remote avatar URL. The profile DB's stored value
    // (field 20004) is often a chat-CDN token that only a live QQ can
    // complete — useless to the renderer and a guaranteed 404 for static
    // (offline) accounts. The UI derives a stable avatar from the uin instead.
    avatarUrl: /^https?:\/\//i.test(p.avatarUrl) ? p.avatarUrl : '',
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

export function groupNotifyToWire(n: GroupNotify): GroupNotifyWire {
  return {
    msgTime: n.msgTime,
    status: n.status,
    verifyStatus: n.verifyStatus,
    groupUin: n.groupInfo?.groupUin.toString() ?? '0',
    groupName: n.groupInfo?.groupName ?? '',
    operatedUid: n.operatedUser?.uid ?? '',
    operatedNick: n.operatedUser?.nick ?? '',
    operatorUid: n.operatorUser?.uid ?? '',
    operatorNick: n.operatorUser?.nick ?? '',
    opTime: n.opTime,
    remark: n.remark,
    systemRemark: n.systemRemark,
    sourceTable: n.sourceTable,
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

export function groupNoticeToBulletinWire(
  notice: GroupNotice,
  groupCode: string,
): GroupBulletinWire {
  return {
    groupCode,
    publisherUid: notice.senderId.toString(),
    fid: notice.noticeId,
    msgTime: notice.publishTime.toString(),
    ctime: notice.publishTime.toString(),
    textContent: notice.text,
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
    msgSeq: hit.msgSeq.toString(),
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

/**
 * Convert one 40900 cache record to a renderer-friendly wire shape.
 *
 * The renderer reuses {@link QqMessageContent} to draw each cached sub-message,
 * which expects the render-view element form (`{ type, data }`) — same shape
 * `c2cMsgToWire` / `groupMsgToWire` produce for the main timeline. The raw
 * 40900 record carries the FLAT proto `ElementWire` shape instead, so we lift
 * it: `ElementWire[]` → `decodeElement` → `Element[]` → `toRenderElements` →
 * `RenderElement[]`. `subMsgs` is recursive (nested forwards arbitrarily deep);
 * everything else (msgId, senderUin, sendTime, sendNick, senderInfo, …) is
 * passed through {@link sanitize} so bigints / bytes survive IPC.
 */
export function forwardRecordToWire(record: MsgCacheRecord): unknown {
  const elements = Array.isArray((record as { elements?: unknown }).elements)
    ? toRenderElements(((record as { elements: unknown[] }).elements as never[]).map((w) => decodeElement(w as never)))
    : [];
  const subMsgs = Array.isArray((record as { subMsgs?: unknown }).subMsgs)
    ? ((record as { subMsgs: MsgCacheRecord[] }).subMsgs).map(forwardRecordToWire)
    : [];

  // Sanitize the carrier fields (msgId/senderUin/sendTime + sender avatar block
  // etc.) but drop the proto `elements` / `subMsgs` from the spread — we replace
  // them with the lifted versions above.
  const { elements: _e, subMsgs: _s, ...rest } = record as unknown as Record<string, unknown>;
  const carrier = sanitize(rest) as Record<string, unknown>;
  return { ...carrier, elements, subMsgs };
}

/**
 * Editable-elements wire form for the message editor.
 *
 * The display path ({@link sanitize}) turns bytes into a hex string, which is
 * lossy-to-edit and one-way. The editor instead needs a round-trippable byte
 * shape, so we use Node's Buffer JSON form `{ type: 'Buffer', data: number[] }`
 * — which the editor's `ValueEditor` already renders — and reverse it on save.
 *
 * This also sidesteps the superjson failure that motivated this code: superjson
 * serializes a `Buffer` as `['typed-array', 'Buffer']`, but its deserialize
 * registry only knows the standard typed arrays, so a raw `Buffer` over IPC
 * throws "Trying to deserialize unknown typed array". Plain objects don't.
 */
export function elementsToEditable(v: any): any {
  if (v === null || v === undefined) return v;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) {
    return { type: 'Buffer', data: Array.from(v) };
  }
  if (Array.isArray(v)) return v.map(elementsToEditable);
  if (typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v)) out[k] = elementsToEditable(v[k]);
    return out;
  }
  return v;
}

/** Reverse {@link elementsToEditable}: `{ type:'Buffer', data }` → Uint8Array. */
export function elementsFromEditable(v: any): any {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(elementsFromEditable);
  if (typeof v === 'object') {
    if (v.type === 'Buffer' && Array.isArray(v.data)) {
      return Uint8Array.from(v.data);
    }
    const out: Record<string, any> = {};
    for (const k of Object.keys(v)) out[k] = elementsFromEditable(v[k]);
    return out;
  }
  return v;
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
