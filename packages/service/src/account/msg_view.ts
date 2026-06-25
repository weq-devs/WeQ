/**
 * Render View Model — defines simplified, front-end-friendly Element shapes.
 */

import { decodeElement } from '@weq/codec';
import type {
  Element,
  TextElement,
  PicElement,
  FileElement,
  VideoElement,
  PttElement,
  FaceElement,
  ReplyElement,
  GrayTipRevokeElement,
  GrayTipPokeElement,
  GrayTipGroupElement,
  GrayTipInviteElement,
  ArkElement,
  MfaceElement,
  MarkdownElement,
  MultiMsgElement,
  CallElement,
  WalletElement,
  OnlineFileElement,
  OnlineFolderElement,
  EmojiBounceElement,
  QqDynamicElement,
  UnknownElement,
  AtElement,
} from '@weq/codec';

/** Common metadata fields moved inside the 'data' property. */
interface BaseRenderData {
  elementId?: bigint;
  isSender?: boolean;
  subType?: number;
  /**
   * Export-only: relative path of this media inside the export bundle
   * (e.g. `media/image/xxx.jpg`). Absent in the live app; set by the exporter
   * just before serialization so output files reference the bundled media.
   */
  localPath?: string;
}

export interface RenderTextElement {
  type: 'text';
  data: BaseRenderData & {
    textContent: string;
  };
}

export interface RenderAtElement {
  type: 'at';
  data: BaseRenderData & {
    textContent: string;
    buddleId?: string;
  };
}

export interface RenderPicElement {
  type: 'pic';
  data: BaseRenderData & {
    fileName: string;
    fileSize: number;
    imgWidth: number;
    imgHeight: number;
    imgType: number;
    isOriginal: boolean;
    // md5: string;
    /** CDN download token; used to fetch the image when it isn't on disk. */
    fileToken: string;
    /** Upload/processing time (unix seconds). */
    uploadTime: number;
    /** Upload timestamp (unix seconds). */
    uploadTimestamp: number;
    /** File TTL in seconds; CDN expiry ≈ uploadTimestamp + fileTTL. */
    fileTTL: number;
    // thumbnailUrl: string;
    // previewUrl: string;
    /** CDN path for the original image; used for digit-token (rkey-less) downloads. */
    originalUrl: string;
    summary: string[];
    // cdnHost: string;
    filePath?: string;
    // picTransferState?: number;
    // transferVersion?: number;
  };
}

export interface RenderFileElement {
  type: 'file';
  data: BaseRenderData & {
    fileName: string;
    filePath: string;
    fileSize: number;
    // imgWidth: number;
    // imgHeight: number;
    // fileToken: string;
    // uploadTime: number;
    // picTransferState?: number;
    // transferVersion?: number;
    // transferState?: number;
    // videoToken: string;
  };
}

export interface RenderVideoElement {
  type: 'video';
  data: BaseRenderData & {
    fileName: string;
    fileSize: number;
    // imgWidth: number;
    // imgHeight: number;
    isOriginal: boolean;
    /** CDN download token for the original video (mp4). */
    fileToken: string;
    /** Upload/processing time (unix seconds). */
    uploadTime: number;
    /** Upload timestamp (unix seconds). */
    uploadTimestamp: number;
    /** File TTL in seconds; CDN expiry ≈ uploadTimestamp + fileTTL. */
    fileTTL: number;
    summary: string[];
    videoDuration: number;
    videoWidth: number;
    videoHeight: number;
    coverFileName: string;
    /** CDN download token for the video cover image. */
    videoToken: string;
    /** Absolute CDN expiry (unix seconds) when present (authoritative for video). */
    expireTimestamp: number;
    /** Valid period in seconds from upload, when present. */
    validPeriodSec: number;
    // secondExpireTimestamp: number;
  };
}

