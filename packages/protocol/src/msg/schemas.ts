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

export const FACE_ELEM: ProtoMessage = message([
  f('index', 1, 'int32'),
  f('oldData', 2, 'bytes'),
  f('buf', 11, 'bytes'),
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

export const MARKET_FACE: ProtoMessage = message([
  f('faceName', 1, 'string'),
  f('itemType', 2, 'uint32'),
  f('faceInfo', 3, 'uint32'),
  f('faceId', 4, 'bytes'),
  f('tabId', 5, 'uint32'),
  f('subType', 6, 'uint32'),
  f('key', 7, 'string'),
  f('param', 8, 'bytes'),
  f('mediaType', 9, 'uint32'),
  f('imageWidth', 10, 'uint32'),
  f('imageHeight', 11, 'uint32'),
  f('mobileParam', 12, 'bytes'),
  f('pbReserve', 13, 'bytes'),
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

export const SRC_MSG: ProtoMessage = message([
  f('origSeqs', 1, 'uint32', { repeated: true }),
  f('senderUin', 2, 'uint64'),
  f('time', 3, 'int32'),
  f('flag', 4, 'int32'),
  f('elemsRaw', 5, 'bytes', { repeated: true }),
  f('type', 6, 'int32'),
  f('richMsg', 7, 'bytes'),
  f('pbReserve', 8, 'bytes'),
  f('sourceMsg', 9, 'bytes'),
  f('toUin', 10, 'uint64'),
  f('troopName', 11, 'bytes'),
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
  f('face', 2, FACE_ELEM),
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
  f('generalFlags', 37, GENERAL_FLAGS),
  f('srcMsg', 45, SRC_MSG),
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
