// QQ 闪传(FlashTransfer / fileset)OIDB 请求/响应 protobuf schema。
// port 自 SL proto-defs/oidb-actions/flash-transfer.ts;响应成功靠 OIDB envelope 的
// errorCode=0,业务体无 retCode。force:true 对应 SL 的 pb_optional(0 值也上 wire)。

import { message } from '../../protobuf';

/** 空占位 message(Uploader.f4 / CommitInfo.f4 / f24 等)。 */
export const FLASH_EMPTY = message([]);

// ─────────────── 0x12a9 通用 head / FileInfo ───────────────

export const FLASH_APPLY_HEAD_SUB = message([
  { name: 'seq', tag: 1, type: 'uint32' },
  { name: 'sub', tag: 2, type: 'uint32' },
]);

export const FLASH_APPLY_HEAD_CONFIG = message([
  { name: 'field101', tag: 101, type: 'uint32' },
  { name: 'field102', tag: 102, type: 'uint32' },
  { name: 'field103', tag: 103, type: 'uint32' },
  { name: 'field200', tag: 200, type: 'uint32' },
]);

export const FLASH_APPLY_HEAD_FLAG = message([{ name: 'field1', tag: 1, type: 'uint32' }]);

export const FLASH_APPLY_HEAD = message([
  { name: 'sub', tag: 1, type: FLASH_APPLY_HEAD_SUB },
  { name: 'config', tag: 2, type: FLASH_APPLY_HEAD_CONFIG },
  { name: 'field3', tag: 3, type: FLASH_APPLY_HEAD_FLAG },
]);

export const FLASH_APPLY_HEAD_RESP = message([
  { name: 'sub', tag: 1, type: FLASH_APPLY_HEAD_SUB },
  { name: 'msg', tag: 3, type: 'string' },
]);

/** FileInfo.f5 — 固定四字节标记(0 值也必须上 wire)。 */
export const FLASH_APPLY_FILE_INFO5 = message([
  { name: 'field1', tag: 1, type: 'uint32', force: true },
  { name: 'field2', tag: 2, type: 'uint32', force: true },
  { name: 'field3', tag: 3, type: 'uint32', force: true },
  { name: 'field4', tag: 4, type: 'uint32', force: true },
]);

/** 0x12a9 f12.f1.f1 / f2.f1.f1 — FileInfo。 */
export const FLASH_APPLY_FILE_INFO = message([
  { name: 'fileSize', tag: 1, type: 'uint32', force: true },
  { name: 'md5', tag: 2, type: 'string', force: true },
  { name: 'sha1', tag: 3, type: 'string', force: true },
  { name: 'fileName', tag: 4, type: 'string', force: true },
  { name: 'field5', tag: 5, type: FLASH_APPLY_FILE_INFO5 },
  { name: 'field6', tag: 6, type: 'uint32', force: true },
  { name: 'field7', tag: 7, type: 'uint32', force: true },
  { name: 'field8', tag: 8, type: 'uint32', force: true },
  { name: 'field9', tag: 9, type: 'uint32', force: true },
]);

/** f12.f3 — f4 是空 message,与 FileInfo5.f4 的 varint 类型不同。 */
export const FLASH_APPLY_PAYLOAD_FIELD3 = message([
  { name: 'field1', tag: 1, type: 'uint32', force: true },
  { name: 'field2', tag: 2, type: 'uint32', force: true },
  { name: 'field3', tag: 3, type: 'uint32', force: true },
  { name: 'field4', tag: 4, type: FLASH_EMPTY },
]);

/** f12.f10 / f2.f9 — fileset 包装。 */
export const FLASH_APPLY_FILESET_WRAP = message([
  { name: 'filesetUuid', tag: 1, type: 'string', force: true },
  { name: 'uploadKey', tag: 2, type: 'string', force: true },
  { name: 'fileUuid', tag: 3, type: 'string', force: true },
  { name: 'field4', tag: 4, type: 'uint32', force: true },
  { name: 'field5', tag: 5, type: 'uint32', force: true },
  { name: 'field6', tag: 6, type: 'uint32', force: true },
  { name: 'field7', tag: 7, type: 'uint32', force: true },
  { name: 'field8', tag: 8, type: FLASH_EMPTY },
  { name: 'field9', tag: 9, type: 'uint32', force: true },
  { name: 'field10', tag: 10, type: 'uint32', force: true },
  { name: 'field11', tag: 11, type: 'uint32', force: true },
  { name: 'field12', tag: 12, type: 'uint32', force: true },
  { name: 'field13', tag: 13, type: 'uint32', force: true },
  { name: 'field14', tag: 14, type: 'uint32', force: true },
]);

