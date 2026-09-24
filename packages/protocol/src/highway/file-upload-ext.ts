/**
 * 文件上传的 highway 扩展（`bytesReqExtendInfo`）—— 与富媒体的
 * `NTV2RichMediaHighwayExt` **完全不同的另一套**：
 *
 *   - 富媒体（图片/语音/视频）：cmdId 1001~1008，extend 里带 uKey + msgInfoBody + 每块 sha1；
 *   - 文件（群/私聊）：cmdId **71 / 95**，extend 里带 fileId + uploadKey + 上传节点，
 *     外加一个 `busiBuff`（群文件还带群号，私聊只带自己 uin）。
 *
 * 字段编号对照 NapCat `transformer/proto/highway/highway.ts` 的 `FileUploadExt`
 * （它整套结构是从 acidify 的 protobuf 抄的，名字都叫 `Exciting*`），
 * 与 SnowLuma `bridge/apis/group-file.ts` 的 `buildGroupFileUploadExt` /
 * `buildPrivateFileUploadExt`。
 *
 * 两处真机坑（SL #157 记录、我们照抄）：
 *   1. `busiBuff` **只带 senderUin**（不要 busId）——带了旧 busId:102 会让离线文件
 *      服务端收下 highway 字节却永远 finalize 不成可下载的文件（>5 MiB 时必现）；
 *   2. 群文件 cmdId 71 / 私聊 cmdId 95，两者 extend 的 `unknown200` 也不同
 *      （群 0、私聊 1 —— 0 是 proto3 默认值，不上 wire，与 NapCat 的实际字节一致）。
 */

import { encode, message } from '../protobuf';

const EXCITING_BUSI_INFO = message([
  { name: 'busId', tag: 1, type: 'int32' },
  { name: 'senderUin', tag: 100, type: 'uint64' },
  { name: 'receiverUin', tag: 200, type: 'uint64' },
  { name: 'groupCode', tag: 400, type: 'uint64' },
]);

const EXCITING_FILE_ENTRY = message([
  { name: 'fileSize', tag: 100, type: 'uint64' },
  { name: 'md5', tag: 200, type: 'bytes' },
  { name: 'checkKey', tag: 300, type: 'bytes' },
  { name: 'md5S2', tag: 400, type: 'bytes' },
  { name: 'fileId', tag: 600, type: 'string' },
  { name: 'uploadKey', tag: 700, type: 'bytes' },
]);

const EXCITING_CLIENT_INFO = message([
  { name: 'clientType', tag: 100, type: 'int32' },
  { name: 'appId', tag: 200, type: 'string' },
  { name: 'terminalType', tag: 300, type: 'int32' },
  { name: 'clientVer', tag: 400, type: 'string' },
  { name: 'unknown', tag: 600, type: 'int32' },
]);

const EXCITING_FILE_NAME_INFO = message([{ name: 'fileName', tag: 100, type: 'string' }]);

const EXCITING_URL_INFO = message([
  { name: 'unknown', tag: 1, type: 'int32' },
  { name: 'host', tag: 2, type: 'string' },
]);

const EXCITING_HOST_INFO = message([
  { name: 'url', tag: 1, type: EXCITING_URL_INFO },
  { name: 'port', tag: 2, type: 'uint32' },
]);

const EXCITING_HOST_CONFIG = message([
  { name: 'hosts', tag: 200, type: EXCITING_HOST_INFO, repeated: true },
]);

const FILE_UPLOAD_ENTRY = message([
  { name: 'busiBuff', tag: 100, type: EXCITING_BUSI_INFO },
  { name: 'fileEntry', tag: 200, type: EXCITING_FILE_ENTRY },
  { name: 'clientInfo', tag: 300, type: EXCITING_CLIENT_INFO },
  { name: 'fileNameInfo', tag: 400, type: EXCITING_FILE_NAME_INFO },
  { name: 'host', tag: 500, type: EXCITING_HOST_CONFIG },
]);

export const FILE_UPLOAD_EXT = message([
  { name: 'unknown1', tag: 1, type: 'int32' },
  { name: 'unknown2', tag: 2, type: 'int32' },
  { name: 'unknown3', tag: 3, type: 'int32' },
  { name: 'entry', tag: 100, type: FILE_UPLOAD_ENTRY },
  { name: 'unknown200', tag: 200, type: 'int32' },
]);

/** highway 命令号（进 `msgBaseHead.commandId`）。 */
export const GROUP_FILE_HIGHWAY_CMD = 71;
export const PRIVATE_FILE_HIGHWAY_CMD = 95;

export interface FileUploadExtInput {
  /** 自己账号的 uin（`senderUin`）。 */
  senderUin: number;
  fileName: string;
  fileSize: number;
  md5: Uint8Array;
  fileId: string;
  uploadKey: Uint8Array;
  uploadHost: string;
  uploadPort: number;
}

function commonEntry(
  input: FileUploadExtInput,
  checkKey: Uint8Array,
  busiBuff: Record<string, unknown>,
): Record<string, unknown> {
  return {
    busiBuff,
    fileEntry: {
      fileSize: BigInt(Math.max(0, input.fileSize)),
      md5: input.md5,
      md5S2: input.md5,
      checkKey,
      fileId: input.fileId,
      uploadKey: input.uploadKey,
    },
    // 客户端标识固定（NapCat / SL 同）。
    clientInfo: {
      clientType: 3,
      appId: '100',
      terminalType: 3,
      clientVer: '1.1.1',
      unknown: 4,
    },
    fileNameInfo: { fileName: input.fileName },
    host: {
      hosts: [{ url: { host: input.uploadHost, unknown: 1 }, port: input.uploadPort }],
    },
  };
}

/** 群文件（cmdId 71）：`busiBuff` 带 senderUin + 群号，checkKey 用响应里的 checkKey。 */
export function buildGroupFileUploadExt(
  input: FileUploadExtInput & { groupId: number; checkKey: Uint8Array },
): Uint8Array {
  return encode(FILE_UPLOAD_EXT, {
    unknown1: 100,
    unknown2: 1,
    entry: commonEntry(input, input.checkKey, {
      senderUin: BigInt(input.senderUin),
      receiverUin: BigInt(input.groupId),
      groupCode: BigInt(input.groupId),
    }),
    unknown200: 0,
  });
}

/** 私聊文件（cmdId 95）：`busiBuff` **只**带 senderUin，checkKey 用整文件 sha1。 */
export function buildPrivateFileUploadExt(
  input: FileUploadExtInput & { sha1: Uint8Array },
): Uint8Array {
  return encode(FILE_UPLOAD_EXT, {
    unknown1: 100,
    unknown2: 1,
    entry: commonEntry(input, input.sha1, { senderUin: BigInt(input.senderUin) }),
    unknown3: 0,
    unknown200: 1,
  });
}
