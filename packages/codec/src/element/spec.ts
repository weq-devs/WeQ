/**
 * Zod schemas for element validation — runtime type checking to determine
 * required vs optional fields for each element kind.
 *
 * Usage:
 *   import { TextElementSchema } from './spec';
 *   const result = TextElementSchema.safeParse(data);
 *   if (result.success) { ... }
 */

import { z } from 'zod';
import {
  PicType,
  GrayTipSubType,
  CallType,
} from './types';

const BaseElementFieldsSchema = z.object({
  elementId: z.bigint().optional(),
  isSender: z.boolean().optional(),
  subType: z.number().optional(),
});

export const TextElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('text'),
  textContent: z.string(),
  textReserve: z.number().optional(),
  textEncodingFlag: z.number().optional(),
  fontStyle: z.number().optional(),
  atTargetUid: z.string().optional(),
  textInputState: z.number().optional(),
  translationFlag: z.number().optional(),
  linkDetectionFlag: z.number().optional(),
  atMentionMask: z.string().optional(),
  walletFlag: z.number().optional(),
  urlVerifyFlag: z.instanceof(Uint8Array).optional(),
});

export const AtElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('at'),
  textContent: z.string(),
  textReserve: z.number().optional(),
  textEncodingFlag: z.number().optional(),
  fontStyle: z.number().optional(),
  atTargetUid: z.string().optional(),
  textInputState: z.number().optional(),
  translationFlag: z.number().optional(),
  linkDetectionFlag: z.number().optional(),
  atMentionMask: z.string().optional(),
  walletFlag: z.number().optional(),
  urlVerifyFlag: z.instanceof(Uint8Array).optional(),
});

export const PicElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('pic'),
  fileName: z.string(),
  fileSize: z.number(),
  md5Bytes: z.instanceof(Uint8Array),
  contentHash: z.instanceof(Uint8Array),
  imgWidth: z.number(),
  imgHeight: z.number(),
  imgType: z.nativeEnum(PicType),
  isOriginal: z.boolean(),
  /** StoreId（@weq/protocol 老 wire 解码带出，本地 codec 元素无此字段）。 */
  storeId: z.number().optional(),
  md5: z.string(),
  fileToken: z.string(),
  uploadTime: z.number(),
  uploadTimestamp: z.number(),
  fileTTL: z.number(),
  thumbnailUrl: z.string(),
  previewUrl: z.string(),
  originalUrl: z.string(),
  summary: z.array(z.string()),
  cdnHost: z.string(),
  filePath: z.string().optional(),
  picTransferState: z.number().optional(),
  transferVersion: z.number().optional(),
  picFlag45817: z.number().optional(),
  picFlag45818: z.string().optional(),
  picFlag45819: z.string().optional(),
  picFlag45820: z.string().optional(),
  picFlag45821: z.number().optional(),
  picFlag45822: z.number().optional(),
  picFlag45823: z.number().optional(),
  picFlag45824: z.string().optional(),
  picFlag45825: z.number().optional(),
  picFlag45826: z.number().optional(),
  picFlag45827: z.number().optional(),
  picFlag45828: z.string().optional(),
  picFlag45600: z.instanceof(Uint8Array).optional(),
  picFlag45805: z.number().optional(),
  cdnServerIp: z.number().optional(),
  cdnServerPort: z.number().optional(),
  thumbnailLocalPath: z.string().optional(),
  previewLocalPath: z.string().optional(),
  originalLocalPath: z.string().optional(),
  picFlag45425: z.number().optional(),
  picFlag45801: z.string().optional(),
  picFlag45829: z.number().optional(),
  picFlag45830: z.number().optional(),
  picFlag45831: z.number().optional(),
  picFlag45557: z.number().optional(),
  transferFlag45507: z.bigint().optional(),
  transferFlag45509: z.number().optional(),
});

