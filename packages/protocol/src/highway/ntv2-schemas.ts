/**
 * NTV2 富媒体**上传**方向的 proto schema（下载方向在 `../oidb/media-schemas`）。
 *
 * 三组结构：
 *   1. 0xE37_100（`OidbSvcTrpcTcp.0x11c4_100` / `0x11c5_100` / `0x11ea_100` …）的
 *      上传请求 `upload` 段 + 响应 `upload` 段（uKey / ipv4s / msgInfo / subFileInfos）。
 *   2. highway TCP 的帧头：`ReqDataHighwayHead` / `RespDataHighwayHead`（含 SegHead），
 *      以及载荷 `NTV2RichMediaHighwayExt`。
 *   3. `HttpConn.0x6ff_501` 会话请求/响应（拿 sig_session + 上传节点 ip/port）。
 *
 * 字段布局抄自 SnowLuma `packages/proto-defs/src/highway.ts`，
 * 复用的 NTV2 基础块直接引 `../oidb/media-schemas`（同一 tag 布局，不要在两边各写一份）。
 *
 * 唯一注意点：发出去的消息里 `commonElem.pbElem` 就是响应里的 `msgInfo` 字节（本文件的
 * `UPLOAD_MSG_INFO`）—— 收侧解码的 `PIC_COMMON_PB`/`PTT_COMMON_PB`/`VIDEO_COMMON_PB`
 * 与它同构，所以这就是「上传产物 = 消息体」的那份共享结构。
 */

import { message, type ProtoMessage } from '../protobuf';
import {
  NTV2_CLIENT_META,
  NTV2_COMMON_HEAD,
  NTV2_C2C_USER_INFO,
  NTV2_FILE_INFO,
  NTV2_GROUP_INFO,
  NTV2_INDEX_NODE,
  NTV2_REQ_HEAD,
  NTV2_RESP_HEAD,
} from '../oidb/media-schemas';

const f = (
  name: string,
  tag: number,
  type: ProtoMessage['fields'][number]['type'],
  extra: Partial<{ repeated: boolean; force: boolean }> = {},
) => ({ name, tag, type, ...extra });

// ───────────────────── 上传请求（0xE37_100 的 upload 段） ─────────────────────

/**
 * `extBizInfo.pic` 的群聊 reserve（tag 12，NapCat `BytesPbReserveTroop`）。
 *
 * 发图片时**必须带 `{ subType }`**：服务端按它把文件归到对应子类型的存储桶里。
 * 漏了不会报错，但收端会显示「图片已过期」（真机踩过）。
 */
export const PIC_RESERVE_TROOP = message([
  f('subType', 1, 'uint32'),
  f('field3', 3, 'uint32'),
  f('field4', 4, 'uint32'),
  f('field9', 9, 'string'),
  f('field10', 10, 'uint32'),
  f('field12', 12, 'string'),
  f('field18', 18, 'string'),
  f('field19', 19, 'string'),
  f('field21', 21, 'bytes'),
]);

/** 私聊 reserve（tag 11，NapCat `BytesPbReserveC2c`）—— 字段集与群聊版略不同。 */
export const PIC_RESERVE_C2C = message([
  f('subType', 1, 'uint32'),
  f('field3', 3, 'uint32'),
  f('field4', 4, 'uint32'),
  f('field8', 8, 'string'),
  f('field10', 10, 'uint32'),
  f('field12', 12, 'string'),
  f('field18', 18, 'string'),
  f('field19', 19, 'string'),
  f('field20', 20, 'bytes'),
]);

/** `extBizInfo.pic` 里的扩展数据（旧版兼容渲染用；等价于群聊 reserve 的前两个 tag）。 */
export const PIC_EXT_DATA = PIC_RESERVE_TROOP;

export const PIC_URL_EXT_INFO = message([
  f('originalParameter', 1, 'string'),
  f('bigParameter', 2, 'string'),
  f('thumbParameter', 3, 'string'),
]);

