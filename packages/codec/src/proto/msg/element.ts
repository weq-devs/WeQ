/**
 * Element envelope wire schema — describes the physical protobuf shape of
 * ONE element inside the 40800 repeated container.
 *
 * The wire layout is FLAT: `elementType` (45002) is a discriminator that
 * tells you which of the per-type fields (textContent at 45101, … future
 * face/pic/file tags) carry the actual payload.
 *
 * Tag conventions:
 *   - 40010..40019 — envelope-level metadata shared by every element
 *   - 45001..45099 — element common fields (id, type, sub-type, …)
 *   - 45101..45199 — TEXT element specific
 *   - 45201..45299 — FACE element specific
 *   - 80810..80995 — MFACE / marketface element specific
 *   - 49154/49155  — roaming / msg-sync flags
 *
 * Philosophy:
 *   ALL tags are parsed and lifted into Element objects. The msg/UI layer
 *   decides which fields matter for rendering or editing. This keeps the
 *   codec layer thin and protocol-focused, avoiding dual maintenance of
 *   "important" vs "envelope-only" field classifications.
 */

import { ProtoField, ScalarType } from '../../core';

/** Nested message for action user info (tags 48210/43210). */
export const ActionUserWire = {
  uid: ProtoField(1005, ScalarType.STRING, { optional: true }),
  nickname: ProtoField(1006, ScalarType.STRING, { optional: true }),
};

/** Nested message for mute operator info (tag 48521 within 48541). */
export const MuteOperatorWire = {
  uid: ProtoField(1000, ScalarType.STRING, { optional: true }),
};

/** Nested message for muted user info (tag 48522 within 48541). */
export const MutedUserWire = {
  uid: ProtoField(1000, ScalarType.STRING, { optional: true }),
  groupNick: ProtoField(20002, ScalarType.STRING, { optional: true }),
};

/** Nested message for mute info (tag 48541). */
export const MuteInfoWire = {
  operator: ProtoField(48521, () => MuteOperatorWire, { optional: true }),
  mutedUser: ProtoField(48522, () => MutedUserWire, { optional: true }),
  timestamp: ProtoField(48531, ScalarType.UINT64, { optional: true }),
  duration: ProtoField(48532, ScalarType.UINT32, { optional: true }),
};

/** Nested message for action attributes (tag 48217, repeated). */
export const ActionAttrWire = {
  key: ProtoField(1005, ScalarType.STRING, { optional: true }),
  value: ProtoField(1006, ScalarType.STRING, { optional: true }),
};

/**
 * Nested message for reply element references (tag 47423, repeated).
 * Carries a lightweight snapshot of the original message's elements — each
 * entry has elementId + elementType (required) plus any element-specific tags
 * that were present on the wire (all optional, since we don't know which
 * element type we're capturing until runtime).
 */
export const ReplyElementWire = {
  elementId: ProtoField(45001, ScalarType.UINT64, { optional: true }),
  elementType: ProtoField(45002, ScalarType.UINT32, { optional: true }),
  subType: ProtoField(45003, ScalarType.UINT32, { optional: true }),
  textContent: ProtoField(45101, ScalarType.STRING, { optional: true }),
  fileName: ProtoField(45402, ScalarType.STRING, { optional: true }),
  filePath: ProtoField(45403, ScalarType.STRING, { optional: true }),
  fileSize: ProtoField(45405, ScalarType.UINT32, { optional: true }),
  md5Bytes: ProtoField(45406, ScalarType.BYTES, { optional: true }),
  md5Bytes2: ProtoField(45407, ScalarType.BYTES, { optional: true }),
  contentHash: ProtoField(45408, ScalarType.BYTES, { optional: true }),
  imgWidth: ProtoField(45411, ScalarType.UINT32, { optional: true }),
  imgHeight: ProtoField(45412, ScalarType.UINT32, { optional: true }),
  imgType: ProtoField(45416, ScalarType.UINT32, { optional: true }),
  isOriginal: ProtoField(45418, ScalarType.BOOL, { optional: true }),
  md5: ProtoField(45424, ScalarType.STRING, { optional: true }),
  fileToken: ProtoField(45503, ScalarType.STRING, { optional: true }),
  uploadTime: ProtoField(45505, ScalarType.UINT32, { optional: true }),
  picTransferState: ProtoField(45511, ScalarType.UINT32, { optional: true }),
  transferVersion: ProtoField(45513, ScalarType.UINT32, { optional: true }),
  uploadTimestamp: ProtoField(45517, ScalarType.UINT32, { optional: true }),
  fileTTL: ProtoField(45518, ScalarType.UINT32, { optional: true }),
  thumbnailUrl: ProtoField(45802, ScalarType.STRING, { optional: true }),
  previewUrl: ProtoField(45803, ScalarType.STRING, { optional: true }),
  originalUrl: ProtoField(45804, ScalarType.STRING, { optional: true }),
  summary: ProtoField(45815, ScalarType.STRING, { repeat: true }),
  cdnHost: ProtoField(45816, ScalarType.STRING, { optional: true }),
  transferState: ProtoField(45550, ScalarType.UINT32, { optional: true }),
  pttDuration: ProtoField(45906, ScalarType.UINT32, { optional: true }),
  voiceChanged: ProtoField(45911, ScalarType.BOOL, { optional: true }),
  isAiVoice: ProtoField(45915, ScalarType.BOOL, { optional: true }),
  waveform: ProtoField(45925, ScalarType.BYTES, { optional: true }),
  faceId: ProtoField(47601, ScalarType.UINT32, { optional: true }),
  faceText: ProtoField(47602, ScalarType.STRING, { optional: true }),
  arkData: ProtoField(47901, ScalarType.STRING, { optional: true }),
  resId: ProtoField(48601, ScalarType.STRING, { optional: true }),
  xmlContent: ProtoField(48602, ScalarType.STRING, { optional: true }),
  sessionId: ProtoField(48603, ScalarType.STRING, { optional: true }),
};

/** Nested message for markdown metadata (tag 48702). */
export const MarkdownMetaWire = {
  flag1: ProtoField(1, ScalarType.UINT32, { optional: true }),
  buildTimestamp: ProtoField(2, ScalarType.UINT32, { optional: true }),
  flag3: ProtoField(3, ScalarType.BYTES, { optional: true }),
  flag4: ProtoField(4, ScalarType.UINT32, { optional: true }),
};

/** Nested message for markdown flag 48703. Uses absolute tags 48720/48721/48722. */
export const MarkdownFlag48703Wire = {
  field48720: ProtoField(48720, ScalarType.STRING, { optional: true }),
  field48721: ProtoField(48721, ScalarType.STRING, { optional: true }),
  field48722: ProtoField(48722, ScalarType.UINT32, { optional: true }),
};

/**
 * One button of a bot inline keyboard (tag 48753, repeated inside a row).
 *
 * Recovered from a 小虾米 (bot uin 2854213832) welcome card: four buttons laid
 * out 2×2, each opening a `m.q.qq.com` mini-program page. Tags whose meaning is
 * still unverified keep numeric names — every observed sample has them at 0/""
 * so there is nothing to infer from.
 */
export const InlineKeyboardButtonWire = {
  /** 按钮 id，形如 "1".."4"（字符串，不是数字）。 */
  buttonId: ProtoField(48754, ScalarType.STRING, { optional: true }),
  /** 按钮文案，如「我的钱包」。 */
  label: ProtoField(48755, ScalarType.STRING, { optional: true }),
  /** 点击后的文案。观测中恒等于 label。 */
  visitedLabel: ProtoField(48756, ScalarType.STRING, { optional: true }),
  /** 样式（1 = 描边蓝字）。 */
  style: ProtoField(48757, ScalarType.UINT32, { optional: true }),
  flag48758: ProtoField(48758, ScalarType.UINT32, { optional: true }),
  flag48759: ProtoField(48759, ScalarType.UINT32, { optional: true }),
  flag48760: ProtoField(48760, ScalarType.STRING, { optional: true }),
  /** 点击目标：http(s) 链接或指令文本，取决于 actionType。 */
  action: ProtoField(48761, ScalarType.STRING, { optional: true }),
  flag48762: ProtoField(48762, ScalarType.UINT32, { optional: true }),
  /** 动作类型。观测到的都是 2（打开链接）。 */
  actionType: ProtoField(48763, ScalarType.UINT32, { optional: true }),
  flag48766: ProtoField(48766, ScalarType.UINT32, { optional: true }),
  flag48767: ProtoField(48767, ScalarType.UINT32, { optional: true }),
  flag48768: ProtoField(48768, ScalarType.UINT32, { optional: true }),
  flag48772: ProtoField(48772, ScalarType.UINT32, { optional: true }),
  flag48790: ProtoField(48790, ScalarType.STRING, { optional: true }),
};

/** One row of a bot inline keyboard (tag 48751, repeated). */
export const InlineKeyboardRowWire = {
  buttons: ProtoField(48753, () => InlineKeyboardButtonWire, { optional: true, repeat: true }),
};

