/**
 * 消息体 proto schema（抄自 SnowLuma `packages/proto-defs/src/message.ts` +
 * `element.ts`，转成本仓库 runtime schema 风格）。
 *
 * 覆盖 PushMsgBody 全链路：ResponseHead / ContentHead / MessageBody /
 * RichText / Elem 及其所有子类型。`commonElem.pbElem` 等保留为 bytes，
 * 需要展开时用 `msg/dump.ts` 的原始 tag:value 遍历。
 */

import { message, type ProtoMessage } from '../protobuf';

const f = (name: string, tag: number, type: ProtoMessage['fields'][number]['type'], extra: Partial<{ repeated: boolean }> = {}) => ({ name, tag, type, ...extra });

// ---------- ResponseHead ----------

export const RESPONSE_GRP: ProtoMessage = message([
  f('groupUin', 1, 'uint32'),
  f('memberName', 2, 'string'),
  f('memberCard', 4, 'string'),
  f('groupName', 7, 'string'),
]);

export const RESPONSE_FORWARD: ProtoMessage = message([
  f('tempGroupUin', 5, 'uint32'),
  f('friendName', 6, 'string'),
]);

export const RESPONSE_HEAD: ProtoMessage = message([
  f('fromUin', 1, 'uint32'),
  f('fromUid', 2, 'string'),
  f('type', 3, 'uint32'),
  f('sigMap', 4, 'uint32'),
  f('toUin', 5, 'uint32'),
  f('toUid', 6, 'string'),
  f('forward', 7, RESPONSE_FORWARD),
  f('grp', 8, RESPONSE_GRP),
]);

// ---------- ContentHead ----------

export const CONTENT_HEAD: ProtoMessage = message([
  f('msgType', 1, 'uint32'),
  f('subType', 2, 'uint32'),
  f('c2cCmd', 3, 'uint32'),
  f('msgId', 4, 'uint32'),
  f('sequence', 5, 'uint32'),
  f('timestamp', 6, 'uint32'),
  f('field7', 7, 'uint64'),
  f('ntMsgSeq', 11, 'uint32'),
  f('newId', 12, 'uint64'),
]);

// ---------- RichText 附属 ----------

export const PTT: ProtoMessage = message([
  f('fileType', 1, 'uint32'),
  f('fileId', 2, 'uint64'),
  f('fileUuid', 3, 'bytes'),
  f('fileMd5', 4, 'bytes'),
  f('fileName', 5, 'string'),
  f('fileSize', 6, 'uint32'),
  f('groupFileKey', 10, 'string'),
  f('fileKey', 14, 'bytes'),
  f('time', 19, 'uint32'),
  f('format', 29, 'uint32'),
]);

export const NOT_ONLINE_FILE: ProtoMessage = message([
  f('fileType', 1, 'uint32'),
  f('fileUuid', 3, 'string'),
  f('fileMd5', 4, 'bytes'),
  f('fileName', 5, 'string'),
  f('fileSize', 6, 'uint64'),
  f('subcmd', 9, 'uint32'),
  f('dangerEvel', 50, 'uint32'),
  f('expireTime', 55, 'uint32'),
  f('fileHash', 57, 'string'),
]);

// ---------- Elem 子类型 ----------

export const CUSTOM_FACE_PB_RESERVE: ProtoMessage = message([
  f('subType', 1, 'int32'),
  f('summary', 9, 'string'),
]);

export const NOT_ONLINE_IMAGE_PB_RESERVE2: ProtoMessage = message([
  f('field1', 1, 'int32'),
  f('field2', 2, 'string'),
  f('field3', 3, 'int32'),
  f('field4', 4, 'int32'),
  f('field5', 5, 'int32'),
  f('field7', 7, 'string'),
]);

export const NOT_ONLINE_IMAGE_PB_RESERVE: ProtoMessage = message([
  f('subType', 1, 'int32'),
  f('field3', 3, 'int32'),
  f('field4', 4, 'int32'),
  f('summary', 8, 'string'),
  f('field10', 10, 'int32'),
  f('field20', 20, NOT_ONLINE_IMAGE_PB_RESERVE2),
  f('url', 30, 'string'),
  f('md5Str', 31, 'string'),
]);