export const PICTURE_INFO = message([
  f('urlPath', 1, 'string'),
  f('ext', 2, PIC_URL_EXT_INFO),
  f('domain', 3, 'string'),
]);

export const PIC_EXT_BIZ_INFO = message([
  f('bizType', 1, 'uint32'),
  f('textSummary', 2, 'string'),
  f('bytesPbReserveC2c', 11, PIC_RESERVE_C2C),
  f('bytesPbReserveTroop', 12, PIC_RESERVE_TROOP),
  f('fromScene', 1001, 'uint32'),
  f('toScene', 1002, 'uint32'),
  f('oldFileId', 1003, 'uint32'),
]);

/** 视频的 extBizInfo：`bytesPbReserve` 转发/来源场景标记，必须原样带上。 */
export const VIDEO_EXT_BIZ_INFO = message([
  f('fromScene', 1, 'uint32'),
  f('toScene', 2, 'uint32'),
  f('bytesPbReserve', 3, 'bytes'),
]);

/** 语音波形：`size` 必须等于 `amplitudes` 字节数（收侧 ParsePttWave 直接按它画）。 */
export const PTT_WAVEFORM = message([f('size', 1, 'uint32'), f('amplitudes', 2, 'bytes')]);

export const PTT_EXT_BIZ_INFO = message([
  f('srcUin', 1, 'uint64'),
  f('pttScene', 2, 'uint32'),
  f('pttType', 3, 'uint32'),
  f('changeVoice', 4, 'uint32'),
  f('waveform', 5, 'bytes'),
  f('autoConvertText', 6, 'uint32'),
  f('bytesReserve', 11, 'bytes'),
  f('bytesPbReserve', 12, 'bytes'),
  f('bytesGeneralFlags', 13, 'bytes'),
]);

export const NTV2_EXT_BIZ_INFO = message([
  f('pic', 1, PIC_EXT_BIZ_INFO),
  f('video', 2, VIDEO_EXT_BIZ_INFO),
  f('ptt', 3, PTT_EXT_BIZ_INFO),
  f('busiType', 10, 'uint32'),
]);

export const NTV2_UPLOAD_INFO = message([
  f('fileInfo', 1, NTV2_FILE_INFO),
  f('subFileType', 2, 'uint32'),
]);

export const NTV2_UPLOAD_REQ = message([
  f('uploadInfo', 1, NTV2_UPLOAD_INFO, { repeated: true }),
  f('tryFastUploadCompleted', 2, 'bool'),
  f('srvSendMsg', 3, 'bool'),
  f('clientRandomId', 4, 'uint64'),
  f('compatQmsgSceneType', 5, 'uint32'),
  f('extBizInfo', 6, NTV2_EXT_BIZ_INFO),
  f('clientSeq', 7, 'uint32'),
  f('noNeedCompatMsg', 8, 'bool'),
]);

/** 上传请求顶层：reqHead（与下载同构）+ upload。 */
export const NTV2_UPLOAD_REQ_TOP = message([
  f('reqHead', 1, NTV2_REQ_HEAD),
  f('upload', 2, NTV2_UPLOAD_REQ),
]);

// ───────────────────── 上传响应（msgInfo 即 commonElem.pbElem） ─────────────────────

export const C2C_SOURCE = message([f('friendUid', 2, 'string')]);
export const TROOP_SOURCE = message([f('groupUin', 1, 'uint32')]);

/** msgInfoBody 里的来源标记：私聊填 c2c、群聊填 troop（QQ 端据此渲染会话来源）。 */
export const HASH_SUM = message([
  f('bytesPbReserveC2c', 201, C2C_SOURCE),
  f('troopSource', 202, TROOP_SOURCE),
]);

export const MSG_INFO_BODY = message([
  f('index', 1, NTV2_INDEX_NODE),
  f('picture', 2, PICTURE_INFO),
  f('fileExist', 5, 'bool'),
  f('hashSum', 6, HASH_SUM),
]);