export const FileElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('file'),
  /**
   * File type discriminator — ~20 known values observed on FILE rows.
   * TODO: enumerate as a `FileSubType` enum once the values are mapped.
   */
  subType: z.number(),
  fileName: z.string(),
  filePath: z.string(),
  fileSize: z.number(),
  md5Bytes: z.instanceof(Uint8Array),
  md5Bytes2: z.instanceof(Uint8Array),
  contentHash: z.instanceof(Uint8Array),
  imgWidth: z.number(),
  imgHeight: z.number(),
  fileFlag45415: z.number(),
  /** 群文件 busId（@weq/protocol 老 wire 解码带出，本地 codec 元素无此字段）。 */
  busId: z.number().optional(),
  fileToken: z.string(),
  transferFlag45504: z.string(),
  uploadTime: z.number(),
  picTransferState: z.number(),
  transferVersion: z.number(),
  transferState: z.number(),
  fileFlag45409: z.instanceof(Uint8Array),
  fileFlag45501: z.number(),
  videoToken: z.string(),
  fileFlag45512: z.boolean(),
  fileFlag45514: z.boolean(),
  transferErrorText: z.string().optional(),
  fileFlag45533: z.number().optional(),
  fileThumbPathRemote: z.string().optional(),
  fileThumbPathRemote2: z.string().optional(),
  fileThumbLocalPath: z.string().optional(),
  fileFlag45966: z.instanceof(Uint8Array).optional(),
  fileFlag45967: z.instanceof(Uint8Array).optional(),
  fileGroupMeta: z.instanceof(Uint8Array).optional(),
  transferFlag45507: z.bigint().optional(),
  transferFlag45509: z.number().optional(),
});

export const VideoElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('video'),
  /**
   * Video file type discriminator.
   * TODO: enumerate as a `VideoSubType` enum once the values are mapped.
   */
  subType: z.number(),
  fileName: z.string(),
  fileSize: z.number(),
  md5Bytes: z.instanceof(Uint8Array),
  contentHash: z.instanceof(Uint8Array),
  imgWidth: z.number(),
  imgHeight: z.number(),
  fileFlag45415: z.number(),
  /** StoreId（@weq/protocol 老 wire 解码带出，本地 codec 元素无此字段）。 */
  storeId: z.number().optional(),
  isOriginal: z.boolean(),
  fileToken: z.string(),
  uploadTime: z.number(),
  picTransferState: z.number(),
  transferVersion: z.number(),
  uploadTimestamp: z.number(),
  fileTTL: z.number(),
  summary: z.array(z.string()),
  videoDuration: z.number(),
  videoWidth: z.number(),
  videoHeight: z.number(),
  videoFlag45421: z.instanceof(Uint8Array),
  coverFileName: z.string(),
  videoFlag45423: z.boolean(),
  videoToken: z.string(),
  expireTimestamp: z.number(),
  validPeriodSec: z.number(),
  secondExpireTimestamp: z.number(),
  channelParams: z.instanceof(Uint8Array),
  videoFlag45863: z.number(),
  videoCoverLocalPath: z.string().optional(),
  videoFlag45851: z.number().optional(),
  videoFlag45852: z.number().optional(),
  videoFlag45853: z.number().optional(),
  videoFlag45854: z.number().optional(),
  videoFlag45855: z.number().optional(),
  videoFlag45856: z.any().optional(),
  videoFlag45865: z.number().optional(),
  fileThumbLocalPath: z.string().optional(),
  transferFlag45507: z.bigint().optional(),
  transferFlag45509: z.number().optional(),
});

