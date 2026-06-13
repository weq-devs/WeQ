/**
 * 40900 — message-cache envelope. A NEW column/concept layered on top of 40800.
 *
 * Where 40800 (`MsgBody`) is just the repeated element payload of ONE message,
 * 40900 (`MsgCache`) is a self-contained snapshot of an ENTIRE message row:
 * its identity (msgId/seq/random), routing (sender/peer uid+uin), timing,
 * status flags, sender display info, AND the 40800 element list itself.
 *
 * Recursion: when `msgType` is MULTI_FORWARD (8) or REPLY (9), the message
 * carries the cached source/quoted message(s) as a REPEATED nested 40900 under
 * tag 40900. Those nested entries are themselves full `MsgCache` records and
 * can nest 40900 again — i.e. the structure is arbitrarily deep.
 *
 * Tag conventions:
 *   - 40001..40105 — row-level scalars (id, seq, type, status, time, nick, …)
 *   - 40600        — sender display block (avatar info nested under 42341)
 *   - 40800        — repeated ElementWire (the message body, see ./element.ts)
 *   - 40801/40802  — low-value nested protobufs, kept as opaque bytes
 *   - 40900        — repeated nested MsgCache (forward / reply cache, recursive)
 *
 * Several tags are still unidentified; they are parsed for round-trip fidelity
 * with best-guess wire types (`flagNNNNN`) and documented as 未知 where unknown.
 */

import { ProtoField, ScalarType, type ProtoMessageType } from '../../core';
import { ElementWire } from './element';

// ---------- enums (vendored from the soon-to-be-deleted `@weq/types`) -----

/**
 * Message type — value of tag 40011. Confirmed against real rows:
 * 8 = 合并转发 (merged forward), 9 = 引用回复 (quote reply). Remaining values
 * mirror QQ NT's KMSGTYPE* table; treat the un-annotated ones as best-effort.
 */
export enum MsgType {
  UNKNOWN = 0,
  NULL = 1,
  MIX = 2, // 图文混排
  FILE = 3,
  STRUCT = 4,
  GRAY_TIP = 5, // 小灰条
  PTT = 6,
  VIDEO = 7,
  MULTI_FORWARD = 8, // 合并转发
  REPLY = 9, // 引用回复
  WALLET = 10,
  ARK_STRUCT = 11,
  STRUCT_LONG_MSG = 12,
  GIPHY = 13,
  GIFT = 14,
  TEXT_GIFT = 15,
  ONLINE_FILE = 21,
  FACE_BUBBLE = 24,
  SHARE_LOCATION = 25,
  ONLINE_FOLDER = 27,
  PROLOGUE = 29,
}

/**
 * Send type — value of tag 40013. Where the message originated relative to
 * THIS device/account.
 */
export enum SendType {
  RECEIVED = 0, // 别人发来的消息
  LOCAL = 1, // 本机发送
  OTHER_CLIENT = 2, // 本账号的其它客户端发送
  FORWARD = 5, // 转发产生的消息
}

/**
 * Send status — value of tag 40041. Note the values do NOT line up 1:1 with
 * NapCat's SendStatusType naming; semantics below come from observed behavior.
 */
export enum SendStatus {
  BLOCKED = 0, // 发送被阻止（如不是对方好友）
  PENDING = 1, // 尚未发送成功（如网络问题）
  SUCCESS = 2, // 发送成功
  BANNED = 3, // 消息被 QQ 封禁
}

// ---------- nested: sender display / avatar block (tag 40600) -------------

/**
 * Avatar info (tag 42341 within 40600). Carries the encrypted handle + URL the
 * client uses to fetch the sender's avatar.
 */
export const MsgCacheAvatarWire = {
  /** 未知 int32. */
  flag42342: ProtoField(42342, ScalarType.UINT32, { optional: true }),

  /** 未知 int32. */
  flag42343: ProtoField(42343, ScalarType.UINT32, { optional: true }),

  /** 头像图片类型. */
  avatarType: ProtoField(42344, ScalarType.UINT32, { optional: true }),

  /** 头像加密 uin. */
  encryptedUin: ProtoField(42345, ScalarType.STRING, { optional: true }),

  /** 头像加密外链 url. */
  avatarUrl: ProtoField(42346, ScalarType.STRING, { optional: true }),
};