/** 上传响应里的 msgInfo：编码成 bytes 塞进 outgoing commonElem.pbElem。 */
export const UPLOAD_MSG_INFO = message([
  f('msgInfoBody', 1, MSG_INFO_BODY, { repeated: true }),
  f('extBizInfo', 2, NTV2_EXT_BIZ_INFO),
]);

export const NTV2_IPV4 = message([f('outIp', 1, 'uint32'), f('outPort', 2, 'uint32')]);

export const NTV2_SUB_FILE_INFO_RESP = message([
  f('subType', 1, 'uint32'),
  f('uKey', 2, 'string'),
  f('uKeyTtl', 3, 'uint32'),
  f('ipv4s', 4, NTV2_IPV4, { repeated: true }),
]);

export const NTV2_UPLOAD_RESP_BODY = message([
  f('uKey', 1, 'string'),
  f('uKeyTtl', 2, 'uint32'),
  f('ipv4s', 3, NTV2_IPV4, { repeated: true }),
  f('msgSeq', 5, 'uint64'),
  f('msgInfo', 6, UPLOAD_MSG_INFO),
  f('subFileInfos', 10, NTV2_SUB_FILE_INFO_RESP, { repeated: true }),
]);

export const NTV2_UPLOAD_RESP_TOP = message([
  f('respHead', 1, NTV2_RESP_HEAD),
  f('upload', 2, NTV2_UPLOAD_RESP_BODY),
]);

// ───────────────────── highway TCP 帧头 ─────────────────────

export const DATA_HIGHWAY_HEAD = message([
  f('version', 1, 'uint32'),
  f('uin', 2, 'string'),
  f('command', 3, 'string'),
  f('seq', 4, 'uint32'),
  f('retryTimes', 5, 'uint32'),
  f('appId', 6, 'uint32'),
  f('dataFlag', 7, 'uint32'),
  f('commandId', 8, 'uint32'),
]);

export const SEG_HEAD = message([
  f('serviceId', 1, 'uint32'),
  f('filesize', 2, 'uint64'),
  f('dataOffset', 3, 'uint64'),
  f('dataLength', 4, 'uint32'),
  f('retCode', 5, 'uint32'),
  f('serviceTicket', 6, 'bytes'),
  f('flag', 7, 'uint32'),
  f('md5', 8, 'bytes'),
  f('fileMd5', 9, 'bytes'),
  f('cacheAddr', 10, 'uint32'),
  f('cachePort', 13, 'uint32'),
]);

export const LOGIN_SIG_HEAD = message([f('loginSigType', 1, 'uint32'), f('appId', 3, 'uint32')]);

export const REQ_DATA_HIGHWAY_HEAD = message([
  f('msgBaseHead', 1, DATA_HIGHWAY_HEAD),
  f('msgSegHead', 2, SEG_HEAD),
  f('bytesReqExtendInfo', 3, 'bytes'),
  f('timestamp', 4, 'uint64'),
  f('msgLoginSigHead', 5, LOGIN_SIG_HEAD),
]);

export const RESP_DATA_HIGHWAY_HEAD = message([
  f('msgBaseHead', 1, DATA_HIGHWAY_HEAD),
  f('msgSegHead', 2, SEG_HEAD),
  f('errorCode', 3, 'uint32'),
]);

// ───────────────────── highway 载荷（NTV2RichMediaHighwayExt） ─────────────────────

export const HIGHWAY_DOMAIN = message([f('isEnable', 1, 'bool'), f('ip', 2, 'string')]);

export const HIGHWAY_IPV4 = message([f('domain', 1, HIGHWAY_DOMAIN), f('port', 2, 'uint32')]);

export const HIGHWAY_NETWORK = message([f('ipv4s', 1, HIGHWAY_IPV4, { repeated: true })]);

export const HIGHWAY_HASH = message([f('fileSha1', 1, 'bytes', { repeated: true })]);

