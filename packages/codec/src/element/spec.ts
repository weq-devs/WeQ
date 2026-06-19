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
  ElementType,
  PicSubType,
  PicType,
  PttType,
  GrayTipSubType,
  CallSubType,
  CallType,
  FaceSubType,
  ActionType,
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
  bubbleId: z.string().optional(),
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
  bubbleId: z.string().optional(),
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
  summary: z.array(z.string()),
  pttType: z.nativeEnum(PttType),
  voiceChanged: z.boolean(),
  waveform: z.instanceof(Uint8Array),
  transferState: z.number().optional(),
  picTransferState: z.number().optional(),
  transferVersion: z.number().optional(),
  pttFlag45907: z.number().optional(),
  pttFlag45909: z.number().optional(),
  pttFlag45922: z.number().optional(),
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
  recallElements: z.array(z.any()).optional(),
  recallFlag47711: z.number().optional(),
});

export const GrayTipPokeElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('grayTipPoke'),
  subType: z.literal(GrayTipSubType.POKE),
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
});

export const GrayTipInviteElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('grayTipInvite'),
  subType: z.literal(GrayTipSubType.INVITE),
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
  dynamicTags: z.any().optional(),
  recallElements: z.array(z.any()).optional(),
});

export const ArkElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('ark'),
  arkData: z.string(),
});

export const MfaceElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('mface'),
  emojiPackId: z.number(),
  emojiId: z.string(),
  mfaceFlag80900: z.string(),
  mfaceType: z.number(),
  mfaceSubType: z.boolean(),
  previewMd5: z.instanceof(Uint8Array),
  mediaType: z.number(),
  renderFlag: z.boolean(),
  previewWidth: z.number(),
  previewHeight: z.number(),
  isAnimated: z.boolean(),
  mfaceFlag80907: z.instanceof(Uint8Array).optional(),
  mfaceFlag80913: z.instanceof(Uint8Array).optional(),
  mfaceFlag80941: z.instanceof(Uint8Array).optional(),
  mfaceFlag80942: z.instanceof(Uint8Array).optional(),
  mfaceFlag80970: z.instanceof(Uint8Array).optional(),
  mfaceFlag80975: z.number().optional(),
  mfaceFlag80977: z.instanceof(Uint8Array).optional(),
  mfaceFlag80978: z.string().optional(),
  mfaceFlag80980: z.number().optional(),
  mfaceFlag80981: z.number().optional(),
  mfaceFlag80983: z.string().optional(),
  mfaceFlag80995: z.number().optional(),
});

export const MarkdownElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('markdown'),
  markdownContent: z.string(),
  markdownMeta: z.any(),
  markdownFlag48703: z.any(),
  markdownFlag48704: z.string(),
  markdownTextSummary: z.string(),
  markdownFlag48706: z.number(),
  flashTransferProto1: z.instanceof(Uint8Array).optional(),
  flashTransferInfo: z.any().optional(),
  flashTransferProto3: z.instanceof(Uint8Array).optional(),
});

export const MultiMsgElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('multiMsg'),
  resId: z.string(),
  xmlContent: z.string(),
  sessionId: z.string(),
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

export const WalletElementSchema = BaseElementFieldsSchema.extend({
  kind: z.literal('wallet'),
  walletTargetUin: z.number().optional(),
  walletTransferProto: z.instanceof(Uint8Array).optional(),
  walletDetail: z.any().optional(),
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
  walletExt: z.any().optional(),
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
  dynamicPublisherUin: z.number(),
  dynamicMeta: z.string(),
  dynamicTags: z
    .array(
      z.object({
        flag48191: z.boolean().optional(),
        tagId: z.number().optional(),
        tagContent: z.string().optional(),
      }),
    )
    .optional(),
});

export const ElementSchema = z.discriminatedUnion('kind', [
  TextElementSchema,
  AtElementSchema,
  PicElementSchema,
  FileElementSchema,
  VideoElementSchema,
  PttElementSchema,
  FaceElementSchema,
  ReplyElementSchema,
  GrayTipRevokeElementSchema,
  GrayTipPokeElementSchema,
  GrayTipGroupElementSchema,
  GrayTipInviteElementSchema,
  WalletElementSchema,
  ArkElementSchema,
  MfaceElementSchema,
  MarkdownElementSchema,
  MultiMsgElementSchema,
  CallElementSchema,
  OnlineFileElementSchema,
  OnlineFolderElementSchema,
  EmojiBounceElementSchema,
  QqDynamicElementSchema,
  UnknownElementSchema,
]);

// Infer TypeScript types from schemas
export type TextElement = z.infer<typeof TextElementSchema>;
export type AtElement = z.infer<typeof AtElementSchema>;
export type PicElement = z.infer<typeof PicElementSchema>;
export type FileElement = z.infer<typeof FileElementSchema>;
export type VideoElement = z.infer<typeof VideoElementSchema>;
export type PttElement = z.infer<typeof PttElementSchema>;
export type FaceElement = z.infer<typeof FaceElementSchema>;
export type ReplyElement = z.infer<typeof ReplyElementSchema>;
export type GrayTipRevokeElement = z.infer<typeof GrayTipRevokeElementSchema>;
export type GrayTipPokeElement = z.infer<typeof GrayTipPokeElementSchema>;
export type GrayTipGroupElement = z.infer<typeof GrayTipGroupElementSchema>;
export type GrayTipInviteElement = z.infer<typeof GrayTipInviteElementSchema>;
export type ArkElement = z.infer<typeof ArkElementSchema>;
export type MfaceElement = z.infer<typeof MfaceElementSchema>;
export type MarkdownElement = z.infer<typeof MarkdownElementSchema>;
export type MultiMsgElement = z.infer<typeof MultiMsgElementSchema>;
export type CallElement = z.infer<typeof CallElementSchema>;
export type WalletElement = z.infer<typeof WalletElementSchema>;
export type OnlineFileElement = z.infer<typeof OnlineFileElementSchema>;
export type OnlineFolderElement = z.infer<typeof OnlineFolderElementSchema>;
export type EmojiBounceElement = z.infer<typeof EmojiBounceElementSchema>;
export type QqDynamicElement = z.infer<typeof QqDynamicElementSchema>;
export type UnknownElement = z.infer<typeof UnknownElementSchema>;
export type Element = z.infer<typeof ElementSchema>;