export const TEXT_ELEM: ProtoMessage = message([
  f('str', 1, 'string'),
  f('link', 2, 'string'),
  f('attr6Buf', 3, 'bytes'),
  f('attr7Buf', 4, 'bytes'),
  f('buf', 11, 'bytes'),
  f('pbReserve', 12, 'bytes'),
]);

/**
 * TEXT_ELEM.pbReserve（tag 12）——@ 消息的内部负载：
 * field 9 是被 @ 目标的 uid（其余字段仅为占位 / 发信人信息，未验证语义）。
 */
export const TEXT_PB_RESERVE: ProtoMessage = message([
  f('subType', 3, 'uint32'),
  f('fromUin', 4, 'uint32'),
  f('field5', 5, 'uint32'),
  f('atTargetUid', 9, 'string'),
  f('field11', 11, 'uint32'),
]);

/**
 * 老 wire 直出的 Elem.face（im_msg_body.proto message Face，Elem tag 2）：
 * tag 1=index（经典表情的真实 faceId）、2=old（老版兼容数据，实测 2 字节）、
 * 11=buf；其余字段一律丢弃（decode 会自动跳过未声明 tag）。
 */
export const FACE_OLD_PB: ProtoMessage = message([
  f('index', 1, 'int32'),
  f('old', 2, 'bytes'),
  f('buf', 11, 'bytes'),
]);
/**
 * 骰子/超级表情（commonElem serviceType=37）的 pbElem —— 按实测解析：
 * tag 2=aniStickerId、3=faceId、4=超级表情标识（1 为超级表情）、
 * 6=diceValue、7=faceText；其余字段一律丢弃（decode 会自动跳过未声明 tag）。
 */
/**
 * 普通 QQ 表情（commonElem serviceType=33）的 pbElem：
 * tag 1=faceId、2=faceText；其余字段一律丢弃。
 */
export const FACE_COMMON_PB: ProtoMessage = message([
  f('faceId', 1, 'int32'),
  f('faceText', 2, 'string'),
]);
export const FACE_ELEM: ProtoMessage = message([
  f('AniStickerId', 2, 'string'),
  f('faceId', 3, 'int32'),
  f('superEmojiFlag1', 4, 'int32'),
  f('diceValue', 6, 'string'),
  f('faceText', 7, 'string'),
]);

export const ONLINE_IMAGE: ProtoMessage = message([
  f('guid', 1, 'bytes'),
  f('filePath', 2, 'bytes'),
  f('oldVerSendFile', 3, 'bytes'),
]);

export const NOT_ONLINE_IMAGE: ProtoMessage = message([
  f('filePath', 1, 'string'),
  f('fileLen', 2, 'uint32'),
  f('downloadPath', 3, 'string'),
  f('oldVerSendFile', 4, 'bytes'),
  f('imgType', 5, 'int32'),
  f('previewsImage', 6, 'bytes'),
  f('picMd5', 7, 'bytes'),
  f('picHeight', 8, 'uint32'),
  f('picWidth', 9, 'uint32'),
  f('resId', 10, 'string'),
  f('flag', 11, 'bytes'),
  f('thumbUrl', 12, 'string'),
  f('original', 13, 'int32'),
  f('bigUrl', 14, 'string'),
  f('origUrl', 15, 'string'),
  f('bizType', 16, 'int32'),
  f('result', 17, 'int32'),
  f('index', 18, 'int32'),
  f('opFaceBuf', 19, 'bytes'),
  f('oldPicMd5', 20, 'bool'),
  f('thumbWidth', 21, 'int32'),
  f('thumbHeight', 22, 'int32'),
  f('fileId', 23, 'int32'),
  f('showLen', 24, 'uint32'),
  f('downloadLen', 25, 'uint32'),
  f('x400Url', 26, 'string'),
  f('x400Width', 27, 'int32'),
  f('x400Height', 28, 'int32'),
  f('pbRes', 29, NOT_ONLINE_IMAGE_PB_RESERVE),
]);

export const TRANS_ELEM: ProtoMessage = message([
  f('elemType', 1, 'int32'),
  f('elemValue', 2, 'bytes'),
]);

/**
 * MARKET_FACE —— 商城表情（mface），只保留 codec 需要的 5 个字段：
 * tag 4=marketEmoticonId（原 faceId）、5=emojiPackId（原 tabId）、
 * 7=encryptKey（原 key）、10=previewWidth（原 imageWidth）、
 * 11=previewHeight（原 imageHeight）；其余字段一律丢弃。
 */