/** f12.f1 — wrapper(FileInfo + fileId + 时间戳/TTL)。 */
export const FLASH_APPLY_UPLOAD_WRAPPER = message([
  { name: 'fileInfo', tag: 1, type: FLASH_APPLY_FILE_INFO },
  { name: 'fileId', tag: 2, type: 'string', force: true },
  { name: 'field3', tag: 3, type: 'uint32', force: true },
  { name: 'field4', tag: 4, type: 'uint32', force: true },
  { name: 'field5', tag: 5, type: 'uint32', force: true },
  { name: 'field6', tag: 6, type: 'uint32', force: true },
]);

export const FLASH_APPLY_FLAG2 = message([{ name: 'field1', tag: 1, type: 'uint32', force: true }]);

/** f12 — apply-upload payload(sub=103)。 */
export const FLASH_APPLY_UPLOAD_PAYLOAD = message([
  { name: 'wrapper', tag: 1, type: FLASH_APPLY_UPLOAD_WRAPPER },
  { name: 'flag2', tag: 2, type: FLASH_APPLY_FLAG2 },
  { name: 'field3', tag: 3, type: FLASH_APPLY_PAYLOAD_FIELD3 },
  { name: 'filesetWrap', tag: 10, type: FLASH_APPLY_FILESET_WRAP },
]);

/** 0x12a9 sub=103 请求(payload @ f12)。 */
export const FLASH_APPLY_UPLOAD_REQ = message([
  { name: 'head', tag: 1, type: FLASH_APPLY_HEAD },
  { name: 'payload', tag: 12, type: FLASH_APPLY_UPLOAD_PAYLOAD },
]);

export const FLASH_RKEY_WRAP = message([{ name: 'rkey', tag: 1, type: 'string' }]);

export const FLASH_APPLY_UPLOAD_RESP = message([
  { name: 'head', tag: 1, type: FLASH_APPLY_HEAD_RESP },
  { name: 'rkeyWrap', tag: 2, type: FLASH_RKEY_WRAP },
]);

/** sub=100 payload.f6 — 固定嵌套 message。 */
export const FLASH_PREPARE_PAYLOAD_F6_F1 = message([
  { name: 'field1', tag: 1, type: 'uint32', force: true },
  { name: 'field2', tag: 2, type: FLASH_EMPTY },
]);

export const FLASH_PREPARE_PAYLOAD_F6_F2 = message([{ name: 'field3', tag: 3, type: FLASH_EMPTY }]);

export const FLASH_PREPARE_PAYLOAD_F6_F3 = message([
  { name: 'field11', tag: 11, type: FLASH_EMPTY },
  { name: 'field12', tag: 12, type: FLASH_EMPTY },
]);

export const FLASH_PREPARE_PAYLOAD_F6 = message([
  { name: 'field1', tag: 1, type: FLASH_PREPARE_PAYLOAD_F6_F1 },
  { name: 'field2', tag: 2, type: FLASH_PREPARE_PAYLOAD_F6_F2 },
  { name: 'field3', tag: 3, type: FLASH_PREPARE_PAYLOAD_F6_F3 },
  { name: 'field10', tag: 10, type: 'uint32', force: true },
]);

/** sub=100 wrapper — f2 是 varint 0(sub=103 是 fileId string)。 */
export const FLASH_PREPARE_WRAPPER = message([
  { name: 'fileInfo', tag: 1, type: FLASH_APPLY_FILE_INFO },
  { name: 'field2', tag: 2, type: 'uint32', force: true },
]);

