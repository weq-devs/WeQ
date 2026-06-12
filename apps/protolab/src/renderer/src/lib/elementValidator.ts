import { ElementType } from '@weq/codec/element';
import {
  TextElementSchema,
  PicElementSchema,
  FileElementSchema,
  VideoElementSchema,
  PttElementSchema,
  FaceElementSchema,
  ReplyElementSchema,
  GrayTipElementSchema,
  ArkElementSchema,
  MfaceElementSchema,
  MarkdownElementSchema,
  MultiMsgElementSchema,
  CallElementSchema,
  OnlineFileElementSchema,
  OnlineFolderElementSchema,
  EmojiBounceElementSchema,
  QqDynamicElementSchema,
} from '@weq/codec/element';
import type { AnnotatedField } from '@weq/codec/raw';
import { z } from 'zod';

const ELEMENT_SCHEMAS: Partial<Record<ElementType, any>> = {
  [ElementType.TEXT]: TextElementSchema,
  [ElementType.PIC]: PicElementSchema,
  [ElementType.FILE]: FileElementSchema,
  [ElementType.VIDEO]: VideoElementSchema,
  [ElementType.PTT]: PttElementSchema,
  [ElementType.FACE]: FaceElementSchema,
  [ElementType.REPLY]: ReplyElementSchema,
  [ElementType.GRAY_TIP]: GrayTipElementSchema,
  [ElementType.ARK]: ArkElementSchema,
  [ElementType.MFACE]: MfaceElementSchema,
  [ElementType.MARKDOWN]: MarkdownElementSchema,
  [ElementType.MULTI_MSG]: MultiMsgElementSchema,
  [ElementType.CALL]: CallElementSchema,
  [ElementType.ONLINE_FILE]: OnlineFileElementSchema,
  [ElementType.ONLINE_FOLDER]: OnlineFolderElementSchema,
  [ElementType.EMOJI_BOUNCE]: EmojiBounceElementSchema,
  [ElementType.QQ_DYNAMIC]: QqDynamicElementSchema,
};

export interface ElementValidation {
  elementType: ElementType;
  elementName: string;
  hasSchema: boolean;
  missingRequired: string[];
  unexpectedFields: number[];
}

export function validateElement(fields: AnnotatedField[]): ElementValidation | null {
  const elementTypeField = fields.find(f => f.raw.tag === 45002);
  if (!elementTypeField) return null;

  const guess = elementTypeField.raw.guesses.find(g => g.kind === 'varint-uint64');
  if (!guess || guess.kind !== 'varint-uint64') return null;

  const elementType = Number(guess.value) as ElementType;
  const elementName = ElementType[elementType] || 'UNKNOWN';
  const schema = ELEMENT_SCHEMAS[elementType];

  if (!schema) {
    return {
      elementType,
      elementName,
      hasSchema: false,
      missingRequired: [],
      unexpectedFields: [],
    };
  }

  const presentTags = new Set(fields.map(f => f.raw.tag));
  const schemaShape = schema.shape;

  const requiredFields = Object.entries(schemaShape)
    .filter(([name, fieldSchema]) => {
      if (name === 'kind') return false;
      return !(fieldSchema as any).isOptional?.();
    })
    .map(([name]) => name);

  const missingRequired = requiredFields.filter(name =>
    !presentTags.has(getTagForField(name))
  );

  const expectedTags = new Set([45002, 40010, 45001, 45003]);
  const unexpectedFields = fields
    .map(f => f.raw.tag)
    .filter(tag => !expectedTags.has(tag) && !isExpectedTag(tag, elementType));

  return {
    elementType,
    elementName,
    hasSchema: true,
    missingRequired,
    unexpectedFields,
  };
}