export const MARKET_FACE: ProtoMessage = message([
  f('marketEmoticonId', 4, 'bytes'),
  f('emojiPackId', 5, 'uint32'),
  f('encryptKey', 7, 'string'),
  f('previewWidth', 10, 'uint32'),
  f('previewHeight', 11, 'uint32'),
]);

export const CUSTOM_FACE: ProtoMessage = message([
  f('guid', 1, 'bytes'),
  f('filePath', 2, 'string'),
  f('shortcut', 3, 'string'),
  f('buffer', 4, 'bytes'),
  f('flag', 5, 'bytes'),
  f('oldData', 6, 'bytes'),
  f('fileId', 7, 'uint32'),
  f('serverIp', 8, 'int32'),
  f('serverPort', 9, 'int32'),
  f('fileType', 10, 'int32'),
  f('signature', 11, 'bytes'),
  f('useful', 12, 'int32'),
  f('md5', 13, 'bytes'),
  f('thumbUrl', 14, 'string'),
  f('bigUrl', 15, 'string'),
  f('origUrl', 16, 'string'),
  f('bizType', 17, 'int32'),
  f('repeatIndex', 18, 'int32'),
  f('repeatImage', 19, 'int32'),
  f('imageType', 20, 'int32'),
  f('index', 21, 'int32'),
  f('width', 22, 'int32'),
  f('height', 23, 'int32'),
  f('source', 24, 'int32'),
  f('size', 25, 'uint32'),
  f('origin', 26, 'int32'),
  f('thumbWidth', 27, 'int32'),
  f('thumbHeight', 28, 'int32'),
  f('showLen', 29, 'int32'),
  f('downloadLen', 30, 'int32'),
  f('x400Url', 31, 'string'),
  f('x400Width', 32, 'int32'),
  f('x400Height', 33, 'int32'),
  f('pbRes', 34, CUSTOM_FACE_PB_RESERVE),
]);

export const RICH_MSG: ProtoMessage = message([
  f('template1', 1, 'bytes'),
  f('serviceId', 2, 'int32'),
  f('msgResId', 3, 'bytes'),
  f('rand', 4, 'int32'),
  f('seq', 5, 'uint32'),
]);

export const GROUP_FILE_ELEM: ProtoMessage = message([
  f('filename', 1, 'string'),
  f('fileSize', 2, 'uint64'),
  f('fileId', 3, 'string'),
  f('batchId', 4, 'string'),
  f('fileKey', 5, 'string'),
  f('mark', 6, 'bytes'),
  f('sequence', 7, 'uint64'),
  f('batchItemId', 8, 'bytes'),
  f('feedMsgTime', 9, 'int32'),
  f('pbReserve', 10, 'bytes'),
]);

export const EXTRA_INFO: ProtoMessage = message([
  f('nick', 1, 'bytes'),
  f('groupCard', 2, 'bytes'),
  f('level', 3, 'int32'),
  f('flags', 4, 'int32'),
  f('groupMask', 5, 'int32'),
  f('msgTailId', 6, 'int32'),
  f('senderTitle', 7, 'bytes'),
  f('apnsTips', 8, 'bytes'),
  f('uin', 9, 'uint64'),
  f('msgStateFlag', 10, 'int32'),
  f('apnsSoundType', 11, 'int32'),
  f('newGroupFlag', 12, 'int32'),
]);

export const VIDEO_FILE: ProtoMessage = message([
  f('fileUuid', 1, 'string'),
  f('fileMd5', 2, 'bytes'),
  f('fileName', 3, 'string'),
  f('fileFormat', 4, 'int32'),
  f('fileTime', 5, 'int32'),
  f('fileSize', 6, 'int32'),
  f('thumbWidth', 7, 'int32'),
  f('thumbHeight', 8, 'int32'),
  f('thumbFileMd5', 9, 'bytes'),
  f('source', 10, 'bytes'),
  f('thumbFileSize', 11, 'int32'),
  f('busiType', 12, 'int32'),
  f('fromChatType', 13, 'int32'),
  f('toChatType', 14, 'int32'),
  f('supportProgressive', 15, 'bool'),
  f('fileWidth', 16, 'int32'),
  f('fileHeight', 17, 'int32'),
  f('subBusiType', 18, 'int32'),
  f('videoAttr', 19, 'int32'),
  f('pbReserve', 24, 'bytes'),
]);