/** elementType=49 BUBBLE_VIDEO：wire 字段与 VIDEO 完全相同，仅渲染为圆形循环视频。 */
export const BubbleVideoElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('bubbleVideo'),
  subType: z.number(),
  fileName: z.string(),
  fileSize: z.number(),
  md5Bytes: z.instanceof(Uint8Array),
  contentHash: z.instanceof(Uint8Array),
  imgWidth: z.number(),
  imgHeight: z.number(),
  fileFlag45415: z.number(),
  /** StoreId（@weq/protocol 老 wire 解码带出，本地 codec 元素无此字段）。 */
  storeId: z.number().optional(),
  isOriginal: z.boolean(),
  fileToken: z.string(),
  uploadTime: z.number(),
  picTransferState: z.number(),
  transferVersion: z.number(),
  uploadTimestamp: z.number(),
  fileTTL: z.number(),
  summary: z.array(z.string()),
  videoDuration: z.number(),
  videoWidth: z.number(),
  videoHeight: z.number(),
  videoFlag45421: z.instanceof(Uint8Array),
  coverFileName: z.string(),
  videoFlag45423: z.boolean(),
  videoToken: z.string(),
  expireTimestamp: z.number(),
  validPeriodSec: z.number(),
  secondExpireTimestamp: z.number(),
  channelParams: z.instanceof(Uint8Array),
  videoFlag45863: z.number(),
  videoCoverLocalPath: z.string().optional(),
  videoFlag45851: z.number().optional(),
  videoFlag45852: z.number().optional(),
  videoFlag45853: z.number().optional(),
  videoFlag45854: z.number().optional(),
  videoFlag45855: z.number().optional(),
  videoFlag45856: z.any().optional(),
  videoFlag45865: z.number().optional(),
  fileThumbLocalPath: z.string().optional(),
  transferFlag45507: z.bigint().optional(),
  transferFlag45509: z.number().optional(),
  templateName: z.string().optional(),
});

export const PttElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('ptt'),
  fileName: z.string(),
  filePath: z.string(),
  fileSize: z.number(),
  md5Bytes: z.instanceof(Uint8Array),
  contentHash: z.instanceof(Uint8Array),
  isOriginal: z.boolean(),
  md5: z.string(),
  fileToken: z.string(),
  uploadTime: z.number(),
  uploadTimestamp: z.number(),
  fileTTL: z.number(),
  /** StoreId（@weq/protocol 老 wire 解码带出，本地 codec 元素无此字段）。 */
  storeId: z.number().optional(),
  summary: z.array(z.string()),
  /** Clip duration in seconds (wire tag 45906). Authoritative for both the
   * 时长 label and bubble width — waveform length is not. */
  pttDuration: z.number(),
  voiceChanged: z.boolean(),
  /** AI 声聊 flag (wire tag 45915): true only on AI-voice-chat clips, absent
   * otherwise. Reliable classifier; their waveform is a synthetic placeholder. */
  isAiVoice: z.boolean().optional(),
  waveform: z.instanceof(Uint8Array),
  transferState: z.number().optional(),
  picTransferState: z.number().optional(),
  transferVersion: z.number().optional(),
  pttFlag45907: z.number().optional(),
  pttFlag45909: z.number().optional(),
  pttFlag45922: z.number().optional(),
  /** QQ 自带的语音转文字结果（wire tag 45923），跑过「转文字」后才有。 */
  pttTranscript: z.string().optional(),
  pttFlag45924: z.number().optional(),
  pttFlag45926: z.number().optional(),
  pttFlag45903: z.number().optional(),
  pttFlag45912: z.number().optional(),
  pttVoiceId: z.string().optional(),
  pttFlag45908: z.any().optional(),
  pttFlag45601: z.instanceof(Uint8Array).optional(),
});

export const FaceElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('face'),
  faceId: z.number(),
  faceText: z.string(),
  faceExtDesc: z.string().optional(),
  superEmojiCategory: z.string().optional(),
  AniStickerId: z.string().optional(),
  superEmojiFlag1: z.number().optional(),
  superEmojiFlag2: z.number().optional(),
  diceValue: z.string().optional(),
  faceFlag47608: z.instanceof(Uint8Array).optional(),
  superEmojiFlag3: z.number().optional(),
  superEmojiFlag4: z.number().optional(),
  canChain: z.boolean().optional(),
  faceFlag47611: z.number().optional(),
  interactiveFaceName: z.string().optional(),
  faceFlag47613: z.number().optional(),
  faceFlag47614: z.number().optional(),
  interactiveFaceName2: z.string().optional(),
  interactiveFaceVersion: z.string().optional(),
  faceFlag47617: z.number().optional(),
  faceFlag47618: z.number().optional(),
  faceFlag47619: z.number().optional(),
  faceFlag47620: z.number().optional(),
  faceFallbackText: z.string().optional(),
});