export interface RenderPttElement {
  type: 'ptt';
  data: BaseRenderData & {
    fileName: string;
    filePath: string;
    fileSize: number;
    isOriginal: boolean;
    // md5: string;
    /** CDN download token for the voice clip (silk). */
    fileToken: string;
    /** Upload/processing time (unix seconds). */
    uploadTime: number;
    /** Upload timestamp (unix seconds). */
    uploadTimestamp: number;
    /** File TTL in seconds; CDN expiry ≈ uploadTimestamp + fileTTL. */
    fileTTL: number;
    summary: string[];
    pttType: number;
    voiceChanged: boolean;
    /** Amplitude envelope: one byte (0–255) per 0.1s; length/10 = duration sec. */
    waveform: number[];
    // transferState?: number;
    // picTransferState?: number;
    // transferVersion?: number;
  };
}

export interface RenderFaceElement {
  type: 'face';
  data: BaseRenderData & {
    faceId: number;
    faceText: string;
    faceExtDesc?: string;
    superEmojiCategory?: string;
    AniStickerId?: string;
    superEmojiFlag1?: number;
    superEmojiFlag2?: number;
    diceValue?: string;
    superEmojiFlag3?: number;
    superEmojiFlag4?: number;
    canChain?: boolean;
  };
}

export interface RenderReplyElement {
  type: 'reply';
  data: BaseRenderData & {
    origSenderUid: string;
    // origReceiverUid: string;
    origMsgSeq: number;
    origSenderUin: number;
    origMsgTime: number;
    // origReceiverUin: number;
    origMsgId: bigint;
    origMsgIndex: number;
    /** The quoted message's elements, already mapped to render view ({type,data}). */
    origElements: RenderElement[];
    replyOrigMsgIdRef?: bigint;
    replyTextSummary?: string;
  };
}

export interface RenderGrayTipRevokeElement {
  type: 'grayTipRevoke';
  data: BaseRenderData & {
    recallSenderUid: string;
    recallRevokeUid: string;
    recallSenderNick: string;
    recallDisplayText: string;
    recallRevokeNick: string;
    recallElements?: any[];
  };
}

export interface RenderGrayTipPokeElement {
  type: 'grayTipPoke';
  data: BaseRenderData & {
    actionId: number;
    detailedId: number;
    typeFlag: number;
    grayTipXmlContent: string;
    businessId: number;
    actionUniqueId: number;
    tipJson: string;
    tipType: number;
    actionInitiator?: { uid?: string; nickname?: string };
    actionTarget?: { uid?: string; nickname?: string };
    actionAttributes?: Array<{ key?: string; value?: string }>;
    grayTipReserved?: string;
  };
}

export interface RenderGrayTipGroupElement {
  type: 'grayTipGroup';
  data: BaseRenderData & {
    groupTipType: number;
    user1Uid?: string;
    user1Nick?: string;
    user1GroupNick?: string;
    user2Uid?: string;
    user2Nick?: string;
    user2GroupNick?: string;
    muteInfo?: {
      operator?: { uid?: string };
      mutedUser?: { uid?: string; groupNick?: string };
      timestamp?: bigint;
      duration?: number;
    };
  };
}

export interface RenderGrayTipInviteElement {
  type: 'grayTipInvite';
  data: BaseRenderData & {
    grayTipXmlContent?: string;
    tipJson?: string;
  };
}

export interface RenderArkElement {
  type: 'ark';
  data: BaseRenderData & {
    arkData: string;
  };
}

export interface RenderMfaceElement {
  type: 'mface';
  data: BaseRenderData & {
    emojiPackId: number;
    emojiId: string;
    mfaceType: number;
    mfaceSubType: boolean;
    /** Lowercase hex of the preview md5 — the on-disk marketface file name. */
    previewMd5Hex: string;
    mediaType: number;
    // renderFlag: boolean;
    previewWidth: number;
    previewHeight: number;
    isAnimated: boolean;
  };
}