/**
 * REPLY_ELEMENT —— 引用回复（老 wire srcMsg，elem tag 45）：
 * 只保留 codec 需要的字段；origMsgSeq / origMsgIndex 都取 tag 1
 * （群聊=群内 seq，c2c=会话 index）。
 */
export const REPLY_ELEMENT: ProtoMessage = message([
  f('origMsgSeq', 1, 'uint32', { repeated: true }),
  f('origSenderUin', 2, 'uint64'),
  f('origMsgTime', 3, 'int32'),
  f('origElementsRaw', 5, 'bytes', { repeated: true }),
  f('pbReserve', 8, 'bytes'),
]);

/** REPLY_ELEMENT.pbReserve（tag 8）：field 6 = 原消息发送者 uid。 */
export const REPLY_PB_RESERVE: ProtoMessage = message([
  f('origSenderUid', 6, 'string'),
]);

// ---------- elem(tag=24) 钱包 / 红包 ----------

/** 红包皮肤（detail.21）：field 5 是 skinId（部分消息里为空串，按 wire type 自动跳过）。 */
export const WALLET_SKIN: ProtoMessage = message([
  f('skinId', 5, 'uint32'),
]);

/** 红包详情（body.3）：redbagTitle / openPrompt / subTitle / skin。 */
export const WALLET_DETAIL: ProtoMessage = message([
  f('redbagTitle', 3, 'string'),
  f('openPrompt', 4, 'string'),
  f('subTitle', 5, 'string'),
  f('skin', 21, WALLET_SKIN),
]);

/** 红包主体（wallet.1）：detail + walletDesignatedUin（专属红包才有）。 */
export const WALLET_BODY: ProtoMessage = message([
  f('detail', 3, WALLET_DETAIL),
  f('walletDesignatedUin', 20, 'uint64'),
]);

/** elem(tag=24) 顶层。 */
export const WALLET_ELEM: ProtoMessage = message([
  f('body', 1, WALLET_BODY),
]);
export const LIGHT_APP_ELEM: ProtoMessage = message([
  f('data', 1, 'bytes'),
  f('msgResid', 2, 'bytes'),
]);

export const COMMON_ELEM: ProtoMessage = message([
  f('serviceType', 1, 'int32'),
  f('pbElem', 2, 'bytes'),
  f('businessType', 3, 'uint32'),
]);

// ---------- commonElem(serviceType=48) 图片 ----------

/** 图片信息里 imgType 的包裹结构（field 2 才是实际 imgType）。 */
export const PIC_COMMON_IMG_TYPE: ProtoMessage = message([
  f('imgType', 2, 'uint32'),
]);

/** 图片信息（file.body.info）：fileName / imgWidth / imgHeight / imgType。 */
export const PIC_COMMON_INFO: ProtoMessage = message([
  f('fileName', 4, 'string'),
  f('imgType', 5, PIC_COMMON_IMG_TYPE),
  f('imgWidth', 6, 'uint32'),
  f('imgHeight', 7, 'uint32'),
]);

/** file.body：图片信息 + fileToken。 */
export const PIC_COMMON_BODY: ProtoMessage = message([
  f('info', 1, PIC_COMMON_INFO),
  f('fileToken', 2, 'string'),
]);

/** file.url：originalUrl 下载路径。 */
export const PIC_COMMON_URL: ProtoMessage = message([
  f('originalUrl', 1, 'string'),
]);

/** pbElem.1（file）：body + url。 */
export const PIC_COMMON_FILE: ProtoMessage = message([
  f('body', 1, PIC_COMMON_BODY),
  f('url', 2, PIC_COMMON_URL),
]);

/** commonElem(serviceType=48).pbElem 顶层。 */
export const PIC_COMMON_PB: ProtoMessage = message([
  f('file', 1, PIC_COMMON_FILE),
]);

// ---------- commonElem(serviceType=48, businessType=21) 视频 ----------

/** 视频信息（file.body.info）：fileName / videoWidth / videoHeight / videoDuration。 */
export const VIDEO_COMMON_INFO: ProtoMessage = message([
  f('fileName', 4, 'string'),
  f('videoWidth', 6, 'uint32'),
  f('videoHeight', 7, 'uint32'),
  f('videoDuration', 8, 'uint32'),
]);