export const ReplyElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('reply'),
  origSenderUid: z.string(),
  origReceiverUid: z.string(),
  origMsgSeq: z.number(),
  origSenderUin: z.number(),
  origMsgTime: z.number(),
  origReceiverUin: z.number(),
  origMsgId: z.bigint(),
  origMsgIndex: z.number(),
  replyFlag47422: z.bigint(),
  origElements: z.array(z.any()),
  replyOrigMsgIdRef: z.bigint().optional(),
  replyTextSummary: z.string().optional(),
  replyFlag47415: z.boolean().optional(),
  replyFlag47418: z.boolean().optional(),
  replyFlag47405: z.number().optional(),
  replyFlag47407: z.number().optional(),
  replyOrigSenderBlob: z.instanceof(Uint8Array).optional(),
  /** 被回复者的群名片/昵称（wire tag 47421）。 */
  replyOrigSenderNick: z.string().optional(),
  replyFlag47424: z.number().optional(),
  replyFlag47425: z.number().optional(),
  replyOrigMsgSeqCopy: z.number().optional(),
});

export const GrayTipRevokeElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('grayTipRevoke'),
  subType: z.literal(GrayTipSubType.REVOKE),
  recallFlag47702: z.number(),
  recallSenderUid: z.string(),
  recallRevokeUid: z.string(),
  recallSenderNick: z.string(),
  recallDisplayText: z.string(),
  recallRevokeNick: z.string(),
  /** 被撤回消息的原始 element 副本，仅透传给上层、当前无人解析。 */
  recallElements: z.array(z.unknown()).optional(),
  recallFlag47711: z.number().optional(),
  /** 被撤回者的昵称副本 / 群名片（47706/47707）。 */
  recallSenderNickCopy: z.string().optional(),
  recallSenderGroupNick: z.string().optional(),
  /** 撤回者的昵称副本 / 群名片（47715/47716）。 */
  recallRevokeNickCopy: z.string().optional(),
  recallRevokeGroupNick: z.string().optional(),
  recallFlag47712: z.number().optional(),
});

export const GrayTipPokeElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('grayTipPoke'),
  subType: z.literal(GrayTipSubType.JSON),
  actionId: z.number(),
  detailedId: z.number(),
  typeFlag: z.number(),
  grayTipXmlContent: z.string(),
  businessId: z.number(),
  actionUniqueId: z.number(),
  tipJson: z.string(),
  tipType: z.number(),
  actionInitiator: z.object({ uid: z.string().optional(), nickname: z.string().optional() }).optional(),
  actionTarget: z.object({ uid: z.string().optional(), nickname: z.string().optional() }).optional(),
  actionAttributes: z.array(z.object({ key: z.string().optional(), value: z.string().optional() })).optional(),
  grayTipReserved: z.string().optional(),
  grayTipFlag48272: z.boolean().optional(),
  grayTipFlag48275: z.number().optional(),
  grayTipFlag48219: z.number().optional(),
  grayTipFlag48220: z.number().optional(),
  /** 互动标识提示原文（wire tag 48274），tipJson 的纯文本版。 */
  grayTipPlainText: z.string().optional(),
  grayTipTimestamp: z.number().optional(),
});

export const GrayTipGroupElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('grayTipGroup'),
  subType: z.literal(GrayTipSubType.GROUP_TIP),
  groupTipType: z.number(),
  user1Uid: z.string().optional(),
  user1Nick: z.string().optional(),
  user1GroupNick: z.string().optional(),
  user2Uid: z.string().optional(),
  user2Nick: z.string().optional(),
  user2GroupNick: z.string().optional(),
  muteInfo: z.object({
    operator: z.object({ uid: z.string().optional() }).optional(),
    mutedUser: z.object({ uid: z.string().optional(), groupNick: z.string().optional() }).optional(),
    timestamp: z.bigint().optional(),
    duration: z.number().optional(),
  }).optional(),
  groupTipFlag48502: z.number().optional(),
  /** 提示所指的群名称（wire tag 48509）。 */
  groupTipGroupName: z.string().optional(),
  groupTipFlag48510: z.number().optional(),
  groupTipFlag48511: z.number().optional(),
  grayTipTimestamp: z.number().optional(),
});