export interface RenderMarkdownElement {
  type: 'markdown';
  data: BaseRenderData & {
    markdownContent: string;
    markdownMeta: any;
    // markdownFlag48703: any;
    markdownTextSummary: string;
    /**
     * QQ 闪传 (flash-transfer) info (proto tag 48708). Present only on flash
     * transfer cards; when set, the renderer draws the markdown as a flash
     * transfer file card instead of plain markdown. Shape: { fileSetId,
     * thumbnailName, fileBytes, thumbAlt, createTime }.
     */
    flashTransferInfo?: any;
  };
}

export interface RenderMultiMsgElement {
  type: 'multiMsg';
  data: BaseRenderData & {
    resId: string;
    xmlContent: string;
    sessionId: string;
  };
}

export interface RenderCallElement {
  type: 'call';
  data: BaseRenderData & {
    answerType: number;
    duration: number;
    callMethod: number;
    callSummary: string[];
  };
}

export interface RenderWalletElement {
  type: 'wallet';
  data: BaseRenderData & {
    walletTargetUin?: number;
    walletDetail?: any;
    walletOrderId?: string;
    walletRedbagType?: number;
    walletExt?: any;
  };
}

export interface RenderOnlineFileElement {
  type: 'onlineFile';
  data: BaseRenderData & {
    fileName: string;
    filePath: string;
    fileSize: number;
    imgWidth: number;
    imgHeight: number;
    fileToken: string;
  };
}

export interface RenderOnlineFolderElement {
  type: 'onlineFolder';
  data: BaseRenderData & {
    fileName: string;
    filePath: string;
    fileSize: number;
    fileToken: string;
  };
}

export interface RenderEmojiBounceElement {
  type: 'emojiBounce';
  data: BaseRenderData & {
    emojiBounceId: number;
    emojiBounceName: string;
    emojiBounceDetail: {
      flag52142?: number;
      name?: string;
      textSummary?: string;
    };
    emojiBounceTextSummary: string;
    emojiBouncePcText: string;
  };
}

export interface RenderQqDynamicElement {
  type: 'qqDynamic';
  data: BaseRenderData & {
    dynamicType: number;
    dynamicId: string;
    dynamicDesc: {
      mainDesc?: string;
      subDesc?: string;
    };
    dynamicDesc2: {
      mainDesc?: string;
      subDesc?: string;
    };
    dynamicCoverUrl: string;
    dynamicZoneLogoUrl: string;
    dynamicPublisherUin: number;
    dynamicMeta: string;
    dynamicTags?: Array<{
      flag48191?: boolean;
      tagId?: number;
      tagContent?: string;
    }>;
  };
}

export interface RenderUnknownElement {
  type: 'unknown';
  data: BaseRenderData & {
    elementType: number;
  };
}

export type RenderElement =
  | RenderTextElement
  | RenderAtElement
  | RenderPicElement
  | RenderFileElement
  | RenderVideoElement
  | RenderPttElement
  | RenderFaceElement
  | RenderReplyElement
  | RenderGrayTipRevokeElement
  | RenderGrayTipPokeElement
  | RenderGrayTipGroupElement
  | RenderGrayTipInviteElement
  | RenderArkElement
  | RenderMfaceElement
  | RenderMarkdownElement
  | RenderMultiMsgElement
  | RenderCallElement
  | RenderWalletElement
  | RenderOnlineFileElement
  | RenderOnlineFolderElement
  | RenderEmojiBounceElement
  | RenderQqDynamicElement
  | RenderUnknownElement;

