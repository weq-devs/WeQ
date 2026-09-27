/**
 * 文件（群文件 / 私聊离线文件）**上传与发布**方向的 proto schema。
 *
 * 与富媒体（图片/语音/视频）那条 NTV2 管线完全无关 —— 文件走的是**老 OIDB +
 * highway 裸帧**：
 *
 *   群文件  0x6D6_0 申请 → highway cmdId **71** → 0x6D9_4 发布到群聊
 *   私聊文件 0xE37_1700 申请 → highway cmdId **95** → 0xE37_800 finalize → PbSendMsg
 *
 * 下载方向在 `./media-schemas`（群 0x6D6_2 / 私聊 0xE37_1200），两边共用同一批
 * 字段名（在已有 schema 上做加法）。
 *
 * 字段编号对照 NapCat `transformer/proto/oidb/Oidb.0x6D6.ts` /
 * `Oidb.0xE37_1700.ts` / `Oidb.0XE37_800.ts` 与 SnowLuma
 * `proto-defs/oidb-actions/group-file.ts` / `media.ts`。
 */

import { message } from '../protobuf';

// ───────────────────────── 群文件上传 — 0x6D6_0 ─────────────────────────

/** `file` 段（0x6D6_0 上传申请）。`fileSize` 是 uint64（大文件必带）。 */
export const OIDB_GROUP_FILE_UPLOAD_BLOCK = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'appId', tag: 2, type: 'uint32' },
  { name: 'busId', tag: 3, type: 'uint32' },
  { name: 'entrance', tag: 4, type: 'uint32' },
  { name: 'targetDirectory', tag: 5, type: 'string' },
  { name: 'fileName', tag: 6, type: 'string' },
  { name: 'localDirectory', tag: 7, type: 'string' },
  { name: 'fileSize', tag: 8, type: 'uint64' },
  { name: 'fileSha1', tag: 9, type: 'bytes' },
  { name: 'fileSha3', tag: 10, type: 'bytes' },
  { name: 'fileMd5', tag: 11, type: 'bytes' },
  { name: 'field15', tag: 15, type: 'bool' },
]);

export const OIDB_GROUP_FILE_UPLOAD_REQ = message([
  { name: 'file', tag: 1, type: OIDB_GROUP_FILE_UPLOAD_BLOCK },
]);

/** 0x6D6_0 响应里的 `upload` 段（上传节点 + fileId + highway 要用的两个 key）。 */
export const OIDB_GROUP_FILE_UPLOAD_RESP_UPLOAD = message([
  { name: 'retCode', tag: 1, type: 'uint32' },
  { name: 'retMsg', tag: 2, type: 'string' },
  { name: 'clientWording', tag: 3, type: 'string' },
  { name: 'uploadIp', tag: 4, type: 'string' },
  { name: 'serverDns', tag: 5, type: 'string' },
  { name: 'busId', tag: 6, type: 'uint32' },
  { name: 'fileId', tag: 7, type: 'string' },
  { name: 'checkKey', tag: 8, type: 'bytes' },
  { name: 'fileKey', tag: 9, type: 'bytes' },
  { name: 'boolFileExist', tag: 10, type: 'bool' },
  { name: 'uploadIpLanV4', tag: 12, type: 'string', repeated: true },
  { name: 'uploadIpLanV6', tag: 13, type: 'string', repeated: true },
  { name: 'uploadPort', tag: 14, type: 'uint32' },
]);

export const OIDB_GROUP_FILE_UPLOAD_RESP = message([
  { name: 'upload', tag: 1, type: OIDB_GROUP_FILE_UPLOAD_RESP_UPLOAD },
]);

// ───────────────────────── 群文件发布到群聊 — 0x6D9_4 ─────────────────────────

/**
 * 发布体：`field3` 是 31 位随机数（Lagrange `Random.Shared.Next()`）；
 * `field5: true` 是服务端反序列化器认这条分支的判别位。
 */
export const OIDB_GROUP_SEND_FILE_INFO = message([
  { name: 'busiType', tag: 1, type: 'uint32' },
  { name: 'fileId', tag: 2, type: 'string' },
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'field4', tag: 4, type: 'string' },
  { name: 'field5', tag: 5, type: 'bool' },
]);

export const OIDB_GROUP_SEND_FILE_BODY = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'type', tag: 2, type: 'uint32' },
  { name: 'info', tag: 3, type: OIDB_GROUP_SEND_FILE_INFO },
]);

/** 注意 `body` 是 **tag 5**（不是 1）。 */
export const OIDB_GROUP_SEND_FILE_REQ = message([
  { name: 'body', tag: 5, type: OIDB_GROUP_SEND_FILE_BODY },
]);

// ───────────────────────── 私聊文件上传 — 0xE37_1700 ─────────────────────────

export const OIDB_PRIVATE_FILE_UPLOAD_BODY = message([
  { name: 'senderUid', tag: 10, type: 'string' },
  { name: 'receiverUid', tag: 20, type: 'string' },
  { name: 'fileSize', tag: 30, type: 'uint32' },
  { name: 'fileName', tag: 40, type: 'string' },
  { name: 'md510MCheckSum', tag: 50, type: 'bytes' },
  { name: 'sha1CheckSum', tag: 60, type: 'bytes' },
  { name: 'localPath', tag: 70, type: 'string' },
  { name: 'md5CheckSum', tag: 110, type: 'bytes' },
  { name: 'sha3CheckSum', tag: 120, type: 'bytes' },
]);