/** QQ 动态标签列表（48189），对应 QqDynamicTagWire。 */
export const QqDynamicTagListSchema = z
  .array(
    z.object({
      flag48191: z.boolean().optional(),
      tagId: z.number().optional(),
      tagContent: z.string().optional(),
    }),
  )
  .optional();

export const GrayTipXmlElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('grayTipXml'),
  subType: z.literal(GrayTipSubType.XML_MSG),
  actionId: z.number().optional(),
  detailId: z.number().optional(),
  typeFlag: z.number().optional(),
  grayTipXmlContent: z.string().optional(),
  businessId: z.number().optional(),
  actionUniqueId: z.number().optional(),
  callSummary: z.array(z.string()).optional(),
  actionInitiator: z.object({ uid: z.string().optional(), nickname: z.string().optional() }).optional(),
  actionTarget: z.object({ uid: z.string().optional(), nickname: z.string().optional() }).optional(),
  actionAttributes: z.array(z.object({ key: z.string().optional(), value: z.string().optional() })).optional(),
  tipJson: z.string().optional(),
  tipType: z.number().optional(),
  dynamicTags: QqDynamicTagListSchema,
  /** 被撤回消息的原始 element 副本，仅透传给上层、当前无人解析。 */
  recallElements: z.array(z.unknown()).optional(),
  grayTipFlag48219: z.number().optional(),
  grayTipFlag48220: z.number().optional(),
  grayTipTimestamp: z.number().optional(),
});

/**
 * 文件传输完成灰条 (subType=10). Structurally a FILE element wearing an
 * elementType=8 hat — it reuses the 454xx/455xx tags and carries no gray-tip
 * fields at all. It marks a finished transfer in either direction (a file
 * received from the peer, or one we uploaded successfully). `fileName` appears
 * twice on the wire; we keep the first.
 */
export const GrayTipFileRecvElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('grayTipFileRecv'),
  subType: z.literal(GrayTipSubType.FILE),
  fileName: z.string(),
  fileSize: z.number(),
  md5Bytes2: z.instanceof(Uint8Array).optional(),
  fileToken: z.string().optional(),
  imgWidth: z.number().optional(),
  imgHeight: z.number().optional(),
  videoDuration: z.number().optional(),
});

/**
 * 临时会话提示灰条 (subType=15). QQ renders it as 「该用户通过 <群名> 群聊向
 * 你发起临时会话」— the group is identified by `tempSessionGroupCode`.
 */
export const GrayTipTempSessionElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('grayTipTempSession'),
  subType: z.literal(GrayTipSubType.AIO_OP),
  /** 来源群号（十进制字符串）。 */
  tempSessionGroupCode: z.string(),
  aioOpFlag47501: z.number().optional(),
  /** Redundant copy of the row-level peer uid (wire tag 40021). */
  origReceiverUid: z.string().optional(),
});

export const ArkElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('ark'),
  arkData: z.string(),
  arkSignature: z.string().optional(),
  arkCardId: z.string().optional(),
});

export const MfaceElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('mface'),
  emojiPackId: z.number(),
  encryptKey: z.string(),
  emojiDesc: z.string(),
  mfaceType: z.number(),
  mfaceSubType: z.boolean(),
  marketEmoticonId: z.instanceof(Uint8Array),
  mediaType: z.number(),
  renderFlag: z.boolean(),
  previewWidth: z.number(),
  previewHeight: z.number(),
  isAnimated: z.boolean(),
  mfaceFlag80907: z.instanceof(Uint8Array).optional(),
  mfaceFlag80913: z.instanceof(Uint8Array).optional(),
  mfaceFlag80941: z.instanceof(Uint8Array).optional(),
  mfaceFlag80942: z.instanceof(Uint8Array).optional(),
  sizeInfo: z.instanceof(Uint8Array).optional(),
  mfaceFlag80975: z.number().optional(),
  mfaceFlag80977: z.instanceof(Uint8Array).optional(),
  mfaceFlag80978: z.string().optional(),
  mfaceFlag80980: z.number().optional(),
  mfaceFlag80981: z.number().optional(),
  mfaceFlag80983: z.string().optional(),
  mfaceFlag80995: z.number().optional(),
});