function getTagForField(fieldName: string): number {
  const tagMap: Record<string, number> = {
    textContent: 45101,
    fileName: 45402,
    fileSize: 45405,
    md5Bytes: 45406,
    contentHash: 45408,
    imgWidth: 45411,
    imgHeight: 45412,
    imgType: 45416,
    isOriginal: 45418,
    md5: 45424,
    fileToken: 45503,
    uploadTime: 45505,
    uploadTimestamp: 45517,
    fileTTL: 45518,
    thumbnailUrl: 45802,
    previewUrl: 45803,
    originalUrl: 45804,
    summary: 45815,
    cdnHost: 45816,
    filePath: 45403,
    pttType: 45906,
    voiceChanged: 45911,
    waveform: 45925,
    faceId: 47601,
    faceText: 47602,
    arkData: 47901,
    resId: 48601,
    xmlContent: 48602,
    sessionId: 48603,
    emojiPackId: 80810,
    emojiId: 80824,
    mfaceFlag80900: 80900,
    mfaceType: 80901,
    mfaceSubType: 80902,
    previewMd5: 80903,
    mediaType: 80905,
    renderFlag: 80908,
    previewWidth: 80909,
    previewHeight: 80910,
    isAnimated: 80935,
    answerType: 48151,
    duration: 48152,
    callMethod: 48154,
    callSummary: 48157,
    actionId: 48211,
    detailedId: 48212,
    typeFlag: 48213,
    grayTipXmlContent: 48214,
    businessId: 48215,
    actionUniqueId: 48216,
    tipJson: 48271,
    tipType: 48273,
    subType: 45003,
    md5Bytes2: 45407,
    fileFlag45415: 45415,
    transferFlag45504: 45504,
    picTransferState: 45511,
    transferVersion: 45513,
    transferState: 45550,
    fileFlag45409: 45409,
    fileFlag45501: 45501,
    videoToken: 45510,
    fileFlag45512: 45512,
    fileFlag45514: 45514,
    videoDuration: 45410,
    videoWidth: 45413,
    videoHeight: 45414,
    videoFlag45421: 45421,
    coverFileName: 45422,
    videoFlag45423: 45423,
    expireTimestamp: 45515,
    validPeriodSec: 45516,
    secondExpireTimestamp: 45519,
    channelParams: 45862,
    videoFlag45863: 45863,
    origSenderUid: 40020,
    origReceiverUid: 40021,
    origMsgSeq: 47402,
    origSenderUin: 47403,
    origMsgTime: 47404,
    origReceiverUin: 47411,
    origMsgId: 47416,
    origMsgIndex: 47419,
    replyFlag47422: 47422,
    origElements: 47423,
    markdownContent: 48701,
    markdownMeta: 48702,
    markdownFlag48703: 48703,
    markdownFlag48704: 48704,
    markdownTextSummary: 48705,
    markdownFlag48706: 48706,
    emojiBounceId: 52132,
    emojiBounceFlag52133: 52133,
    emojiBounceName: 52134,
    emojiBounceDetail: 52137,
    emojiBounceTextSummary: 52138,
    emojiBouncePcText: 52139,
    dynamicType: 48172,
    dynamicId: 48173,
    dynamicFlag48174: 48174,
    dynamicDesc: 48175,
    dynamicDesc2: 48176,
    dynamicCoverUrl: 48180,
    dynamicZoneLogoUrl: 48181,
    dynamicPublisherUin: 48182,
    dynamicMeta: 48183,
  };
  return tagMap[fieldName] || 0;
}

function isExpectedTag(tag: number, elementType: ElementType): boolean {
  const ranges: Record<ElementType, number[][]> = {
    [ElementType.TEXT]: [[45101, 45112]],
    [ElementType.PIC]: [[45402, 45828], [45600, 45600]],
    [ElementType.FILE]: [[45402, 45550]],
    [ElementType.VIDEO]: [[45402, 45863]],
    [ElementType.PTT]: [[45402, 45925]],
    [ElementType.FACE]: [[45004, 45004], [47601, 47622]],
    [ElementType.REPLY]: [[40020, 40021], [47401, 47423]],
    [ElementType.GRAY_TIP]: [[43210, 43210], [48210, 48275]],
    [ElementType.ARK]: [[47901, 47901]],
    [ElementType.MFACE]: [[80810, 80995]],
    [ElementType.MARKDOWN]: [[48701, 48711]],
    [ElementType.MULTI_MSG]: [[48601, 48603]],
    [ElementType.CALL]: [[48151, 48157]],
    [ElementType.ONLINE_FILE]: [[45402, 45504]],
    [ElementType.ONLINE_FOLDER]: [[45402, 45504]],
    [ElementType.EMOJI_BOUNCE]: [[52132, 52139]],
    [ElementType.QQ_DYNAMIC]: [[48172, 48193]],
  };

  const elementRanges = ranges[elementType] || [];
  return elementRanges.some((range) => range && range[0] !== undefined && range[1] !== undefined && tag >= range[0] && tag <= range[1]);
}