export const OIDB_PRIVATE_FILE_UPLOAD_REQ = message([
  { name: 'command', tag: 1, type: 'uint32' },
  { name: 'seq', tag: 2, type: 'int32' },
  { name: 'upload', tag: 19, type: OIDB_PRIVATE_FILE_UPLOAD_BODY },
  { name: 'businessId', tag: 101, type: 'int32' },
  { name: 'clientType', tag: 102, type: 'int32' },
  { name: 'flagSupportMediaPlatform', tag: 200, type: 'int32' },
]);

/** 上传节点 IPv4：`inIP`/`inPort` 是 highway PUT 真正要连的那个（LAN，同 DC）。 */
export const OIDB_PRIVATE_FILE_UPLOAD_IPV4 = message([
  { name: 'outIp', tag: 1, type: 'int32' },
  { name: 'outPort', tag: 2, type: 'int32' },
  { name: 'inIp', tag: 3, type: 'int32' },
  { name: 'inPort', tag: 4, type: 'int32' },
  { name: 'ipType', tag: 5, type: 'int32' },
]);

export const OIDB_PRIVATE_FILE_UPLOAD_RESP_UPLOAD = message([
  { name: 'retCode', tag: 10, type: 'int32' },
  { name: 'retMsg', tag: 20, type: 'string' },
  { name: 'uploadIp', tag: 60, type: 'string' },
  { name: 'uploadDomain', tag: 70, type: 'string' },
  { name: 'uploadPort', tag: 80, type: 'uint32' },
  { name: 'uuid', tag: 90, type: 'string' },
  { name: 'uploadKey', tag: 100, type: 'bytes' },
  { name: 'boolFileExist', tag: 110, type: 'bool' },
  { name: 'uploadIpList', tag: 130, type: 'string', repeated: true },
  { name: 'uploadHttpsPort', tag: 140, type: 'int32' },
  { name: 'uploadHttpsDomain', tag: 150, type: 'string' },
  { name: 'uploadDns', tag: 160, type: 'string' },
  { name: 'uploadLanip', tag: 170, type: 'string' },
  { name: 'fileAddon', tag: 200, type: 'string' },
  {
    name: 'rtpMediaPlatformUploadAddress',
    tag: 210,
    type: OIDB_PRIVATE_FILE_UPLOAD_IPV4,
    repeated: true,
  },
  { name: 'mediaPlatformUploadKey', tag: 220, type: 'bytes' },
]);

export const OIDB_PRIVATE_FILE_UPLOAD_RESP = message([
  { name: 'upload', tag: 19, type: OIDB_PRIVATE_FILE_UPLOAD_RESP_UPLOAD },
]);

// ───────────────────────── 私聊离线文件 finalize — 0xE37_800 ─────────────────────────

export const OIDB_OFFLINE_FILE_FINALIZE_REQ_BODY = message([
  { name: 'senderUid', tag: 10, type: 'string' },
  { name: 'receiverUid', tag: 20, type: 'string' },
  { name: 'fileUuid', tag: 30, type: 'string' },
  { name: 'fileHash', tag: 40, type: 'string' },
]);

/** 注意 `body` 是 **tag 10**（与 0xE37_1200 下载的 tag 14 不是同一个消息）。 */
export const OIDB_OFFLINE_FILE_FINALIZE_REQ = message([
  { name: 'subCommand', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'int32' },
  { name: 'body', tag: 10, type: OIDB_OFFLINE_FILE_FINALIZE_REQ_BODY },
  { name: 'field101', tag: 101, type: 'int32' },
  { name: 'field102', tag: 102, type: 'int32' },
  { name: 'field200', tag: 200, type: 'int32' },
]);

/** 服务端签发的下载路由（进 outgoing `FileExtra.field6`）。 */
export const OIDB_OFFLINE_FILE_FINALIZE_METADATA = message([
  { name: 'field3', tag: 3, type: 'uint32' },
  { name: 'field100', tag: 100, type: 'bytes' },
  { name: 'field101', tag: 101, type: 'bytes' },
  { name: 'field110', tag: 110, type: 'uint32' },
  { name: 'timestamp1', tag: 130, type: 'uint32' },
]);

export const OIDB_OFFLINE_FILE_FINALIZE_RESP_BODY = message([
  { name: 'field10', tag: 10, type: 'uint32' },
  { name: 'metadata', tag: 30, type: OIDB_OFFLINE_FILE_FINALIZE_METADATA },
]);

export const OIDB_OFFLINE_FILE_FINALIZE_RESP = message([
  { name: 'command', tag: 1, type: 'uint32' },
  { name: 'subCommand', tag: 2, type: 'uint32' },
  { name: 'body', tag: 10, type: OIDB_OFFLINE_FILE_FINALIZE_RESP_BODY },
  { name: 'field50', tag: 50, type: 'uint32' },
]);