/** markdown 元数据（48702），字段对应 MarkdownMetaWire。 */
export const MarkdownMetaSchema = z.object({
  flag1: z.number().optional(),
  buildTimestamp: z.number().optional(),
  flag3: z.instanceof(Uint8Array).optional(),
  flag4: z.number().optional(),
});

/** markdown 48703 块，对应 MarkdownFlag48703Wire。 */
export const MarkdownFlag48703Schema = z.object({
  field48720: z.string().optional(),
  field48721: z.string().optional(),
  field48722: z.number().optional(),
});

/** 闪传缩略图 URL（48708 → 4 → 2），对应 FlashTransferThumbUrlWire。 */
export const FlashTransferThumbUrlSchema = z.object({
  type: z.number().optional(),
  url: z.string().optional(),
});

/** 闪传缩略图备选（48708 → 4），对应 FlashTransferThumbAltWire。 */
export const FlashTransferThumbAltSchema = z.object({
  fileId: z.string().optional(),
  urlInfo: FlashTransferThumbUrlSchema.optional(),
});

/** QQ 闪传信息（48708），对应 FlashTransferInfoWire。 */
export const FlashTransferInfoSchema = z.object({
  fileSetId: z.string().optional(),
  thumbnailName: z.string().optional(),
  fileBytes: z.number().optional(),
  thumbAlt: FlashTransferThumbAltSchema.optional(),
  createTime: z.number().optional(),
});

export const MarkdownElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('markdown'),
  markdownContent: z.string(),
  markdownMeta: MarkdownMetaSchema,
  markdownFlag48703: MarkdownFlag48703Schema,
  markdownFlag48704: z.string(),
  markdownTextSummary: z.string(),
  markdownFlag48706: z.number(),
  /** 机器人 markdown 卡片的可见正文（49099）；49093 只有 "[Markdown]" 标签时用它。 */
  markdownContent49099: z.string().optional(),
  flashTransferProto1: z.instanceof(Uint8Array).optional(),
  flashTransferInfo: FlashTransferInfoSchema.optional(),
  flashTransferProto3: z.instanceof(Uint8Array).optional(),
});

export const MultiMsgElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('multiMsg'),
  resId: z.string(),
  xmlContent: z.string(),
  sessionId: z.string(),
});

/** elementType=13 STRUCT_LONG_MSG：结构化长消息。字段参考 MultiMsg，具体结构待观测。 */
export const StructLongMsgElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('structLongMsg'),
  resId: z.string().optional(),
  xmlContent: z.string().optional(),
  sessionId: z.string().optional(),
});

/** 机器人内联键盘的单个按钮（48753），对应 InlineKeyboardButtonWire。 */
export const InlineKeyboardButtonSchema = z.object({
  buttonId: z.string().optional(),
  label: z.string().optional(),
  visitedLabel: z.string().optional(),
  style: z.number().optional(),
  flag48758: z.number().optional(),
  flag48759: z.number().optional(),
  flag48760: z.string().optional(),
  action: z.string().optional(),
  flag48762: z.number().optional(),
  actionType: z.number().optional(),
  flag48766: z.number().optional(),
  flag48767: z.number().optional(),
  flag48768: z.number().optional(),
  flag48772: z.number().optional(),
  flag48790: z.string().optional(),
});

/** 机器人内联键盘的一行（48751），对应 InlineKeyboardRowWire。 */
export const InlineKeyboardRowSchema = z.object({
  buttons: z.array(InlineKeyboardButtonSchema).optional(),
});

export const InlineKeyboardElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('inlineKeyboard'),
  keyboardRows: z.array(InlineKeyboardRowSchema),
  keyboardBotAppId: z.bigint().optional(),
});