/** sub=100 payload。 */
export const FLASH_PREPARE_UPLOAD_PAYLOAD = message([
  { name: 'wrapper', tag: 1, type: FLASH_PREPARE_WRAPPER },
  { name: 'field2', tag: 2, type: 'uint32', force: true },
  { name: 'field3', tag: 3, type: 'uint32', force: true },
  { name: 'field4', tag: 4, type: 'uint32', force: true },
  { name: 'field5', tag: 5, type: 'uint32', force: true },
  { name: 'field6', tag: 6, type: FLASH_PREPARE_PAYLOAD_F6 },
  { name: 'field7', tag: 7, type: 'uint32', force: true },
  { name: 'field8', tag: 8, type: 'uint32', force: true },
  { name: 'filesetWrap', tag: 9, type: FLASH_APPLY_FILESET_WRAP },
]);

/** 0x12a9 sub=100 请求(payload @ f2;sub=103 在 f12)。 */
export const FLASH_PREPARE_UPLOAD_REQ = message([
  { name: 'head', tag: 1, type: FLASH_APPLY_HEAD },
  { name: 'payload', tag: 2, type: FLASH_PREPARE_UPLOAD_PAYLOAD },
]);

export const FLASH_PREPARE_UPLOAD_RESP = message([
  { name: 'head', tag: 1, type: FLASH_APPLY_HEAD_RESP },
  { name: 'rkeyWrap', tag: 2, type: FLASH_RKEY_WRAP },
]);

/** wrapper.f2 fileId — 客户端构造的 protobuf,base64url 编码。 */
export const FLASH_FILE_ID = message([
  { name: 'sha1', tag: 2, type: 'bytes' },
  { name: 'fileSize', tag: 3, type: 'uint32' },
  { name: 'appid', tag: 4, type: 'uint32' },
  { name: 'timestamp', tag: 5, type: 'uint64' },
  { name: 'env', tag: 6, type: 'string' },
  { name: 'ttl', tag: 10, type: 'uint32' },
  { name: 'sessionId', tag: 11, type: 'bytes' },
  { name: 'field15', tag: 15, type: 'bytes' },
  { name: 'region', tag: 16, type: 'string' },
]);

// ─────────────── 0x93cf — 申请创建 fileSet ───────────────

export const FLASH_UPLOADER = message([
  { name: 'uin', tag: 1, type: 'string' },
  { name: 'nickname', tag: 2, type: 'string' },
  { name: 'uid', tag: 3, type: 'string' },
  { name: 'field4', tag: 4, type: FLASH_EMPTY },
]);

export const FLASH_UPLOAD_FILE_INFO = message([
  { name: 'fileName', tag: 2, type: 'string' },
  { name: 'origName', tag: 3, type: 'string' },
  { name: 'fileType', tag: 4, type: 'uint32' },
  { name: 'fileSize', tag: 5, type: 'uint64' },
  { name: 'uploader', tag: 10, type: FLASH_UPLOADER },
  { name: 'field16', tag: 16, type: 'uint32' },
  { name: 'field20', tag: 20, type: 'uint32' },
  { name: 'field21', tag: 21, type: 'uint32' },
]);

export const FLASH_APPLY_FILESET_REQ = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'fileInfo', tag: 2, type: FLASH_UPLOAD_FILE_INFO },
  { name: 'typeCode', tag: 3, type: 'uint32' },
  { name: 'field12', tag: 12, type: 'uint32' },
]);

export const FLASH_APPLY_FILESET_RESP = message([
  { name: 'filesetUuid', tag: 1, type: 'string' },
  { name: 'uploadKey', tag: 2, type: 'string' },
  { name: 'uploadUrl', tag: 3, type: 'string' },
  { name: 'expire', tag: 4, type: 'uint64' },
  { name: 'ttl', tag: 5, type: 'uint32' },
]);

// ─────────────── 0x93d0 — commit(文件元数据上报) ───────────────

export const FLASH_COMMIT_FILE_INFO = message([
  { name: 'filesetUuid', tag: 1, type: 'string' },
  { name: 'fileUuid', tag: 2, type: 'string' },
  { name: 'field3', tag: 3, type: 'uint32', force: true },
  { name: 'field4', tag: 4, type: FLASH_EMPTY },
  { name: 'field5', tag: 5, type: 'uint32', force: true },
  { name: 'field6', tag: 6, type: 'uint32', force: true },
  { name: 'formatCode', tag: 7, type: 'uint32', force: true },
  { name: 'fileName', tag: 8, type: 'string' },
  { name: 'origName', tag: 9, type: 'string' },
  { name: 'field10', tag: 10, type: 'uint32', force: true },
  { name: 'fileSize', tag: 11, type: 'uint64' },
  { name: 'field12', tag: 12, type: 'uint32', force: true },
  { name: 'field24', tag: 24, type: FLASH_EMPTY },
]);

