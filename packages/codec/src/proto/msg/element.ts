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
  pttType: ProtoField(45906, ScalarType.UINT32, { optional: true }),
  voiceChanged: ProtoField(45911, ScalarType.BOOL, { optional: true }),
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

  // Category 2 — observed in the wild on TEXT rows. Parsed (so protolab
  // labels them) but neither lifted into TextElement nor written back. Best
  // guesses at semantics are kept in the field doc — none verified.

  /** 文本编码 / 加密标志. Best guess: integer flag. */
  textEncodingFlag: ProtoField(45103, ScalarType.UINT32, { optional: true }),

  /** 字体 / 样式相关. Best guess: integer flag. */
  fontStyle: ProtoField(45104, ScalarType.UINT32, { optional: true }),

  /** 气泡 ID. Best guess: string id. */
  bubbleId: ProtoField(45105, ScalarType.STRING, { optional: true }),

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

  // ---- PTT (elementType=4) ----
  // PTT reuses most PIC tags (45402-45518, 45815) for file metadata.

  /** Transfer state (optional). */
  transferState: ProtoField(45550, ScalarType.UINT32, { optional: true }),

  /** Voice type: 1=intercom, 2=recording. Required for PTT elements. */
  pttType: ProtoField(45906, ScalarType.UINT32, { optional: true }),

  /** PTT protocol flag. */
  pttFlag45907: ProtoField(45907, ScalarType.UINT32, { optional: true }),

  pttFlag45909: ProtoField(45909, ScalarType.UINT32, { optional: true }),

  /** Whether voice is changed/transformed. Required for PTT elements. */
  voiceChanged: ProtoField(45911, ScalarType.BOOL, { optional: true }),

  pttFlag45922: ProtoField(45922, ScalarType.UINT32, { optional: true }),

  /** Audio waveform data for visualization. Required for PTT elements. */
  waveform: ProtoField(45925, ScalarType.BYTES, { optional: true }),

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

  // ---- ARK (elementType=10) ----

  /**
   * Ark card / mini-program JSON payload. UTF-8 string holding a JSON
   * document. Shape varies per `view` field of the JSON — see ArkPayload
   * and `SAMPLE_GAME_CENTER_AD` in `element/ark.ts` for a worked example.
   */
  arkData: ProtoField(47901, ScalarType.STRING, { optional: true }),

  // ---- MFACE / marketface (elementType=11) ----
  // Market emoji (commercial sticker). Uses the disjoint 80xxx tag block.
  // Only the fields below are understood; the remaining 80xxx tags are parsed
  // for round-trip completeness with best-guess wire types (semantics
  // unverified — see the per-field docs).

  /** Emoji package / pack ID. Required for MFACE elements. */
  emojiPackId: ProtoField(80810, ScalarType.UINT32, { optional: true }),

  /** Emoji character ID (key). Required for MFACE elements. */
  emojiId: ProtoField(80824, ScalarType.STRING, { optional: true }),

  /** Unknown length-delimited field. Required for MFACE elements. */
  mfaceFlag80900: ProtoField(80900, ScalarType.STRING, { optional: true }),

  /** Emoji type. Required for MFACE elements. */
  mfaceType: ProtoField(80901, ScalarType.UINT32, { optional: true }),

  /** Emoji sub-type flag. Required for MFACE elements. */
  mfaceSubType: ProtoField(80902, ScalarType.BOOL, { optional: true }),

  /** Preview image MD5. Required for MFACE elements. */
  previewMd5: ProtoField(80903, ScalarType.BYTES, { optional: true }),

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

  /** 宽高列表. Best guess: packed/nested → bytes. */
  mfaceFlag80970: ProtoField(80970, ScalarType.BYTES, { optional: true }),

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
  // Share card for a QQ-zone dynamic (说说/动态). All fields below are
  // required for QQ_DYNAMIC elements except the repeated tag list.

  /** 动态类型. Required for QQ_DYNAMIC elements. */
  dynamicType: ProtoField(48172, ScalarType.UINT32, { optional: true }),

  /** 动态 id. Required for QQ_DYNAMIC elements. */
  dynamicId: ProtoField(48173, ScalarType.STRING, { optional: true }),

  /** Unknown int. Required for QQ_DYNAMIC elements. */
  dynamicFlag48174: ProtoField(48174, ScalarType.UINT32, { optional: true }),

  /** Primary description block (main + sub desc). Required for QQ_DYNAMIC elements. */
  dynamicDesc: ProtoField(48175, () => QqDynamicDescWire, { optional: true }),

  /** Secondary description block (same shape as 48175). Required for QQ_DYNAMIC elements. */
  dynamicDesc2: ProtoField(48176, () => QqDynamicDescWire, { optional: true }),

  /** 封面图 url. Required for QQ_DYNAMIC elements. */
  dynamicCoverUrl: ProtoField(48180, ScalarType.STRING, { optional: true }),

  /** QQ 空间 logo url. Required for QQ_DYNAMIC elements. */
  dynamicZoneLogoUrl: ProtoField(48181, ScalarType.STRING, { optional: true }),

  /** 动态发布者 QQ uin. Required for QQ_DYNAMIC elements. */
  dynamicPublisherUin: ProtoField(48182, ScalarType.UINT32, { optional: true }),

  /** 动态 meta 数据. Required for QQ_DYNAMIC elements. */
  dynamicMeta: ProtoField(48183, ScalarType.STRING, { optional: true }),

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