/** file.body：视频信息 + fileToken。 */
export const VIDEO_COMMON_BODY: ProtoMessage = message([
  f('info', 1, VIDEO_COMMON_INFO),
  f('fileToken', 2, 'string'),
]);

/** pbElem.1 数组里的一项（第 0 项=视频本体，第 1 项=封面缩略图）。 */
export const VIDEO_COMMON_FILE: ProtoMessage = message([
  f('body', 1, VIDEO_COMMON_BODY),
]);

/** commonElem(serviceType=48, businessType=21).pbElem 顶层。 */
export const VIDEO_COMMON_PB: ProtoMessage = message([
  f('files', 1, VIDEO_COMMON_FILE, { repeated: true }),
]);

// ---------- transElem(elemType=24) 群文件 ----------

/** 文件信息（7.2）：fileToken / fileSize / fileName，其余字段丢弃。 */
export const FILE_TRANS_INFO: ProtoMessage = message([
  f('field1', 1, 'uint32'),
  f('fileToken', 2, 'string'),
  f('fileSize', 3, 'uint32'),
  f('fileName', 4, 'string'),
  f('field5', 5, 'uint32'),
  f('field7', 7, 'string'),
  f('field8', 8, 'string'),
  f('field9', 9, 'bytes'),
]);

/** 7 的包裹：field 2 才是文件信息。 */
export const FILE_TRANS_ITEM: ProtoMessage = message([
  f('info', 2, FILE_TRANS_INFO),
]);

/** elemValue 跳过 3 字节前缀后的顶层。 */
export const FILE_TRANS_TOP: ProtoMessage = message([
  f('field1', 1, 'uint32'),
  f('field2', 2, 'string'),
  f('field3', 3, 'string'),
  f('file', 7, FILE_TRANS_ITEM),
]);

// ---------- commonElem(serviceType=48, businessType=22) 语音 ----------

/** 语音信息（body.info）：fileName / pttDuration，其余字段丢弃。 */
export const PTT_COMMON_INFO: ProtoMessage = message([
  f('fileName', 4, 'string'),
  f('pttDuration', 8, 'uint32'),
]);

/** body：语音信息 + fileToken。 */
export const PTT_COMMON_BODY: ProtoMessage = message([
  f('info', 1, PTT_COMMON_INFO),
  f('fileToken', 2, 'string'),
]);

/** pbElem.1：body。 */
export const PTT_COMMON_FILE: ProtoMessage = message([
  f('body', 1, PTT_COMMON_BODY),
]);

/** pbElem.2.3.5：waveform 包裹（field 2 = 波形字节）。 */
export const PTT_COMMON_WAVE: ProtoMessage = message([
  f('waveform', 2, 'bytes'),
]);

/** pbElem.2.3：wave 容器。 */
export const PTT_COMMON_META: ProtoMessage = message([
  f('wave', 5, PTT_COMMON_WAVE),
]);

/** pbElem.2：其他信息（只取 waveForm）。 */
export const PTT_COMMON_EXTRA: ProtoMessage = message([
  f('meta', 3, PTT_COMMON_META),
]);

/** commonElem(serviceType=48, businessType=22).pbElem 顶层。 */
export const PTT_COMMON_PB: ProtoMessage = message([
  f('file', 1, PTT_COMMON_FILE),
  f('extra', 2, PTT_COMMON_EXTRA),
]);

// ---------- commonElem(serviceType=45) markdown ----------

/** pbElem.7：闪传信息，只取 fileSetId（filesetid 不是必需，缺省不输出）。 */
export const MARKDOWN_FLASH_INFO: ProtoMessage = message([
  f('fileSetId', 1, 'string'),
]);

/** commonElem(serviceType=45).pbElem 顶层：只保留 markdownContent / markdownTextSummary / fileSetId。 */
export const MARKDOWN_COMMON_PB: ProtoMessage = message([
  f('markdownContent', 1, 'string'),
  f('markdownTextSummary', 5, 'string'),
  f('flashTransferInfo', 7, MARKDOWN_FLASH_INFO),
]);
// ---------- commonElem(serviceType=46) 内联键盘 ----------