export const FLASH_COMMIT_FILE_REQ = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'filesetUuid', tag: 2, type: 'string' },
  { name: 'uploadKey', tag: 3, type: 'string' },
  { name: 'commitInfo', tag: 4, type: FLASH_COMMIT_FILE_INFO, repeated: true },
  { name: 'field5', tag: 5, type: 'uint32' },
  { name: 'field6', tag: 6, type: 'uint32' },
]);

export const FLASH_COMMIT_FILE_RESP = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'filesetUuid', tag: 2, type: 'string' },
  { name: 'uploadKey', tag: 3, type: 'string' },
]);

// ─────────────── 0x93db complete / 0x93d1 set-status ───────────────

export const FLASH_COMPLETE_FILESET_REQ = message([
  { name: 'filesetUuid', tag: 1, type: 'string' },
  { name: 'field2', tag: 2, type: 'string' },
]);

export const FLASH_COMPLETE_FILESET_RESP = message([]);

export const FLASH_SET_STATUS_REQ = message([
  { name: 'filesetUuid', tag: 1, type: 'string' },
  { name: 'status', tag: 2, type: 'uint32' },
]);

export const FLASH_SET_STATUS_RESP = message([]);

// ─────────────── 0x93d3 — 拉取文件集详情(分享链接) ───────────────

export const FLASH_FILE_UPLOAD_URL = message([{ name: 'uploadUrl', tag: 1, type: 'string' }]);

export const FLASH_FILE_DOWNLOAD_INFO = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'downloadUrl', tag: 2, type: 'string' },
]);

export const FLASH_FILE_ID_WRAP = message([
  { name: 'fileId', tag: 1, type: 'string' },
  { name: 'download', tag: 2, type: FLASH_FILE_DOWNLOAD_INFO },
]);

export const FLASH_FILE_ENTRY = message([
  { name: 'filesetUuid', tag: 1, type: 'string' },
  { name: 'fileName', tag: 2, type: 'string' },
  { name: 'origName', tag: 3, type: 'string' },
  { name: 'fileType', tag: 4, type: 'uint32' },
  { name: 'fileSize', tag: 5, type: 'uint64' },
  { name: 'uploadUrlWrap', tag: 8, type: FLASH_FILE_UPLOAD_URL },
  { name: 'fileIdWrap', tag: 9, type: FLASH_FILE_ID_WRAP },
]);

export const FLASH_GET_DETAIL_REQ = message([
  { name: 'filesetUuid', tag: 1, type: 'string' },
  { name: 'field2', tag: 2, type: 'uint32' },
]);

export const FLASH_GET_DETAIL_RESP = message([
  { name: 'entries', tag: 1, type: FLASH_FILE_ENTRY, repeated: true },
]);

// ─────────────── 0x93d7 — 发送闪传文件给用户 ───────────────

export const FLASH_SEND_TARGET_UID = message([{ name: 'targetUid', tag: 1, type: 'string' }]);

export const FLASH_SEND_TARGET_GROUP_ID = message([{ name: 'groupId', tag: 1, type: 'uint32' }]);

export const FLASH_SEND_TARGET = message([
  { name: 'field1', tag: 1, type: 'uint32' },
  { name: 'targetUid', tag: 2, type: FLASH_SEND_TARGET_UID },
  { name: 'targetGroup', tag: 3, type: FLASH_SEND_TARGET_GROUP_ID },
]);

export const FLASH_SEND_REQ = message([
  { name: 'target', tag: 1, type: FLASH_SEND_TARGET },
  { name: 'filesetUuid', tag: 2, type: 'string' },
]);

export const FLASH_SEND_RESP_ECHO = message([{ name: 'target', tag: 3, type: FLASH_SEND_TARGET }]);

export const FLASH_SEND_RESP = message([{ name: 'echo', tag: 1, type: FLASH_SEND_RESP_ECHO }]);