/** Nested extra struct inside a QUNGIFT element (tag 48864). Semantics unverified from single sample. */
export const QunGiftExtraWire = {
  unknown48865: ProtoField(48865, ScalarType.BOOL, { optional: true }),
  unknown48866: ProtoField(48866, ScalarType.STRING, { optional: true }),
};

/** Nested message for flash-transfer thumbnail URL info (tag 2 within 4 of 48708). */
export const FlashTransferThumbUrlWire = {
  type: ProtoField(1, ScalarType.UINT32, { optional: true }),
  url: ProtoField(2, ScalarType.STRING, { optional: true }),
};

/** Nested message for flash-transfer thumbnail alternative (tag 4 of 48708). */
export const FlashTransferThumbAltWire = {
  fileId: ProtoField(1, ScalarType.STRING, { optional: true }),
  urlInfo: ProtoField(2, () => FlashTransferThumbUrlWire, { optional: true }),
};

/** Nested message for flash-transfer info (tag 48708). */
export const FlashTransferInfoWire = {
  fileSetId: ProtoField(1, ScalarType.STRING, { optional: true }),
  thumbnailName: ProtoField(2, ScalarType.STRING, { optional: true }),
  fileBytes: ProtoField(3, ScalarType.UINT32, { optional: true }),
  thumbAlt: ProtoField(4, () => FlashTransferThumbAltWire, { optional: true }),
  createTime: ProtoField(6, ScalarType.UINT32, { optional: true }),
};

/**
 * Nested message for emoji-bounce detail (tag 52137, EMOJI_BOUNCE elements).
 * Carries a redundant copy of the bounce emoji's name + text summary.
 */
export const EmojiBounceDetailWire = {
  flag52142: ProtoField(52142, ScalarType.UINT32, { optional: true }),
  name: ProtoField(52143, ScalarType.STRING, { optional: true }),
  textSummary: ProtoField(52144, ScalarType.STRING, { optional: true }),
};

/**
 * Nested message for a QQ-dynamic description block (tags 48175/48176, both
 * QQ_DYNAMIC elements). 48175 is the primary description, 48176 a secondary.
 */
export const QqDynamicDescWire = {
  mainDesc: ProtoField(48178, ScalarType.STRING, { optional: true }),
  subDesc: ProtoField(48179, ScalarType.STRING, { optional: true }),
};

/**
 * Nested message for one QQ-dynamic tag (tag 48189, repeated within
 * QQ_DYNAMIC elements).
 */
export const QqDynamicTagWire = {
  flag48191: ProtoField(48191, ScalarType.BOOL, { optional: true }),
  tagId: ProtoField(48192, ScalarType.UINT32, { optional: true }),
  tagContent: ProtoField(48193, ScalarType.STRING, { optional: true }),
};

/** Nested message for one receipt payer (tag 8 within 48461). */
export const ReceiptPayerWire = {
  /** 收款人 uin（wire 上是 VARINT，不是 STRING） */
  uin: ProtoField(1, ScalarType.UINT64, { optional: true }),
  /** 金额（单位：分） */
  amount: ProtoField(2, ScalarType.UINT32, { optional: true }),
};

/** Nested message for receipt list (tag 48461, GROUP_RECEIPT wallets). */
export const ReceiptListWire = {
  /** 红包皮肤 id（普通红包，varint）*/
  skinId: ProtoField(5, ScalarType.UINT32, { optional: true }),
  /** 收款人列表 */
  payers: ProtoField(8, () => ReceiptPayerWire, { optional: true, repeat: true }),
};

/** Nested message for wallet detail (tag 48403, WALLET elements). */
export const WalletDetailWire = {
  flag48441: ProtoField(48441, ScalarType.UINT32, { optional: true }),
  redbagType: ProtoField(48442, ScalarType.UINT32, { optional: true }),
  redbagTitle: ProtoField(48443, ScalarType.STRING, { optional: true }),
  openPrompt: ProtoField(48444, ScalarType.STRING, { optional: true }),
  subTitle: ProtoField(48445, ScalarType.STRING, { optional: true }),
  flag48446: ProtoField(48446, ScalarType.STRING, { optional: true }),
  flag48447: ProtoField(48447, ScalarType.STRING, { optional: true }),
  display: ProtoField(48448, ScalarType.STRING, { optional: true }),
  flag48449: ProtoField(48449, ScalarType.UINT32, { optional: true }),
  flag48450: ProtoField(48450, ScalarType.UINT32, { optional: true }),
  flag48451: ProtoField(48451, ScalarType.STRING, { optional: true }),
  flag48452: ProtoField(48452, ScalarType.STRING, { optional: true }),
  flag48453: ProtoField(48453, ScalarType.STRING, { optional: true }),
  orderUrl: ProtoField(48454, ScalarType.STRING, { optional: true }),
  /** 群收款收款人列表（仅 GROUP_RECEIPT 类型，tag 48412 = 16）*/
  receiptList: ProtoField(48461, () => ReceiptListWire, { optional: true }),
};

/** Nested message for wallet extension (tag 48421, WALLET elements). */
export const WalletExtWire = {
  flag3: ProtoField(3, ScalarType.BOOL, { optional: true }),
  redbagCover: ProtoField(5, ScalarType.STRING, { optional: true }),
  flag7: ProtoField(7, ScalarType.BOOL, { optional: true }),
  flag8: ProtoField(8, ScalarType.BOOL, { optional: true }),
};

/** Nested block for VIDEO tag 45856. Every observed row has all five empty/0. */
export const VideoFlag45856Wire = {
  flag45857: ProtoField(45857, ScalarType.STRING, { optional: true }),
  flag45858: ProtoField(45858, ScalarType.STRING, { optional: true }),
  flag45859: ProtoField(45859, ScalarType.STRING, { optional: true }),
  flag45860: ProtoField(45860, ScalarType.STRING, { optional: true }),
  flag45861: ProtoField(45861, ScalarType.UINT32, { optional: true }),
};

/** Nested block for PTT tag 45908. Every observed row has all three at 0. */
export const PttFlag45908Wire = {
  flag1: ProtoField(1, ScalarType.UINT32, { optional: true }),
  flag5: ProtoField(5, ScalarType.UINT32, { optional: true }),
  flag7: ProtoField(7, ScalarType.UINT32, { optional: true }),
};