export const CallElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('call'),
  answerType: z.number(),
  duration: z.number(),
  callMethod: z.nativeEnum(CallType),
  callSummary: z.array(z.string()),
  callFlag48153: z.string().optional(),
  callUnknownType: z.number().optional(),
  callFlag48156: z.number().optional(),
});

/** 钱包详情（48403），对应 WalletDetailWire。 */
/** 群收款单个收款人（tag 8 within 48461）*/
export const ReceiptPayerSchema = z.object({
  uin: z.union([z.string(), z.bigint()]).optional(),
  amount: z.number().optional(),
});

/** 群收款收款人列表（tag 48461）*/
export const ReceiptListSchema = z.object({
  skinId: z.number().optional(),
  payers: z.array(ReceiptPayerSchema).optional(),
});

export const WalletDetailSchema = z.object({
  flag48441: z.number().optional(),
  redbagType: z.number().optional(),
  redbagTitle: z.string().optional(),
  openPrompt: z.string().optional(),
  subTitle: z.string().optional(),
  flag48446: z.string().optional(),
  flag48447: z.string().optional(),
  display: z.string().optional(),
  flag48449: z.number().optional(),
  flag48450: z.number().optional(),
  flag48451: z.string().optional(),
  flag48452: z.string().optional(),
  flag48453: z.string().optional(),
  orderUrl: z.string().optional(),
  receiptList: ReceiptListSchema.optional(),
});

/** 钱包扩展（48421），对应 WalletExtWire。 */
export const WalletExtSchema = z.object({
  flag3: z.boolean().optional(),
  redbagCover: z.string().optional(),
  flag7: z.boolean().optional(),
  flag8: z.boolean().optional(),
});

export const WalletElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('wallet'),
  walletTargetUin: z.number().optional(),
  walletTransferProto: z.instanceof(Uint8Array).optional(),
  walletDetail: WalletDetailSchema.optional(),
  walletFlag48404: z.number().optional(),
  walletFlag48405: z.number().optional(),
  walletFlag48406: z.number().optional(),
  walletFlag48407: z.number().optional(),
  walletFlag48408: z.number().optional(),
  walletOrderId: z.string().optional(),
  walletFlag48410: z.string().optional(),
  walletFlag48411: z.number().optional(),
  walletRedbagType: z.number().optional(),
  walletFlag48417: z.instanceof(Uint8Array).optional(),
  walletFlag48418: z.string().optional(),
  walletFlag48419: z.number().optional(),
  walletDesignatedUin: z.number().optional(),
  walletExt: WalletExtSchema.optional(),
  walletFlag48437: z.number().optional(),
  walletFlag48438: z.number().optional(),
});

export const OnlineFileElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('onlineFile'),
  fileName: z.string(),
  filePath: z.string(),
  fileSize: z.number(),
  imgWidth: z.number(),
  imgHeight: z.number(),
  fileToken: z.string(),
  fileFlag45415: z.number().optional(),
  transferFlag45504: z.string().optional(),
});

export const OnlineFolderElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('onlineFolder'),
  fileName: z.string(),
  filePath: z.string(),
  fileSize: z.number(),
  fileToken: z.string(),
  fileFlag45415: z.number().optional(),
  transferFlag45504: z.string().optional(),
});

export const UnknownElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('unknown'),
  elementType: z.number(),
  raw: z.any(),
});

/** 位置共享 (elementType=28). Only carries the display text. */
export const ShareLocationElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('shareLocation'),
  shareLocationText: z.string(),
});

export const EmojiBounceElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('emojiBounce'),
  emojiBounceId: z.number(),
  emojiBounceFlag52133: z.boolean(),
  emojiBounceName: z.string(),
  emojiBounceDetail: z.object({
    flag52142: z.number().optional(),
    name: z.string().optional(),
    textSummary: z.string().optional(),
  }),
  emojiBounceTextSummary: z.string(),
  emojiBouncePcText: z.string(),
});