/** Sender display block (tag 40600). */
export const MsgCacheSenderInfoWire = {
  /** 未知 int32. */
  flag42261: ProtoField(42261, ScalarType.UINT32, { optional: true }),

  /** Avatar info. */
  avatar: ProtoField(42341, () => MsgCacheAvatarWire, { optional: true }),
};

// ---------- main: 40900 message-cache record ------------------------------

export const MsgCache = {
  /** 消息 id（雪花 id）. */
  msgId: ProtoField(40001, ScalarType.INT64, { optional: true }),

  /** 消息随机数（去重用）. */
  msgRandom: ProtoField(40002, ScalarType.UINT32, { optional: true }),

  /** 消息序列号. */
  msgSeq: ProtoField(40003, ScalarType.UINT32, { optional: true }),

  /** 未知 int32. */
  flag40005: ProtoField(40005, ScalarType.UINT32, { optional: true }),

  /** 未知 int32. */
  flag40006: ProtoField(40006, ScalarType.UINT32, { optional: true }),

  /** 未知 int32. */
  flag40008: ProtoField(40008, ScalarType.UINT32, { optional: true }),

  /** 未知 int32. */
  flag40009: ProtoField(40009, ScalarType.UINT32, { optional: true }),

  /** Whether THIS device sent the message (same semantics as ElementWire.isSender). */
  isSender: ProtoField(40010, ScalarType.BOOL, { optional: true }),

  /** Message type. See {@link MsgType} — 8=合并转发, 9=引用回复. */
  msgType: ProtoField(40011, ScalarType.UINT32, { optional: true }),

  /** Message sub-type. */
  msgSubType: ProtoField(40012, ScalarType.UINT32, { optional: true }),

  /** Send origin flag. See {@link SendType}. */
  sendType: ProtoField(40013, ScalarType.UINT32, { optional: true }),

  /** 未知 int32. */
  flag40016: ProtoField(40016, ScalarType.UINT32, { optional: true }),

  /** Sender uid (tag 40020 — same role as ElementWire.origSenderUid). */
  senderUid: ProtoField(40020, ScalarType.STRING, { optional: true }),

  /** Peer uid (tag 40021 — same role as ElementWire.origReceiverUid). */
  peerUid: ProtoField(40021, ScalarType.STRING, { optional: true }),

  /** Sender QQ uin. */
  senderUin: ProtoField(40033, ScalarType.UINT32, { optional: true }),

  /** Send status. See {@link SendStatus}. */
  sendStatus: ProtoField(40041, ScalarType.UINT32, { optional: true }),

  /** Send time, unix seconds. */
  sendTime: ProtoField(40050, ScalarType.UINT32, { optional: true }),

  /** Midnight (00:00) timestamp of the send day, unix seconds. */
  sendDayStartTime: ProtoField(40058, ScalarType.UINT32, { optional: true }),

  /** Sender nickname. */
  sendNick: ProtoField(40093, ScalarType.STRING, { optional: true }),

  /** 未知 int32. */
  flag40105: ProtoField(40105, ScalarType.UINT32, { optional: true }),

  /** Sender display / avatar block. */
  senderInfo: ProtoField(40600, () => MsgCacheSenderInfoWire, { optional: true }),

  /** Message body — repeated elements, identical shape to MsgBody (see ./element.ts). */
  elements: ProtoField(40800, () => ElementWire, { optional: true, repeat: true }),

  /** Low-value nested protobuf — kept as opaque bytes. */
  proto40801: ProtoField(40801, ScalarType.BYTES, { optional: true }),

  /** Low-value nested protobuf — kept as opaque bytes. */
  proto40802: ProtoField(40802, ScalarType.BYTES, { optional: true }),

  /**
   * Cached source/quoted message(s) for MULTI_FORWARD / REPLY. Recursive: each
   * entry is a full MsgCache and may itself contain a 40900 list. The explicit
   * `(): ProtoMessageType => MsgCache` return type breaks the self-referential
   * type-inference cycle (runtime resolution is lazy, so MsgCache is defined by
   * the time the thunk is called).
   */
  subMsgs: ProtoField(40900, (): ProtoMessageType => MsgCache, { optional: true, repeat: true }),
};

/**
 * 40900 column wrapper — the BLOB is a REPEATED MsgCache. Analogous to MsgBody
 * for the 40800 column: decode this to lift the raw bytes into MsgCache[].
 */
export const MsgCacheBody = {
  msgs: ProtoField(40900, () => MsgCache, { optional: true, repeat: true }),
};