export const NTV2_RICH_MEDIA_HIGHWAY_EXT = message([
  f('fileUuid', 1, 'string'),
  f('uKey', 2, 'string'),
  f('network', 5, HIGHWAY_NETWORK),
  f('msgInfoBody', 6, MSG_INFO_BODY, { repeated: true }),
  f('blockSize', 10, 'uint32'),
  f('hash', 11, HIGHWAY_HASH),
]);

// ───────────────────── HttpConn.0x6ff_501（highway 会话） ─────────────────────

/** `HttpConn.0x6ff_501` 请求里 httpConn 的 tag 是 0x501（1281），不是顺序号。 */
export const HTTP_CONN_TAG = 0x501;

export const HTTP_CONN = message([
  f('field1', 1, 'int32'),
  f('field2', 2, 'int32'),
  f('field3', 3, 'int32'),
  f('field4', 4, 'int32'),
  f('field6', 6, 'int32'),
  f('serviceTypes', 7, 'uint32', { repeated: true }),
  f('field9', 9, 'int32'),
  f('field10', 10, 'int32'),
  f('field11', 11, 'int32'),
  f('ver', 15, 'string'),
]);

export const HTTP_CONN_REQ = message([f('httpConn', HTTP_CONN_TAG, HTTP_CONN)]);

export const SERVER_ADDR = message([
  f('type', 1, 'uint32'),
  f('ip', 2, 'uint32'),
  f('port', 3, 'uint32'),
  f('area', 4, 'uint32'),
]);

export const SERVER_INFO = message([
  f('serviceType', 1, 'uint32'),
  f('serverAddrs', 2, SERVER_ADDR, { repeated: true }),
]);

export const HTTP_CONN_RESP_INNER = message([
  f('sigSession', 1, 'bytes'),
  f('sessionKey', 2, 'bytes'),
  f('serverInfos', 3, SERVER_INFO, { repeated: true }),
]);

export const HTTP_CONN_RESP = message([f('httpConn', HTTP_CONN_TAG, HTTP_CONN_RESP_INNER)]);

/** 会话请求/响应里复用的 NTV2 基础块（供 d.ts 级别的复用方引用）。 */
export { NTV2_CLIENT_META, NTV2_COMMON_HEAD, NTV2_C2C_USER_INFO, NTV2_GROUP_INFO };

// ───────────────────── TS 形状（解码结果用，避免到处 as Record） ─────────────────────

/** msgInfoBody 一项：`index.fileUuid` 是 highway 载荷要填的字段。 */
export interface Ntv2MsgInfoBody {
  index?: { fileUuid?: string; info?: Record<string, unknown>; [key: string]: unknown };
  picture?: Record<string, unknown>;
  fileExist?: boolean;
  hashSum?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 上传响应里的 msgInfo（编码后的字节就是 outgoing commonElem.pbElem）。 */
export interface Ntv2UploadMsgInfo {
  msgInfoBody?: Ntv2MsgInfoBody[];
  extBizInfo?: Record<string, unknown>;
}

/** `upload.ipv4s[]` / `subFileInfos[].ipv4s[]` —— highway 上传节点。 */
export interface Ntv2IPv4 {
  outIp?: number;
  outPort?: number;
}

/** `upload.subFileInfos[]` —— 视频封面等子文件各自的 uKey/ipv4s。 */
export interface Ntv2SubFileInfo {
  subType?: number;
  uKey?: string;
  uKeyTtl?: number;
  ipv4s?: Ntv2IPv4[];
}

/** 0xE37_100 响应里的 `upload` 段。 */
export interface Ntv2UploadResp {
  uKey?: string;
  uKeyTtl?: number;
  ipv4s?: Ntv2IPv4[];
  msgSeq?: bigint;
  msgInfo?: Ntv2UploadMsgInfo;
  subFileInfos?: Ntv2SubFileInfo[];
}