export const QqDynamicElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('qqDynamic'),
  dynamicType: z.number(),
  dynamicId: z.string(),
  dynamicFlag48174: z.number(),
  dynamicDesc: z.object({
    mainDesc: z.string().optional(),
    subDesc: z.string().optional(),
  }),
  dynamicDesc2: z.object({
    mainDesc: z.string().optional(),
    subDesc: z.string().optional(),
  }),
  dynamicCoverUrl: z.string(),
  dynamicZoneLogoUrl: z.string(),
  dynamicPublisherUin: z.array(z.number()),
  dynamicPublisherUid: z.string().optional(),
  dynamicMeta: z.string(),
  dynamicTags: QqDynamicTagListSchema,
});

export const ElementSchema = z.discriminatedUnion('kind', [
  TextElementSchema,
  AtElementSchema,
  PicElementSchema,
  FileElementSchema,
  VideoElementSchema,
  BubbleVideoElementSchema,
  PttElementSchema,
  FaceElementSchema,
  ReplyElementSchema,
  GrayTipRevokeElementSchema,
  GrayTipPokeElementSchema,
  GrayTipGroupElementSchema,
  GrayTipXmlElementSchema,
  GrayTipFileRecvElementSchema,
  GrayTipTempSessionElementSchema,
  WalletElementSchema,
  ArkElementSchema,
  MfaceElementSchema,
  MarkdownElementSchema,
  MultiMsgElementSchema,
  StructLongMsgElementSchema,
  InlineKeyboardElementSchema,
  CallElementSchema,
  OnlineFileElementSchema,
  OnlineFolderElementSchema,
  EmojiBounceElementSchema,
  QqDynamicElementSchema,
  ShareLocationElementSchema,
  UnknownElementSchema,
]);

// Infer TypeScript types from schemas
export type TextElement = z.infer<typeof TextElementSchema>;
export type AtElement = z.infer<typeof AtElementSchema>;
export type PicElement = z.infer<typeof PicElementSchema>;
export type FileElement = z.infer<typeof FileElementSchema>;
export type VideoElement = z.infer<typeof VideoElementSchema>;
export type BubbleVideoElement = z.infer<typeof BubbleVideoElementSchema>;
export type PttElement = z.infer<typeof PttElementSchema>;
export type FaceElement = z.infer<typeof FaceElementSchema>;
export type ReplyElement = z.infer<typeof ReplyElementSchema>;
export type GrayTipRevokeElement = z.infer<typeof GrayTipRevokeElementSchema>;
export type GrayTipPokeElement = z.infer<typeof GrayTipPokeElementSchema>;
export type GrayTipGroupElement = z.infer<typeof GrayTipGroupElementSchema>;
export type GrayTipXmlElement = z.infer<typeof GrayTipXmlElementSchema>;
export type GrayTipFileRecvElement = z.infer<typeof GrayTipFileRecvElementSchema>;
export type GrayTipTempSessionElement = z.infer<typeof GrayTipTempSessionElementSchema>;
export type ArkElement = z.infer<typeof ArkElementSchema>;
export type MfaceElement = z.infer<typeof MfaceElementSchema>;
export type MarkdownElement = z.infer<typeof MarkdownElementSchema>;
export type MultiMsgElement = z.infer<typeof MultiMsgElementSchema>;
export type StructLongMsgElement = z.infer<typeof StructLongMsgElementSchema>;
export type InlineKeyboardButton = z.infer<typeof InlineKeyboardButtonSchema>;
export type InlineKeyboardRow = z.infer<typeof InlineKeyboardRowSchema>;
export type InlineKeyboardElement = z.infer<typeof InlineKeyboardElementSchema>;
export type CallElement = z.infer<typeof CallElementSchema>;
export type WalletElement = z.infer<typeof WalletElementSchema>;
export type OnlineFileElement = z.infer<typeof OnlineFileElementSchema>;
export type OnlineFolderElement = z.infer<typeof OnlineFolderElementSchema>;
export type EmojiBounceElement = z.infer<typeof EmojiBounceElementSchema>;
export type QqDynamicElement = z.infer<typeof QqDynamicElementSchema>;
export type ShareLocationElement = z.infer<typeof ShareLocationElementSchema>;
export type UnknownElement = z.infer<typeof UnknownElementSchema>;
export type Element = z.infer<typeof ElementSchema>;