/** Lowercase hex of a byte array (empty string when absent). */
function toHex(bytes: Uint8Array | undefined): string {
  if (!bytes || bytes.length === 0) return '';
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function toRenderElements(elements: Element[]): RenderElement[] {
  return elements.map((el) => {
    switch (el.kind) {
      case 'text': return mapText(el as TextElement);
      case 'at': return mapAt(el as AtElement);
      case 'pic': return mapPic(el as PicElement);
      case 'file': return mapFile(el as FileElement);
      case 'video': return mapVideo(el as VideoElement);
      case 'ptt': return mapPtt(el as PttElement);
      case 'face': return mapFace(el as FaceElement);
      case 'reply': return mapReply(el as ReplyElement);
      case 'grayTipRevoke': return mapGrayTipRevoke(el as GrayTipRevokeElement);
      case 'grayTipPoke': return mapGrayTipPoke(el as GrayTipPokeElement);
      case 'grayTipGroup': return mapGrayTipGroup(el as GrayTipGroupElement);
      case 'grayTipInvite': return mapGrayTipInvite(el as GrayTipInviteElement);
      case 'ark': return mapArk(el as ArkElement);
      case 'mface': return mapMface(el as MfaceElement);
      case 'markdown': return mapMarkdown(el as MarkdownElement);
      case 'multiMsg': return mapMultiMsg(el as MultiMsgElement);
      case 'call': return mapCall(el as CallElement);
      case 'wallet': return mapWallet(el as WalletElement);
      case 'onlineFile': return mapOnlineFile(el as OnlineFileElement);
      case 'onlineFolder': return mapOnlineFolder(el as OnlineFolderElement);
      case 'emojiBounce': return mapEmojiBounce(el as EmojiBounceElement);
      case 'qqDynamic': return mapQqDynamic(el as QqDynamicElement);
      case 'unknown': return mapUnknown(el as UnknownElement);
      default:
        const { kind, ...rest } = el as any;
        return { type: kind, data: rest } as any;
    }
  });
}

function mapText(el: TextElement): RenderTextElement {
  return {
    type: 'text',
    data: {
      textContent: el.textContent,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapAt(el: AtElement): RenderAtElement {
  return {
    type: 'at',
    data: {
      textContent: el.textContent,
      buddleId: el.bubbleId,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapPic(el: PicElement): RenderPicElement {
  return {
    type: 'pic',
    data: {
      fileName: el.fileName,
      fileSize: el.fileSize,
      imgWidth: el.imgWidth,
      imgHeight: el.imgHeight,
      imgType: el.imgType,
      isOriginal: el.isOriginal,
      // md5: el.md5,
      fileToken: el.fileToken,
      uploadTime: el.uploadTime,
      uploadTimestamp: el.uploadTimestamp,
      fileTTL: el.fileTTL,
      // thumbnailUrl: el.thumbnailUrl,
      // previewUrl: el.previewUrl,
      originalUrl: el.originalUrl,
      summary: el.summary,
      // cdnHost: el.cdnHost,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
      filePath: el.filePath,
      // picTransferState: el.picTransferState,
      // transferVersion: el.transferVersion,
    },
  };
}

function mapFile(el: FileElement): RenderFileElement {
  return {
    type: 'file',
    data: {
      fileName: el.fileName,
      filePath: el.filePath,
      fileSize: el.fileSize,
      // imgWidth: el.imgWidth,
      // imgHeight: el.imgHeight,
      // fileToken: el.fileToken,
      // uploadTime: el.uploadTime,
      // picTransferState: el.picTransferState,
      // transferVersion: el.transferVersion,
      // transferState: el.transferState,
      // videoToken: el.videoToken,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapVideo(el: VideoElement): RenderVideoElement {
  return {
    type: 'video',
    data: {
      fileName: el.fileName,
      fileSize: el.fileSize,
      // imgWidth: el.imgWidth,
      // imgHeight: el.imgHeight,
      isOriginal: el.isOriginal,
      fileToken: el.fileToken,
      uploadTime: el.uploadTime,
      uploadTimestamp: el.uploadTimestamp,
      fileTTL: el.fileTTL,
      summary: el.summary,
      videoDuration: el.videoDuration,
      videoWidth: el.videoWidth,
      videoHeight: el.videoHeight,
      coverFileName: el.coverFileName,
      videoToken: el.videoToken,
      expireTimestamp: el.expireTimestamp,
      validPeriodSec: el.validPeriodSec,
      // secondExpireTimestamp: el.secondExpireTimestamp,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapPtt(el: PttElement): RenderPttElement {
  return {
    type: 'ptt',
    data: {
      fileName: el.fileName,
      filePath: el.filePath,
      fileSize: el.fileSize,
      isOriginal: el.isOriginal,
      // md5: el.md5,
      fileToken: el.fileToken,
      uploadTime: el.uploadTime,
      uploadTimestamp: el.uploadTimestamp,
      fileTTL: el.fileTTL,
      summary: el.summary,
      pttType: el.pttType,
      voiceChanged: el.voiceChanged,
      waveform: Array.from(el.waveform),
      // transferState: el.transferState,
      // picTransferState: el.picTransferState,
      // transferVersion: el.transferVersion,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapFace(el: FaceElement): RenderFaceElement {
  return {
    type: 'face',
    data: {
      faceId: el.faceId,
      faceText: el.faceText,
      faceExtDesc: el.faceExtDesc,
      superEmojiCategory: el.superEmojiCategory,
      AniStickerId: el.AniStickerId,
      // superEmojiFlag1: el.superEmojiFlag1,
      // superEmojiFlag2: el.superEmojiFlag2,
      diceValue: el.diceValue,
      // superEmojiFlag3: el.superEmojiFlag3,
      // superEmojiFlag4: el.superEmojiFlag4,
      canChain: el.canChain,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapReply(el: ReplyElement): RenderReplyElement {
  return {
    type: 'reply',
    data: {
      origSenderUid: el.origSenderUid,
      // origReceiverUid: el.origReceiverUid,
      origMsgSeq: el.origMsgSeq,
      origSenderUin: el.origSenderUin,
      origMsgTime: el.origMsgTime,
      // origReceiverUin: el.origReceiverUin,
      origMsgId: el.origMsgId,
      origMsgIndex: el.origMsgIndex,
      // origElements arrive as raw ElementWire (no kind/type); decode then map
      // to the same render view ({type,data}) the main elements use so the
      // front-end reply quote can render them with the shared element renderer.
      origElements: toRenderElements((el.origElements ?? []).map((w) => decodeElement(w as never))),
      // replyOrigMsgIdRef: el.replyOrigMsgIdRef,
      // replyTextSummary: el.replyTextSummary,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapGrayTipRevoke(el: GrayTipRevokeElement): RenderGrayTipRevokeElement {
  return {
    type: 'grayTipRevoke',
    data: {
      recallSenderUid: el.recallSenderUid,
      recallRevokeUid: el.recallRevokeUid,
      recallSenderNick: el.recallSenderNick,
      recallDisplayText: el.recallDisplayText,
      recallRevokeNick: el.recallRevokeNick,
      recallElements: el.recallElements,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapGrayTipPoke(el: GrayTipPokeElement): RenderGrayTipPokeElement {
  return {
    type: 'grayTipPoke',
    data: {
      actionId: el.actionId,
      detailedId: el.detailedId,
      typeFlag: el.typeFlag,
      grayTipXmlContent: el.grayTipXmlContent,
      businessId: el.businessId,
      actionUniqueId: el.actionUniqueId,
      tipJson: el.tipJson,
      tipType: el.tipType,
      actionInitiator: el.actionInitiator,
      actionTarget: el.actionTarget,
      actionAttributes: el.actionAttributes,
      grayTipReserved: el.grayTipReserved,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapGrayTipGroup(el: GrayTipGroupElement): RenderGrayTipGroupElement {
  return {
    type: 'grayTipGroup',
    data: {
      groupTipType: el.groupTipType,
      user1Uid: el.user1Uid,
      user1Nick: el.user1Nick,
      user1GroupNick: el.user1GroupNick,
      user2Uid: el.user2Uid,
      user2Nick: el.user2Nick,
      user2GroupNick: el.user2GroupNick,
      muteInfo: el.muteInfo,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapGrayTipInvite(el: GrayTipInviteElement): RenderGrayTipInviteElement {
  return {
    type: 'grayTipInvite',
    data: {
      grayTipXmlContent: el.grayTipXmlContent,
      tipJson: el.tipJson,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapArk(el: ArkElement): RenderArkElement {
  return {
    type: 'ark',
    data: {
      arkData: el.arkData,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapMface(el: MfaceElement): RenderMfaceElement {
  return {
    type: 'mface',
    data: {
      emojiPackId: el.emojiPackId,
      emojiId: el.emojiId,
      mfaceType: el.mfaceType,
      mfaceSubType: el.mfaceSubType,
      previewMd5Hex: toHex(el.previewMd5),
      mediaType: el.mediaType,
      // renderFlag: el.renderFlag,
      previewWidth: el.previewWidth,
      previewHeight: el.previewHeight,
      isAnimated: el.isAnimated,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapMarkdown(el: MarkdownElement): RenderMarkdownElement {
  return {
    type: 'markdown',
    data: {
      markdownContent: el.markdownContent,
      markdownMeta: el.markdownMeta,
      // markdownFlag48703: el.markdownFlag48703,
      markdownTextSummary: el.markdownTextSummary,
      flashTransferInfo: el.flashTransferInfo,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapMultiMsg(el: MultiMsgElement): RenderMultiMsgElement {
  return {
    type: 'multiMsg',
    data: {
      resId: el.resId,
      xmlContent: el.xmlContent,
      sessionId: el.sessionId,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapCall(el: CallElement): RenderCallElement {
  return {
    type: 'call',
    data: {
      answerType: el.answerType,
      duration: el.duration,
      callMethod: el.callMethod,
      callSummary: el.callSummary,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapWallet(el: WalletElement): RenderWalletElement {
  return {
    type: 'wallet',
    data: {
      walletTargetUin: el.walletTargetUin,
      walletDetail: el.walletDetail,
      walletOrderId: el.walletOrderId,
      walletRedbagType: el.walletRedbagType,
      walletExt: el.walletExt,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapOnlineFile(el: OnlineFileElement): RenderOnlineFileElement {
  return {
    type: 'onlineFile',
    data: {
      fileName: el.fileName,
      filePath: el.filePath,
      fileSize: el.fileSize,
      imgWidth: el.imgWidth,
      imgHeight: el.imgHeight,
      fileToken: el.fileToken,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapOnlineFolder(el: OnlineFolderElement): RenderOnlineFolderElement {
  return {
    type: 'onlineFolder',
    data: {
      fileName: el.fileName,
      filePath: el.filePath,
      fileSize: el.fileSize,
      fileToken: el.fileToken,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapEmojiBounce(el: EmojiBounceElement): RenderEmojiBounceElement {
  return {
    type: 'emojiBounce',
    data: {
      emojiBounceId: el.emojiBounceId,
      emojiBounceName: el.emojiBounceName,
      emojiBounceDetail: el.emojiBounceDetail,
      emojiBounceTextSummary: el.emojiBounceTextSummary,
      emojiBouncePcText: el.emojiBouncePcText,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapQqDynamic(el: QqDynamicElement): RenderQqDynamicElement {
  return {
    type: 'qqDynamic',
    data: {
      dynamicType: el.dynamicType,
      dynamicId: el.dynamicId,
      dynamicDesc: el.dynamicDesc,
      dynamicDesc2: el.dynamicDesc2,
      dynamicCoverUrl: el.dynamicCoverUrl,
      dynamicZoneLogoUrl: el.dynamicZoneLogoUrl,
      dynamicPublisherUin: el.dynamicPublisherUin,
      dynamicMeta: el.dynamicMeta,
      dynamicTags: el.dynamicTags,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}

function mapUnknown(el: UnknownElement): RenderUnknownElement {
  return {
    type: 'unknown',
    data: {
      elementType: el.elementType,
      elementId: el.elementId,
      isSender: el.isSender,
      subType: el.subType,
    },
  };
}