export const INLINE_KEYBOARD_ACTION_TYPE: ProtoMessage = message([
  f('actionType', 1, 'uint32'),
]);

/** 按钮 action（button.3）：actionType 在 2.1，action 在 5。 */
export const INLINE_KEYBOARD_ACTION: ProtoMessage = message([
  f('actionType', 2, INLINE_KEYBOARD_ACTION_TYPE),
  f('action', 5, 'string'),
]);

/** 按钮标签（button.2）：label / visitedLabel / style。 */
export const INLINE_KEYBOARD_LABEL: ProtoMessage = message([
  f('label', 1, 'string'),
  f('visitedLabel', 2, 'string'),
  f('style', 3, 'uint32'),
]);

/** 单个按钮：buttonId=1。 */
export const INLINE_KEYBOARD_BUTTON: ProtoMessage = message([
  f('buttonId', 1, 'string'),
  f('labelInfo', 2, INLINE_KEYBOARD_LABEL),
  f('actionInfo', 3, INLINE_KEYBOARD_ACTION),
]);

/** pbElem.1.1：按钮列表。 */
export const INLINE_KEYBOARD_BUTTONS: ProtoMessage = message([
  f('buttons', 1, INLINE_KEYBOARD_BUTTON, { repeated: true }),
]);

/** pbElem.1：按钮 + botAppId。 */
export const INLINE_KEYBOARD_GROUP: ProtoMessage = message([
  f('buttons', 1, INLINE_KEYBOARD_BUTTONS),
  f('keyboardBotAppId', 2, 'uint64'),
]);

/** commonElem(serviceType=46).pbElem 顶层。 */
export const INLINE_KEYBOARD_PB: ProtoMessage = message([
  f('group', 1, INLINE_KEYBOARD_GROUP),
]);
export const FONT_INFO: ProtoMessage = message([
  f('fontId2', 15, 'uint32'),
  f('fontId1', 56, 'uint32'),
]);

export const GENERAL_FLAGS: ProtoMessage = message([
  f('bubbleDiyTextId', 1, 'int32'),
  f('groupFlagNew', 2, 'int32'),
  f('uin', 3, 'uint64'),
  f('longTextFlag', 6, 'int32'),
  f('longTextResId', 7, 'string'),
  f('widgetId', 17, 'uint32'),
  f('font', 19, FONT_INFO),
]);

export const BUBBLE_ELEM: ProtoMessage = message([
  f('id', 1, 'uint32'),
]);

export const ELEM: ProtoMessage = message([
  f('text', 1, TEXT_ELEM),
  f('face', 2, FACE_OLD_PB),
  f('onlineImage', 3, ONLINE_IMAGE),
  f('notOnlineImage', 4, NOT_ONLINE_IMAGE),
  f('transElem', 5, TRANS_ELEM),
  f('marketFace', 6, MARKET_FACE),
  f('customFace', 8, CUSTOM_FACE),
  f('bubble', 9, BUBBLE_ELEM),
  f('richMsg', 12, RICH_MSG),
  f('groupFile', 13, GROUP_FILE_ELEM),
  f('extraInfo', 16, EXTRA_INFO),
  f('videoFile', 19, VIDEO_FILE),
  f('wallet', 24, WALLET_ELEM),
  f('generalFlags', 37, GENERAL_FLAGS),
  f('replyElement', 45, REPLY_ELEMENT),
  f('lightApp', 51, LIGHT_APP_ELEM),
  f('commonElem', 53, COMMON_ELEM),
]);

// ---------- MessageBody / RichText / PushMsgBody ----------

export const RICH_TEXT: ProtoMessage = message([
  f('elems', 2, ELEM, { repeated: true }),
  f('notOnlineFile', 3, NOT_ONLINE_FILE),
  f('ptt', 4, PTT),
]);

export const MESSAGE_BODY: ProtoMessage = message([
  f('richText', 1, RICH_TEXT),
  f('msgContent', 2, 'bytes'),
]);

export const PUSH_MSG_BODY: ProtoMessage = message([
  f('responseHead', 1, RESPONSE_HEAD),
  f('contentHead', 2, CONTENT_HEAD),
  f('body', 3, MESSAGE_BODY),
]);

export const PUSH_MSG: ProtoMessage = message([
  f('message', 1, PUSH_MSG_BODY),
  f('status', 3, 'int32'),
]);