export const ElementWire = {
  /**
   * Whether this device originated the message. Absent for messages received
   * from peers AND for messages sent by other devices of this account. Set
   * to true only when this exact device pressed Send.
   */
  isSender: ProtoField(40010, ScalarType.BOOL, { optional: true }),

  /** Element serial number. Required. */
  elementId: ProtoField(45001, ScalarType.UINT64, { optional: true }),

  /** Element type discriminator. Required. Values come from `element/types.ts`. */
  elementType: ProtoField(45002, ScalarType.UINT32, { optional: true }),

  /** Element sub-type (semantics depend on elementType). Optional. */
  subType: ProtoField(45003, ScalarType.UINT32, { optional: true }),

  // ---- TEXT (elementType=1) ----

  /** Text content. Required for TEXT elements. */
  textContent: ProtoField(45101, ScalarType.STRING, { optional: true }),

  /** Text envelope flag observed in QQ protocol. */
  textReserve: ProtoField(45102, ScalarType.UINT32, { optional: true }),

  // Category 2 — observed in the wild on TEXT rows. Parsed (so the tag
  // dictionary labels them) but neither lifted into TextElement nor written
  // back. Best guesses at semantics are kept in the field doc — none verified.

  /** 文本编码 / 加密标志. Best guess: integer flag. */
  textEncodingFlag: ProtoField(45103, ScalarType.UINT32, { optional: true }),
  /** 字体 / 样式相关. Best guess: integer flag. */
  fontStyle: ProtoField(45104, ScalarType.UINT32, { optional: true }),

  /** @ 目标的 uid（仅 AtElement 用；名字曾误写成「气泡 ID」，跟装扮系统的气泡皮肤 id 无关）。 */
  atTargetUid: ProtoField(45105, ScalarType.STRING, { optional: true }),

  /** 文本输入状态. Best guess: integer flag. */
  textInputState: ProtoField(45106, ScalarType.UINT32, { optional: true }),

  // 45107 — not observed yet.

  /** 翻译 / 转换标志. Best guess: integer flag. */
  translationFlag: ProtoField(45108, ScalarType.UINT32, { optional: true }),

  /** 链接识别标志. Best guess: integer flag. */
  linkDetectionFlag: ProtoField(45109, ScalarType.UINT32, { optional: true }),

  /** @相关位掩码. Best guess: string-encoded bitmask. */
  atMentionMask: ProtoField(45110, ScalarType.STRING, { optional: true }),

  /** 红包 / 钱包含义标志. Best guess: integer flag. */
  walletFlag: ProtoField(45111, ScalarType.UINT32, { optional: true }),

  /** 网址校验字段. Best guess: bytes. */
  urlVerifyFlag: ProtoField(45112, ScalarType.BYTES, { optional: true }),

  // ---- PIC (elementType=2) ----

  /** Image filename. Required for PIC elements. */
  fileName: ProtoField(45402, ScalarType.STRING, { optional: true }),

  /** Local file path. Used by PTT and ONLINE_FILE elements. */
  filePath: ProtoField(45403, ScalarType.STRING, { optional: true }),

  /** File size in bytes. Required for PIC elements. */
  fileSize: ProtoField(45405, ScalarType.UINT32, { optional: true }),

  /** Binary MD5 hash. Required for PIC elements. */
  md5Bytes: ProtoField(45406, ScalarType.BYTES, { optional: true }),

  /** Content verification hash. Required for PIC elements. */
  contentHash: ProtoField(45408, ScalarType.BYTES, { optional: true }),

  /** Image width in pixels. Required for PIC elements. */
  imgWidth: ProtoField(45411, ScalarType.UINT32, { optional: true }),

  /** Image height in pixels. Required for PIC elements. */
  imgHeight: ProtoField(45412, ScalarType.UINT32, { optional: true }),

  /** Image type: 1000=normal, 2000=emoji, 1001=original. Required for PIC elements. */
  imgType: ProtoField(45416, ScalarType.UINT32, { optional: true }),

  /** Whether original quality. Required for PIC elements. */
  isOriginal: ProtoField(45418, ScalarType.BOOL, { optional: true }),

  /** Uppercase hex MD5 string. Required for PIC elements. */
  md5: ProtoField(45424, ScalarType.STRING, { optional: true }),

  /** Download token. Required for PIC elements. */
  fileToken: ProtoField(45503, ScalarType.STRING, { optional: true }),

  /** Upload/processing timestamp. Required for PIC elements. */
  uploadTime: ProtoField(45505, ScalarType.UINT32, { optional: true }),

  // 45507 / 45509 always appear together, on PIC, FILE and VIDEO alike.

  /**
   * Near-constant sentinel, only meaningful as a signed int64: the value is
   * almost always 18446744073704048574 (= -5503042). Encoded as INT64 so the
   * varint round-trips instead of being truncated to 32 bits.
   */
  transferFlag45507: ProtoField(45507, ScalarType.INT64, { optional: true }),

  /** Always 1 wherever 45507 is present. */
  transferFlag45509: ProtoField(45509, ScalarType.UINT32, { optional: true }),

  /** Transfer state flag. */
  picTransferState: ProtoField(45511, ScalarType.UINT32, { optional: true }),

  /** Transfer version flag. */
  transferVersion: ProtoField(45513, ScalarType.UINT32, { optional: true }),

  /** Upload timestamp. Required for PIC elements. */
  uploadTimestamp: ProtoField(45517, ScalarType.UINT32, { optional: true }),

  /** File TTL in seconds. Required for PIC elements. */
  fileTTL: ProtoField(45518, ScalarType.UINT32, { optional: true }),

  /** Thumbnail download URL. Required for PIC elements. */
  thumbnailUrl: ProtoField(45802, ScalarType.STRING, { optional: true }),

  /** Preview download URL. Required for PIC elements. */
  previewUrl: ProtoField(45803, ScalarType.STRING, { optional: true }),

  /** Original image download URL. Required for PIC elements. */
  originalUrl: ProtoField(45804, ScalarType.STRING, { optional: true }),

  /** Unknown flag — always 0 across every observed row. */
  picFlag45805: ProtoField(45805, ScalarType.UINT32, { optional: true }),

  /**
   * CDN server address for the download URLs, as a big-endian packed IPv4
   * (e.g. 3082863821 → 183.192.196.205). Pairs with the port in 45807.
   * 0 when QQ expects the client to resolve `cdnHost` (45816) itself.
   */
  cdnServerIp: ProtoField(45806, ScalarType.UINT32, { optional: true }),

  /** CDN server port. Observed: 80, 443, 8080, 14000, 57897, or 0. */
  cdnServerPort: ProtoField(45807, ScalarType.UINT32, { optional: true }),

  /** Local cache path of the thumbnail (`…_0.jpg`) — counterpart to 45802. */
  thumbnailLocalPath: ProtoField(45812, ScalarType.STRING, { optional: true }),

  /** Local cache path of the preview (`…_198.jpg`) — counterpart to 45803. */
  previewLocalPath: ProtoField(45813, ScalarType.STRING, { optional: true }),

  /** Local cache path of the large image (`…_720.jpg`) — counterpart to 45804. */
  originalLocalPath: ProtoField(45814, ScalarType.STRING, { optional: true }),

  /** Image summary/description. Repeated field. Required for PIC elements. */
  summary: ProtoField(45815, ScalarType.STRING, { repeat: true }),

  /** CDN host domain. Required for PIC elements. */
  cdnHost: ProtoField(45816, ScalarType.STRING, { optional: true }),

  /** PIC protocol flag. */
  picFlag45817: ProtoField(45817, ScalarType.UINT32, { optional: true }),

  picFlag45818: ProtoField(45818, ScalarType.STRING, { optional: true }),
  picFlag45819: ProtoField(45819, ScalarType.STRING, { optional: true }),
  picFlag45820: ProtoField(45820, ScalarType.STRING, { optional: true }),

  picFlag45821: ProtoField(45821, ScalarType.UINT32, { optional: true }),
  picFlag45822: ProtoField(45822, ScalarType.UINT32, { optional: true }),
  picFlag45823: ProtoField(45823, ScalarType.UINT32, { optional: true }),

  picFlag45824: ProtoField(45824, ScalarType.STRING, { optional: true }),

  picFlag45825: ProtoField(45825, ScalarType.UINT32, { optional: true }),
  picFlag45826: ProtoField(45826, ScalarType.UINT32, { optional: true }),
  picFlag45827: ProtoField(45827, ScalarType.UINT32, { optional: true }),

  picFlag45828: ProtoField(45828, ScalarType.STRING, { optional: true }),

  // Observed on PIC rows, semantics unverified — all near-constant, so they
  // carry no information we can act on. Parsed for round-trip fidelity.

  /** Observed only on subType=13 rows. Values 1 (×93) / 2 (×2). */
  picFlag45425: ProtoField(45425, ScalarType.UINT32, { optional: true }),

  /** Empty string in the single observed row. */
  picFlag45801: ProtoField(45801, ScalarType.STRING, { optional: true }),

  /** Always 0. */
  picFlag45829: ProtoField(45829, ScalarType.UINT32, { optional: true }),

  /** Always 0. */
  picFlag45830: ProtoField(45830, ScalarType.UINT32, { optional: true }),

  /** Always 0. */
  picFlag45831: ProtoField(45831, ScalarType.UINT32, { optional: true }),

  /** Always 0 in the single observed row. */
  picFlag45557: ProtoField(45557, ScalarType.UINT32, { optional: true }),

  /** Complex nested protobuf structure (image redundancy). Parsed as raw bytes. Optional for PIC elements. */
  picFlag45600: ProtoField(45600, ScalarType.BYTES, { optional: true }),

  // ---- FILE (elementType=3) ----
  // Generic file transfer. Reuses PIC/PTT/ONLINE_FILE tags: 45402 (fileName),
  // 45403 (filePath), 45405 (fileSize), 45406 (md5Bytes), 45408 (contentHash),
  // 45411 (imgWidth), 45412 (imgHeight), 45415 (fileFlag45415), 45503
  // (fileToken), 45504 (transferFlag45504), 45505 (uploadTime), 45511
  // (picTransferState), 45513 (transferVersion), 45550 (transferState). The
  // tags below are FILE-specific (or newly observed on FILE rows).

  /** Secondary MD5 hash — same shape/role as md5Bytes (45406). Required for FILE elements. */
  md5Bytes2: ProtoField(45407, ScalarType.BYTES, { optional: true }),

  /** Unknown bytes. Best guess: bytes. Required for FILE elements. */
  fileFlag45409: ProtoField(45409, ScalarType.BYTES, { optional: true }),

  /** Unknown integer (possibly bool). Required for FILE elements. */
  fileFlag45501: ProtoField(45501, ScalarType.UINT32, { optional: true }),

  /** Unknown bool flag. Required for FILE elements. */
  fileFlag45512: ProtoField(45512, ScalarType.BOOL, { optional: true }),

  /** Unknown bool flag. Required for FILE elements. */
  fileFlag45514: ProtoField(45514, ScalarType.BOOL, { optional: true }),

  /** Human-readable transfer error, e.g. 「传输失败，请稍后重试」. */
  transferErrorText: ProtoField(45554, ScalarType.STRING, { optional: true }),

  /** Observed once (=2) on a subType=4 row. */
  fileFlag45533: ProtoField(45533, ScalarType.UINT32, { optional: true }),

  /** Sender-side thumbnail path (mobile client, `.thumbnails/…`). */
  fileThumbPathRemote: ProtoField(45951, ScalarType.STRING, { optional: true }),

  /** Secondary sender-side thumbnail path (`qlarge-dsc-…`). */
  fileThumbPathRemote2: ProtoField(45953, ScalarType.STRING, { optional: true }),

  /** Local cache path of this file's thumbnail (`nt_data/File/Thumb/…`). */
  fileThumbLocalPath: ProtoField(45954, ScalarType.STRING, { optional: true }),

  /** Empty in every observed row. */
  fileFlag45966: ProtoField(45966, ScalarType.BYTES, { optional: true }),

  /** Empty in every observed row. */
  fileFlag45967: ProtoField(45967, ScalarType.BYTES, { optional: true }),

  /**
   * Group-file metadata blob (uploader uin/nick, file uuid, upload time, …).
   * Kept as raw bytes: seen exactly once, and the sub-tags are unverified.
   */
  fileGroupMeta: ProtoField(45968, ScalarType.BYTES, { optional: true }),

  // ---- VIDEO (elementType=5) ----
  // Short video. Reuses PIC/FILE tags: 45402 (fileName), 45405 (fileSize),
  // 45406 (md5Bytes), 45408 (contentHash), 45411 (imgWidth), 45412 (imgHeight),
  // 45415 (fileFlag45415), 45418 (isOriginal), 45503 (fileToken), 45505
  // (uploadTime), 45511 (picTransferState), 45513 (transferVersion), 45517
  // (uploadTimestamp), 45518 (fileTTL), 45815 (summary).

  /** Video duration in seconds. Required for VIDEO elements. */
  videoDuration: ProtoField(45410, ScalarType.UINT32, { optional: true }),

  /** Video width in pixels. Required for VIDEO elements. */
  videoWidth: ProtoField(45413, ScalarType.UINT32, { optional: true }),

  /** Video height in pixels. Required for VIDEO elements. */
  videoHeight: ProtoField(45414, ScalarType.UINT32, { optional: true }),

  /** Unknown bytes. Best guess: bytes. Required for VIDEO elements. */
  videoFlag45421: ProtoField(45421, ScalarType.BYTES, { optional: true }),

  /** Cover (thumbnail) image file name. Required for VIDEO elements. */
  coverFileName: ProtoField(45422, ScalarType.STRING, { optional: true }),

  /** Unknown bool flag. Required for VIDEO elements. */
  videoFlag45423: ProtoField(45423, ScalarType.BOOL, { optional: true }),

  /** Download token (tag 45510 — previously mislabeled fileFlag45510). Required for VIDEO/FILE elements. */
  videoToken: ProtoField(45510, ScalarType.STRING, { optional: true }),

  /** Expiry timestamp, unix seconds. Required for VIDEO elements. */
  expireTimestamp: ProtoField(45515, ScalarType.UINT32, { optional: true }),

  /** Valid period in seconds. Required for VIDEO elements. */
  validPeriodSec: ProtoField(45516, ScalarType.UINT32, { optional: true }),

  /**
   * Second-stage expiry timestamp, unix seconds: the first expiry retires the
   * original, the second purges it from the server entirely. Required for VIDEO.
   */
  secondExpireTimestamp: ProtoField(45519, ScalarType.UINT32, { optional: true }),

  /** File channel parameters. Best guess: bytes. Required for VIDEO elements. */
  channelParams: ProtoField(45862, ScalarType.BYTES, { optional: true }),

  /** Unknown integer. Required for VIDEO elements. */
  videoFlag45863: ProtoField(45863, ScalarType.UINT32, { optional: true }),

  /** Local cache path of the video cover (`nt_data/Video/…/Thumb/…_0.png`). */
  videoCoverLocalPath: ProtoField(45404, ScalarType.STRING, { optional: true }),

  /** Bubble video template name, e.g. "video_penguin_dance" (elementType=49 only). */
  templateName: ProtoField(45428, ScalarType.STRING, { optional: true }),

  /** Always 2 across every observed row. */
  videoFlag45851: ProtoField(45851, ScalarType.UINT32, { optional: true }),

  /** Near-constant 0 (one row had 1). */
  videoFlag45852: ProtoField(45852, ScalarType.UINT32, { optional: true }),

  /** Near-constant 0 (one row had 1). */
  videoFlag45853: ProtoField(45853, ScalarType.UINT32, { optional: true }),

  /** Near-constant 0 (one row had 1). */
  videoFlag45854: ProtoField(45854, ScalarType.UINT32, { optional: true }),

  /** Always 0. */
  videoFlag45855: ProtoField(45855, ScalarType.UINT32, { optional: true }),

  /** Nested block 45857..45861 — every sub-field empty/0 in all observed rows. */
  videoFlag45856: ProtoField(45856, () => VideoFlag45856Wire, { optional: true }),

  /** Values 0 (×30) / 2 (×4). */
  videoFlag45865: ProtoField(45865, ScalarType.UINT32, { optional: true }),

  // ---- PTT (elementType=4) ----
  // PTT reuses most PIC tags (45402-45518, 45815) for file metadata.

  /** Transfer state (optional). */
  transferState: ProtoField(45550, ScalarType.UINT32, { optional: true }),

  /** Voice clip duration in seconds. Drives both the 时长 label and the bubble
   * width; the waveform (45925) is decorative and NOT a reliable duration source
   * (AI 声聊 clips carry a fixed 30-byte synthetic strip regardless of length).
   * Named `pttDuration` to avoid colliding with the CALL `duration` (48152) that
   * shares this flat wire struct — a duplicate key would silently drop tag 45906. */
  pttDuration: ProtoField(45906, ScalarType.UINT32, { optional: true }),

  /** PTT protocol flag. */
  pttFlag45907: ProtoField(45907, ScalarType.UINT32, { optional: true }),

  pttFlag45909: ProtoField(45909, ScalarType.UINT32, { optional: true }),

  /** Whether voice is changed/transformed. Required for PTT elements. */
  voiceChanged: ProtoField(45911, ScalarType.BOOL, { optional: true }),

  /** AI 声聊 marker. Present (=true) ONLY on AI-voice-chat clips; absent on
   * normal mic recordings, 对讲 (intercom), and other-client voices. This is
   * the reliable classifier — QQ doesn't otherwise flag these, and their
   * waveform (45925) is a fixed synthetic 30-byte strip. */
  isAiVoice: ProtoField(45915, ScalarType.BOOL, { optional: true }),

  pttFlag45922: ProtoField(45922, ScalarType.UINT32, { optional: true }),

  /** Audio waveform data for visualization. Required for PTT elements. */
  waveform: ProtoField(45925, ScalarType.BYTES, { optional: true }),

  /**
   * 语音转文字结果 — QQ's own speech-to-text transcript of this clip, cached
   * on the row. Present only after 「转文字」has been run at least once;
   * empty string when the transcription produced nothing.
   */
  pttTranscript: ProtoField(45923, ScalarType.STRING, { optional: true }),

  /** Always 1 wherever present — likely "transcript available". */
  pttFlag45924: ProtoField(45924, ScalarType.UINT32, { optional: true }),

  /** Always 2 wherever present. */
  pttFlag45926: ProtoField(45926, ScalarType.UINT32, { optional: true }),

  /** Always 0. */
  pttFlag45903: ProtoField(45903, ScalarType.UINT32, { optional: true }),

  /** Values 2 (×39) / 1 (×1). */
  pttFlag45912: ProtoField(45912, ScalarType.UINT32, { optional: true }),

  /** Server-side voice id, e.g. `98PO#bjWUtk8qVPcpAiG57xZrOeS28AXRNmR`. */
  pttVoiceId: ProtoField(45905, ScalarType.STRING, { optional: true }),

  /** Nested {1,5,7} — all 0 in every observed row. */
  pttFlag45908: ProtoField(45908, () => PttFlag45908Wire, { optional: true }),

  /** Nested {2:{37}, 4:{1,2}} — empty/0 in every observed row. */
  pttFlag45601: ProtoField(45601, ScalarType.BYTES, { optional: true }),

  // ---- GRAY_TIP (elementType=8) ----
  // subType=17: action interactions (poke, red packet, etc.)

  /** Action target user info (subType=17). Nested: {1005: uid, 1006: nickname}. */
  actionTarget: ProtoField(43210, () => ActionUserWire, { optional: true }),

  /** Action initiator user info (subType=17). Nested: {1005: uid, 1006: nickname}. */
  actionInitiator: ProtoField(48210, () => ActionUserWire, { optional: true }),

  /** Action type ID (subType=17). Observed: 12 (poke), 16 (red packet). */
  actionId: ProtoField(48211, ScalarType.UINT32, { optional: true }),

  /** Detailed action ID (subType=17). 1=system, 1061=poke, 19357=red packet. */
  detailedId: ProtoField(48212, ScalarType.UINT32, { optional: true }),

  /** Type flag (subType=17). Observed: 7. */
  typeFlag: ProtoField(48213, ScalarType.UINT32, { optional: true }),

  /** XML preview document (subType=17). */
  grayTipXmlContent: ProtoField(48214, ScalarType.STRING, { optional: true }),

  /** Business logic ID (subType=17). Observed: 1132. */
  businessId: ProtoField(48215, ScalarType.UINT32, { optional: true }),

  /** This action's unique ID (subType=17). */
  actionUniqueId: ProtoField(48216, ScalarType.UINT32, { optional: true }),

  /** Additional attributes (subType=17). Repeated nested: {1005: key, 1006: value}. */
  actionAttributes: ProtoField(48217, () => ActionAttrWire, { repeat: true }),

  /** Category 2 — reserved field. Observed but not required. */
  grayTipReserved: ProtoField(48218, ScalarType.STRING, { optional: true }),

  /** Tip JSON payload (subType=17). Required for action gray tips. */
  tipJson: ProtoField(48271, ScalarType.STRING, { optional: true }),

  /** Category 2 — unknown flag. Observed: true. */
  grayTipFlag48272: ProtoField(48272, ScalarType.BOOL, { optional: true }),

  /** Tip type (subType=17). 1=system, matches detailedId. Required for action gray tips. */
  tipType: ProtoField(48273, ScalarType.UINT32, { optional: true }),

  /** Category 2 — observed field, not parsed. */
  grayTipFlag48275: ProtoField(48275, ScalarType.UINT32, { optional: true }),

  // subType=1: message recall/revoke

  /** Unknown int (subType=1). Required for recall tips. */
  recallFlag47702: ProtoField(47702, ScalarType.UINT32, { optional: true }),

  /** Sender UID (subType=1). Required for recall tips. */
  recallSenderUid: ProtoField(47704, ScalarType.STRING, { optional: true }),

  /** Revoker UID (subType=1). Required for recall tips. */
  recallRevokeUid: ProtoField(47703, ScalarType.STRING, { optional: true }),

  /** Sender nickname (subType=1). Required for recall tips. */
  recallSenderNick: ProtoField(47705, ScalarType.STRING, { optional: true }),

  /** Original message elements (subType=1). Repeated, optional — only present when revoking own message. */
  recallElements: ProtoField(47710, () => ReplyElementWire, { optional: true, repeat: true }),

  /** Unknown int (subType=1). Optional. */
  recallFlag47711: ProtoField(47711, ScalarType.UINT32, { optional: true }),

  /** Revoke display text (subType=1). Required for recall tips. */
  recallDisplayText: ProtoField(47713, ScalarType.STRING, { optional: true }),

  /** Revoker nickname (subType=1). Required for recall tips. */
  recallRevokeNick: ProtoField(47714, ScalarType.STRING, { optional: true }),

  // 47706/47715 mirror 47705/47714 (the nickname), while 47707/47716 carry the
  // 群名片 — verified on a group revoke where the nickname was
  // "🍬🐱帕罗丁，然后8年之誓" but the card read "期中考试加油". QQ writes a
  // sender copy and a revoker copy of each even when they are the same person,
  // so all six fields agree whenever someone revokes their own message.

  /** 被撤回者昵称副本 (subType=1). Duplicate of recallSenderNick (47705). */
  recallSenderNickCopy: ProtoField(47706, ScalarType.STRING, { optional: true }),

  /** 被撤回者的群名片 (subType=1). Differs from the nickname in groups. */
  recallSenderGroupNick: ProtoField(47707, ScalarType.STRING, { optional: true }),

  /** 撤回者昵称副本 (subType=1). Duplicate of recallRevokeNick (47714). */
  recallRevokeNickCopy: ProtoField(47715, ScalarType.STRING, { optional: true }),

  /** 撤回者的群名片 (subType=1). Differs from the nickname in groups. */
  recallRevokeGroupNick: ProtoField(47716, ScalarType.STRING, { optional: true }),

  /** Always 1 in the two observed rows (subType=1). */
  recallFlag47712: ProtoField(47712, ScalarType.UINT32, { optional: true }),

  // subType=4: group notifications (join, dismiss, removal)

  /**
   * Group tip type (subType=4) — see `TipGroupElementType`. Observed here:
   * 1=入群, 2=解散, 3=被移出, 5=改群名, 8=禁言. Required for group tips.
   */
  groupTipType: ProtoField(48501, ScalarType.UINT32, { optional: true }),

  /** User 1 UID (subType=4). Optional. */
  user1Uid: ProtoField(48503, ScalarType.STRING, { optional: true }),

  /** User 1 nickname (subType=4). Optional. */
  user1Nick: ProtoField(48504, ScalarType.STRING, { optional: true }),

  /** User 1 group nickname (subType=4). Optional. */
  user1GroupNick: ProtoField(48505, ScalarType.STRING, { optional: true }),

  /** User 2 UID (subType=4). Optional. */
  user2Uid: ProtoField(48506, ScalarType.STRING, { optional: true }),

  /** User 2 nickname (subType=4). Optional. */
  user2Nick: ProtoField(48507, ScalarType.STRING, { optional: true }),

  /** User 2 group nickname (subType=4). Optional. */
  user2GroupNick: ProtoField(48508, ScalarType.STRING, { optional: true }),

  /** Mute info (subType=4). Nested: {48521: operator, 48522: mutedUser, 48531: timestamp, 48532: duration}. Optional. */
  muteInfo: ProtoField(48541, () => MuteInfoWire, { optional: true }),

  /** Values 0/1/2 (subType=4). */
  groupTipFlag48502: ProtoField(48502, ScalarType.UINT32, { optional: true }),

  /**
   * 群名称 (subType=4) — the group this tip refers to, spelled out. Present
   * on 「XX 邀请你加入 <群名>」-style tips where the group isn't the current
   * conversation.
   */
  groupTipGroupName: ProtoField(48509, ScalarType.STRING, { optional: true }),

  /** Always 1 wherever present (subType=4). */
  groupTipFlag48510: ProtoField(48510, ScalarType.UINT32, { optional: true }),

  /** Values 0 (×2874) / 2 / 1 / 3 (subType=4). */
  groupTipFlag48511: ProtoField(48511, ScalarType.UINT32, { optional: true }),

  /**
   * Tip timestamp, unix seconds (subType=4/12/17). ~9700 distinct values,
   * all consistent with the message's own send time.
   */
  grayTipTimestamp: ProtoField(48542, ScalarType.UINT32, { optional: true }),

  /** Values 0 (×49) / 1 (×1) (subType=12/17). */
  grayTipFlag48219: ProtoField(48219, ScalarType.UINT32, { optional: true }),

  /** Values 0 (×59) / 64 (×1) (subType=12/17). */
  grayTipFlag48220: ProtoField(48220, ScalarType.UINT32, { optional: true }),

  /**
   * 互动标识提示原文 (subType=17), e.g.「你和XX互发消息连续超过7天，已获得畅聊之火标识」.
   * Plain text alternative to the rich `tipJson` (48271).
   */
  grayTipPlainText: ProtoField(48274, ScalarType.STRING, { optional: true }),

  // ---- GRAY_TIP subType=15 (AIO_OP) — 临时会话提示 ----
  // QQ renders these as 「该用户通过 xxx 群聊向你发起临时会话」. Always the
  // first message (seq=1) of a c2c conversation with a non-friend, and the
  // row itself carries no sender (40020 empty).

  /** Always 1 — likely the tip variant, only one seen so far. */
  aioOpFlag47501: ProtoField(47501, ScalarType.UINT32, { optional: true }),

  /**
   * 发起临时会话的来源群号 (subType=15), as a decimal string. Verified against
   * group_msg_table: every observed value has real group history, and none
   * matches the peer's own uin.
   */
  tempSessionGroupCode: ProtoField(47502, ScalarType.STRING, { optional: true }),

  // ---- SHARE_LOCATION / 位置共享 (elementType=28) ----

  /** 位置共享提示文案, e.g.「发起了位置共享」. */
  shareLocationText: ProtoField(52152, ScalarType.STRING, { optional: true }),

  // ---- FACE (elementType=6) ----

  /** Extended description. Optional for FACE elements. */
  faceExtDesc: ProtoField(45004, ScalarType.STRING, { optional: true }),

  /** Face id. Required for FACE elements. (`FaceIndex.DICE = 358`.) */
  faceId: ProtoField(47601, ScalarType.UINT32, { optional: true }),

  /** Face text description. Required for FACE elements. */
  faceText: ProtoField(47602, ScalarType.STRING, { optional: true }),

  /** Super-emoji category. Optional for super-emoji FACE elements. */
  superEmojiCategory: ProtoField(47603, ScalarType.STRING, { optional: true }),

  /** Animated sticker ID. Optional for super-emoji FACE elements. */
  AniStickerId: ProtoField(47604, ScalarType.STRING, { optional: true }),

  /** Super-emoji flag 1. Optional for super-emoji FACE elements. */
  superEmojiFlag1: ProtoField(47605, ScalarType.UINT32, { optional: true }),

  /** Super-emoji flag 2. Optional for super-emoji FACE elements. */
  superEmojiFlag2: ProtoField(47606, ScalarType.UINT32, { optional: true }),

  /**
   * Super-emoji dice roll, "1".."6" as string. Only present when subType=3
   * AND faceId points at the dice face.
   */
  diceValue: ProtoField(47607, ScalarType.STRING, { optional: true }),

  /** Unknown length-delimited field. Optional for FACE elements. */
  faceFlag47608: ProtoField(47608, ScalarType.BYTES, { optional: true }),

  /** Super-emoji flag 3. Optional for super-emoji FACE elements. */
  superEmojiFlag3: ProtoField(47609, ScalarType.UINT32, { optional: true }),

  /** Super-emoji flag 4. Optional for super-emoji FACE elements. */
  superEmojiFlag4: ProtoField(47610, ScalarType.UINT32, { optional: true }),

  /** Whether emoji supports chain reaction. Optional for FACE elements. */
  canChain: ProtoField(47622, ScalarType.BOOL, { optional: true }),

  // 47611..47621 — a block that rides along on nearly every FACE element
  // regardless of subType. Only 47612/47615/47616/47621 ever carry content;
  // the rest are flags that are 0 in the overwhelming majority of rows.

  /** Values 0/1 mostly, occasionally 2..6 or 126. */
  faceFlag47611: ProtoField(47611, ScalarType.UINT32, { optional: true }),

  /** 互动表情名称, e.g. "模了个块". Usually empty. */
  interactiveFaceName: ProtoField(47612, ScalarType.STRING, { optional: true }),

  /** Always 0 (one row had 1). */
  faceFlag47613: ProtoField(47613, ScalarType.UINT32, { optional: true }),

  /** Always 0 (three rows had 2003). */
  faceFlag47614: ProtoField(47614, ScalarType.UINT32, { optional: true }),

  /** 互动表情名称副本 — same value as 47612 in every observed row. */
  interactiveFaceName2: ProtoField(47615, ScalarType.STRING, { optional: true }),

  /** 互动表情版本号, e.g. "7.2.0". Usually empty. */
  interactiveFaceVersion: ProtoField(47616, ScalarType.STRING, { optional: true }),

  /** Values 0/1/2/3. */
  faceFlag47617: ProtoField(47617, ScalarType.UINT32, { optional: true }),

  /** Always 0. */
  faceFlag47618: ProtoField(47618, ScalarType.UINT32, { optional: true }),

  /** Always 0. */
  faceFlag47619: ProtoField(47619, ScalarType.UINT32, { optional: true }),

  /** Always 0. */
  faceFlag47620: ProtoField(47620, ScalarType.UINT32, { optional: true }),

  /**
   * 旧版客户端降级文案, e.g.「[戳一戳]请使用最新版手机QQ体验新功能。」.
   * Empty on faces every client can render.
   */
  faceFallbackText: ProtoField(47621, ScalarType.STRING, { optional: true }),

  // ---- REPLY (elementType=7) ----
  // Quote-reply to an earlier message. Reuses 40020/40021 (envelope-level
  // sender/peer uids). All fields below are required for REPLY elements.

  /** Original message sender uid. Required for REPLY elements. */
  origSenderUid: ProtoField(40020, ScalarType.STRING, { optional: true }),

  /** Original message receiver uid. Required for REPLY elements. */
  origReceiverUid: ProtoField(40021, ScalarType.STRING, { optional: true }),

  /** Original message internal sequence number. Required for REPLY elements. */
  origMsgSeq: ProtoField(47402, ScalarType.UINT32, { optional: true }),

  /** Original message sender UIN (QQ number). Required for REPLY elements. */
  origSenderUin: ProtoField(47403, ScalarType.UINT32, { optional: true }),

  /** Original message timestamp (unix seconds). Required for REPLY elements. */
  origMsgTime: ProtoField(47404, ScalarType.UINT32, { optional: true }),

  /** Original message receiver UIN. Required for REPLY elements. */
  origReceiverUin: ProtoField(47411, ScalarType.UINT32, { optional: true }),

  /** Original message ID. Required for REPLY elements. */
  origMsgId: ProtoField(47416, ScalarType.UINT64, { optional: true }),

  /** Original message index within the chat (sequential message number). Required for REPLY elements. */
  origMsgIndex: ProtoField(47419, ScalarType.UINT32, { optional: true }),

  /** Unknown int64 field (size close to elementId). Required for REPLY elements. */
  replyFlag47422: ProtoField(47422, ScalarType.UINT64, { optional: true }),

  /** Nested snapshot of the original message's elements. Required for REPLY elements. */
  origElements: ProtoField(47423, () => ReplyElementWire, { optional: true, repeat: true }),

  /** Original message ID reference. Optional for REPLY elements. */
  replyOrigMsgIdRef: ProtoField(47401, ScalarType.UINT64, { optional: true }),

  /** Text summary of the original message. Optional for REPLY elements. */
  replyTextSummary: ProtoField(47413, ScalarType.STRING, { optional: true }),

  /** Unknown bool flag. Optional for REPLY elements. */
  replyFlag47415: ProtoField(47415, ScalarType.BOOL, { optional: true }),

  /** Unknown bool flag. Optional for REPLY elements. */
  replyFlag47418: ProtoField(47418, ScalarType.BOOL, { optional: true }),

  /** Values 1 (×290) / 0 (×14). */
  replyFlag47405: ProtoField(47405, ScalarType.UINT32, { optional: true }),

  /** Values 1 (×207) / 0 (×96). */
  replyFlag47407: ProtoField(47407, ScalarType.UINT32, { optional: true }),

  /**
   * Full sender snapshot of the quoted message (uin, uid, group card, msg
   * seq/time, …). Kept as raw bytes — the nested layout is deeply nested and
   * every field it carries is already available via 47402..47423.
   */
  replyOrigSenderBlob: ProtoField(47410, ScalarType.BYTES, { optional: true }),

  /** 被回复者的群名片/昵称, e.g. "小枳壳". */
  replyOrigSenderNick: ProtoField(47421, ScalarType.STRING, { optional: true }),

  /** Always 1. */
  replyFlag47424: ProtoField(47424, ScalarType.UINT32, { optional: true }),

  /** Always 1. */
  replyFlag47425: ProtoField(47425, ScalarType.UINT32, { optional: true }),

  /** Duplicate of origMsgSeq (47402) — identical in every observed row. */
  replyOrigMsgSeqCopy: ProtoField(48101, ScalarType.UINT32, { optional: true }),

  // ---- MARKDOWN (elementType=14) ----
  // Rich-text markdown message. Complex nested structures (48707/48708/48711)
  // for QQ flash-transfer are kept as raw bytes (not parsed into sub-messages)
  // to avoid excessive maintenance burden on optional edge features.

  /** Markdown content. Required for MARKDOWN elements. */
  markdownContent: ProtoField(48701, ScalarType.STRING, { optional: true }),

  /** Metadata (build timestamp, flags). Required for MARKDOWN elements. */
  markdownMeta: ProtoField(48702, () => MarkdownMetaWire, { optional: true }),

  /** Nested flag structure (uses absolute tags 48720/48721/48722). Required for MARKDOWN elements. */
  markdownFlag48703: ProtoField(48703, () => MarkdownFlag48703Wire, { optional: true }),

  /** Unknown length-delimited field. Required for MARKDOWN elements. */
  markdownFlag48704: ProtoField(48704, ScalarType.STRING, { optional: true }),

  /** Text summary. Required for MARKDOWN elements. */
  markdownTextSummary: ProtoField(48705, ScalarType.STRING, { optional: true }),

  /** Unknown integer flag. Required for MARKDOWN elements. */
  markdownFlag48706: ProtoField(48706, ScalarType.UINT32, { optional: true }),

  /** QQ flash-transfer proto 1 (tag 48707). Complex nested structure — parsed as raw bytes. Optional. */
  flashTransferProto1: ProtoField(48707, ScalarType.BYTES, { optional: true }),

  /** QQ flash-transfer info (tag 48708). Nested: fileSetId, thumbnail name/url, file size, create time. Optional. */
  flashTransferInfo: ProtoField(48708, () => FlashTransferInfoWire, { optional: true }),

  /** QQ flash-transfer proto 3 (tag 48711). Complex nested structure — parsed as raw bytes. Optional. */
  flashTransferProto3: ProtoField(48711, ScalarType.BYTES, { optional: true }),

  // ---- INLINE_KEYBOARD (elementType=17) ----
  // 机器人消息底部的按钮键盘。通常与一个 MARKDOWN 元素同时出现，是那条消息的
  // 「下半身」——markdown 是卡片正文，键盘是卡片按钮。

  /** 按钮行列表。每行一个 InlineKeyboardRowWire，行内 48753 是按钮。 */
  keyboardRows: ProtoField(48751, () => InlineKeyboardRowWire, { optional: true, repeat: true }),

  /** 机器人的 appid（不是 uin），如 101986948。 */
  keyboardBotAppId: ProtoField(48752, ScalarType.UINT64, { optional: true }),

  // ---- ARK (elementType=10) ----

  /**
   * Ark card / mini-program JSON payload. UTF-8 string holding a JSON
   * document. Shape varies per `view` field of the JSON — see ArkPayload
   * and `SAMPLE_GAME_CENTER_AD` in `element/ark.ts` for a worked example.
   */
  arkData: ProtoField(47901, ScalarType.STRING, { optional: true }),

  /** 64-char base64 card signature — pairs with `config.token` in the JSON. */
  arkSignature: ProtoField(47902, ScalarType.STRING, { optional: true }),

  /** Card instance UUID, e.g. `33cad47c-09f0-42a6-ab42-6329c0898765`. */
  arkCardId: ProtoField(47904, ScalarType.STRING, { optional: true }),

  // ---- QUNGIFT (elementType=18) ---- 群礼物，总与 ARK 共现，只解析不渲染

  /** 礼物 ID，对应 ARK dataForClient.GiftId。 */
  giftId: ProtoField(48851, ScalarType.STRING, { optional: true }),
  /** 礼物名称，如"玫瑰花"，对应 ARK meta.giftData.giftName。 */
  giftName: ProtoField(48852, ScalarType.STRING, { optional: true }),
  /** 接收者 uin，对应 ARK dataForClient.RecvUin。 */
  recvUin: ProtoField(48853, ScalarType.STRING, { optional: true }),
  /** 接收者昵称，对应 ARK meta.giftData.receiverNick。 */
  recvNick: ProtoField(48854, ScalarType.STRING, { optional: true }),
  /** 发送者 uin，对应 ARK dataForClient.SendUin。 */
  sendUin: ProtoField(48855, ScalarType.STRING, { optional: true }),
  /** 发送者昵称。 */
  sendNick: ProtoField(48856, ScalarType.STRING, { optional: true }),
  /** 发送数量，对应 ARK dataForClient.SendCount。 */
  sendCount: ProtoField(48857, ScalarType.STRING, { optional: true }),
  /** 订单 ID，对应 ARK dataForClient.OrderId。 */
  orderId: ProtoField(48858, ScalarType.STRING, { optional: true }),
  /** 匿名头像索引，对应 ARK dataForClient.AnonymousPortraitIdx，通常为空。 */
  anonymousPortraitIdx: ProtoField(48859, ScalarType.STRING, { optional: true }),
  /** 群号，对应 ARK dataForClient.TroopUin。 */
  giftTroopUin: ProtoField(48860, ScalarType.STRING, { optional: true }),
  /** 未知 bool（单样本 true）。 */
  giftUnknown48861: ProtoField(48861, ScalarType.BOOL, { optional: true }),
  /** 积分/分值，对应 ARK meta.giftData.score。 */
  score: ProtoField(48862, ScalarType.STRING, { optional: true }),
  /** 未知 bool（单样本 true）。 */
  giftUnknown48863: ProtoField(48863, ScalarType.BOOL, { optional: true }),
  /** 嵌套结构，语义待更多样本确认。 */
  giftExtra: ProtoField(48864, () => QunGiftExtraWire, { optional: true }),
  /** 未知 bool（单样本 false）。 */
  giftUnknown48867: ProtoField(48867, ScalarType.BOOL, { optional: true }),
  /** 礼物类型，对应 ARK dataForClient.GiftType。 */
  giftType: ProtoField(48868, ScalarType.STRING, { optional: true }),

  // ---- MFACE / marketface (elementType=11) ----
  // Market emoji (commercial sticker). Uses the disjoint 80xxx tag block.
  // Only the fields below are understood; the remaining 80xxx tags are parsed
  // for round-trip completeness with best-guess wire types (semantics
  // unverified — see the per-field docs).

  /** Emoji package / pack ID. Required for MFACE elements. */
  emojiPackId: ProtoField(80810, ScalarType.UINT32, { optional: true }),

  /** Decryption key for the on-disk (XOR-encrypted) emoji image file. */
  encryptKey: ProtoField(80824, ScalarType.STRING, { optional: true }),

  /** Emoji description text, e.g. "[嗨]". */
  emojiDesc: ProtoField(80900, ScalarType.STRING, { optional: true }),

  /** Emoji type. Required for MFACE elements. */
  mfaceType: ProtoField(80901, ScalarType.UINT32, { optional: true }),

  /** Emoji sub-type flag. Required for MFACE elements. */
  mfaceSubType: ProtoField(80902, ScalarType.BOOL, { optional: true }),

  /** Market emoticon ID — the real sticker id (on-disk file name). */
  marketEmoticonId: ProtoField(80903, ScalarType.BYTES, { optional: true }),

  /** Media type flag. Required for MFACE elements. */
  mediaType: ProtoField(80905, ScalarType.UINT32, { optional: true }),

  /** Render flag. Required for MFACE elements. */
  renderFlag: ProtoField(80908, ScalarType.BOOL, { optional: true }),

  /** Preview image width. Required for MFACE elements. */
  previewWidth: ProtoField(80909, ScalarType.UINT32, { optional: true }),

  /** Preview image height. Required for MFACE elements. */
  previewHeight: ProtoField(80910, ScalarType.UINT32, { optional: true }),

  /** Whether the emoji is animated. Required for MFACE elements. */
  isAnimated: ProtoField(80935, ScalarType.BOOL, { optional: true }),

  // Category 2 — observed 80xxx tags, parsed for round-trip only. Types are
  // best guesses from the field labels; none verified. All optional.

  /** 空对象. Best guess: empty nested message → bytes. */
  mfaceFlag80907: ProtoField(80907, ScalarType.BYTES, { optional: true }),

  /** 扩展元数据. Best guess: bytes. */
  mfaceFlag80913: ProtoField(80913, ScalarType.BYTES, { optional: true }),

  /** 样式 / 空对象. Best guess: bytes. */
  mfaceFlag80941: ProtoField(80941, ScalarType.BYTES, { optional: true }),

  /** 样式 / 空对象. Best guess: bytes. */
  mfaceFlag80942: ProtoField(80942, ScalarType.BYTES, { optional: true }),

  /** Protobuf-encoded width/height, e.g. `e0 c1 27 c8 01 e8 c1 27 c8 01`. */
  sizeInfo: ProtoField(80970, ScalarType.BYTES, { optional: true }),

  /** 兼容性标志. Best guess: integer flag. */
  mfaceFlag80975: ProtoField(80975, ScalarType.UINT32, { optional: true }),

  /** 样式 / 空对象. Best guess: bytes. */
  mfaceFlag80977: ProtoField(80977, ScalarType.BYTES, { optional: true }),

  /** 颜色 / 样式代码. Best guess: string. */
  mfaceFlag80978: ProtoField(80978, ScalarType.STRING, { optional: true }),

  /** 权限标志. Best guess: integer flag. */
  mfaceFlag80980: ProtoField(80980, ScalarType.UINT32, { optional: true }),

  /** 权限标志. Best guess: integer flag. */
  mfaceFlag80981: ProtoField(80981, ScalarType.UINT32, { optional: true }),

  /** 扩展 JSON. Best guess: string. */
  mfaceFlag80983: ProtoField(80983, ScalarType.STRING, { optional: true }),

  /** 结束 / 填充标志. Best guess: integer flag. */
  mfaceFlag80995: ProtoField(80995, ScalarType.UINT32, { optional: true }),

  // ---- MULTI_MSG (elementType=16) ----

  /**
   * Server resource ID for merged forward message chain. Used to fetch the
   * full message history from QQ servers. Required for MULTI_MSG elements.
   */
  resId: ProtoField(48601, ScalarType.STRING, { optional: true }),

  /**
   * XML preview document. Carries message titles, summary, and metadata for
   * rendering the forward card. Required for MULTI_MSG elements.
   */
  xmlContent: ProtoField(48602, ScalarType.STRING, { optional: true }),

  /**
   * Session identifier linking this forward element to its upload session.
   * Appears as `m_fileName` in the XML. Required for MULTI_MSG elements.
   */
  sessionId: ProtoField(48603, ScalarType.STRING, { optional: true }),

  // ---- CALL (elementType=21) ----

  /** Answer/pickup type, matches subType (CallSubType). Required for CALL elements. */
  answerType: ProtoField(48151, ScalarType.UINT32, { optional: true }),

  /** Call duration in milliseconds. Required for CALL elements. */
  duration: ProtoField(48152, ScalarType.UINT32, { optional: true }),

  /** CALL protocol flag — length-delimited string. Optional for CALL elements. */
  callFlag48153: ProtoField(48153, ScalarType.STRING, { optional: true }),

  /** Call method: 1=voice, 2=video, 3=screen share, 5=remote collaboration. Required for CALL elements. */
  callMethod: ProtoField(48154, ScalarType.UINT32, { optional: true }),

  /** Unknown type flag. Optional for CALL elements. Observed: 0, 1, 2, or absent. */
  callUnknownType: ProtoField(48155, ScalarType.UINT32, { optional: true }),

  /** CALL protocol flag. */
  callFlag48156: ProtoField(48156, ScalarType.UINT32, { optional: true }),

  /** Call summary. Required for CALL elements. */
  callSummary: ProtoField(48157, ScalarType.STRING, { repeat: true }),

  // ---- WALLET (elementType=9) ----

  /** Target uin (elementType=9). */
  walletTargetUin: ProtoField(48401, ScalarType.UINT32, { optional: true }),

  /** Transfer protobuf bytes (elementType=9). */
  walletTransferProto: ProtoField(48402, ScalarType.BYTES, { optional: true }),

  /** Wallet detail (elementType=9). */
  walletDetail: ProtoField(48403, () => WalletDetailWire, { optional: true }),

  walletFlag48404: ProtoField(48404, ScalarType.UINT32, { optional: true }),
  walletFlag48405: ProtoField(48405, ScalarType.UINT32, { optional: true }),
  walletFlag48406: ProtoField(48406, ScalarType.UINT32, { optional: true }),
  walletFlag48407: ProtoField(48407, ScalarType.UINT32, { optional: true }),
  walletFlag48408: ProtoField(48408, ScalarType.UINT32, { optional: true }),

  /** Order ID (elementType=9). */
  walletOrderId: ProtoField(48409, ScalarType.STRING, { optional: true }),

  walletFlag48410: ProtoField(48410, ScalarType.STRING, { optional: true }),
  walletFlag48411: ProtoField(48411, ScalarType.UINT32, { optional: true }),

  /**
   * Redbag type (elementType=9). See `RedbagType` in `element/types.ts`.
   * 1=transfer, 2=normal, 3=lucky (拼手气), 6=password, 8=designated (专属), 15=voice.
   */
  walletRedbagType: ProtoField(48412, ScalarType.UINT32, { optional: true }),

  walletFlag48417: ProtoField(48417, ScalarType.BYTES, { optional: true }),
  walletFlag48418: ProtoField(48418, ScalarType.STRING, { optional: true }),
  walletFlag48419: ProtoField(48419, ScalarType.UINT32, { optional: true }),

  /**
   * Designated recipient uin (elementType=9). Present only on 专属红包
   * (walletRedbagType=8); the sole group member allowed to claim the packet.
   */
  walletDesignatedUin: ProtoField(48420, ScalarType.UINT32, { optional: true }),

  /** Extension field (elementType=9). */
  walletExt: ProtoField(48421, () => WalletExtWire, { optional: true }),

  walletFlag48437: ProtoField(48437, ScalarType.UINT32, { optional: true }),
  walletFlag48438: ProtoField(48438, ScalarType.UINT32, { optional: true }),

  // ---- ONLINE_FILE (elementType=23) ----
  // Reuses PIC tags: 45402 (fileName), 45403 (filePath), 45405 (fileSize),
  // 45411 (imgWidth), 45412 (imgHeight), 45503 (fileToken).

  /** File related identifier. */
  fileFlag45415: ProtoField(45415, ScalarType.UINT32, { optional: true }),

  /** Transfer flag. */
  transferFlag45504: ProtoField(45504, ScalarType.STRING, { optional: true }),

  // ---- EMOJI_BOUNCE / 表情弹射 (elementType=27) ----
  // Animated emoji that "bounces" into the chat. All fields below are
  // required for EMOJI_BOUNCE elements.

  /** 弹射表情 id. Required for EMOJI_BOUNCE elements. */
  emojiBounceId: ProtoField(52132, ScalarType.UINT32, { optional: true }),

  /** Unknown bool flag. Required for EMOJI_BOUNCE elements. */
  emojiBounceFlag52133: ProtoField(52133, ScalarType.BOOL, { optional: true }),

  /** 弹射表情名称. Required for EMOJI_BOUNCE elements. */
  emojiBounceName: ProtoField(52134, ScalarType.STRING, { optional: true }),

  /** Nested detail (name + summary). Required for EMOJI_BOUNCE elements. */
  emojiBounceDetail: ProtoField(52137, () => EmojiBounceDetailWire, { optional: true }),

  /** 文本总结(含弹射个数). Required for EMOJI_BOUNCE elements. */
  emojiBounceTextSummary: ProtoField(52138, ScalarType.STRING, { optional: true }),

  /** 电脑端显示文本. Required for EMOJI_BOUNCE elements. */
  emojiBouncePcText: ProtoField(52139, ScalarType.STRING, { optional: true }),

  // ---- QQ_DYNAMIC / QQ动态消息 (elementType=26) ----
  // Share card for a QQ-zone dynamic (说说/动态) — QQ 内部名 TOFU. 除标了
  // "较老客户端" 的字段外，其余在 QQ_DYNAMIC element 上都是必有的。

  /** 动态类型（真实枚举，非任意数字）：1=更新个签 2=发布说说 6=生日礼物提醒
   *  11=互动认证/认识多久 13=匿名问答回答 15=节日提醒 16/18=点赞/戳一戳类
   *  17=装扮变更 22=密友绑定提醒。未知取值走兜底展示。Required for QQ_DYNAMIC elements. */
  dynamicType: ProtoField(48172, ScalarType.UINT32, { optional: true }),

  /** 动态 id. Required for QQ_DYNAMIC elements. */
  dynamicId: ProtoField(48173, ScalarType.STRING, { optional: true }),

  /** 卡片子样式 id：与 dynamicType 近似一一对应（同一 dynamicType 观测到的取值
   *  稳定），推测用于选择客户端的展示模板；具体枚举未知，先按未知整数保留。
   *  Required for QQ_DYNAMIC elements. */
  dynamicFlag48174: ProtoField(48174, ScalarType.UINT32, { optional: true }),

  /** Primary description block (main + sub desc). Required for QQ_DYNAMIC elements. */
  dynamicDesc: ProtoField(48175, () => QqDynamicDescWire, { optional: true }),

  /** Secondary description block (same shape as 48175). Required for QQ_DYNAMIC elements. */
  dynamicDesc2: ProtoField(48176, () => QqDynamicDescWire, { optional: true }),

  /** 封面图 url. Required for QQ_DYNAMIC elements. */
  dynamicCoverUrl: ProtoField(48180, ScalarType.STRING, { optional: true }),

  /** QQ 空间 logo url. Required for QQ_DYNAMIC elements. */
  dynamicZoneLogoUrl: ProtoField(48181, ScalarType.STRING, { optional: true }),

  /** 动态相关方 QQ uin 列表。实测**可重复出现两次**（如密友绑定/节日提醒场景，
   *  分别是双方各自的 uin）——之前按单值 UINT32 建模会在这类消息上被 wire 上后
   *  一次出现的值覆盖，静默丢掉前一个 uin。Required for QQ_DYNAMIC elements.
   *  注意：scalar 字段不能同时给 `optional: true` —— ProtoMsgCore 会把它转成
   *  protobuf-ts 的 `opt: true`，而 reflectionCreate() 对 `opt` 字段直接
   *  `continue`、根本不会给 repeat 字段初始化 `[]`，实机解码会在
   *  ReflectionBinaryReader 里 `target[localName].push(...)` 崩成
   *  "Cannot read properties of undefined (reading 'push')"。仓库里其余 scalar
   *  repeat 字段（`summary`/`callSummary`）也都没给 optional，保持一致。 */
  dynamicPublisherUin: ProtoField(48182, ScalarType.UINT32, { repeat: true }),

  /** 动态 meta 数据：实测三种形态——空字符串 / JSON（常见 key 有 jumpUrl、
   *  jump_schema、jump_h5，用于卡片点击跳转）/ base64 编码的嵌套 protobuf
   *  （dynamicType=11 互动认证卡，内含"认识 N 天"之类的可读文案）。
   *  Required for QQ_DYNAMIC elements. */
  dynamicMeta: ProtoField(48183, ScalarType.STRING, { optional: true }),

  /** 动态发布者 uid（编码形式，配合 dynamicPublisherUin 使用可走 profile 解析拿
   *  昵称/头像）。仅较老客户端（2024 前后）观测到，新版本未必再下发。 */
  dynamicPublisherUid: ProtoField(48188, ScalarType.STRING, { optional: true }),

  /** 标签列表. Repeated nested {flag, tagId, tagContent}. Optional for QQ_DYNAMIC elements. */
  dynamicTags: ProtoField(48189, () => QqDynamicTagWire, { optional: true, repeat: true }),

  // ---- Roaming / sync flags — category 2 envelope tags ----

  /** Roaming marker. Read for completeness; not part of any element. */
  roaming: ProtoField(49154, ScalarType.BYTES, { optional: true }),

  /** Message-sync timestamp. Read for completeness; not part of any element. */
  msgSyncFlag: ProtoField(49155, ScalarType.UINT64, { optional: true }),
};

/**
 * Preview element — structurally an ElementWire plus ONE extra field used to
 * render the latest message OUTSIDE the conversation (in the recent-contact /
 * conversation list). Built by spreading ElementWire so it reuses every element
 * field without polluting the base wire with a tag (49093) that only appears in
 * this one place.
 */
export const PreviewElementWire = {
  ...ElementWire,

  /** 会话列表外显的最新消息文本（tag 49093）. */
  displayText: ProtoField(49093, ScalarType.STRING, { optional: true }),
};
