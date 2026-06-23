/**
 * Protobuf schemas for the media download / album commands, ported from
 * SnowLuma's `proto-defs/oidb-actions/media.ts` + `group-file.ts` +
 * `group-album.ts`. Each `pb<tag, T>` field becomes a `{ name, tag, type }`
 * entry; nested messages reference another schema; `pb_repeated` → `repeated`.
 *
 * Only the download/list request+response shapes are modelled (no upload).
 */

import { message } from '../protobuf';

// ───────────────────────── NTV2 rich media (ptt / video) ─────────────────────────

const NTV2_COMMON_HEAD = message([
  { name: 'requestId', tag: 1, type: 'uint32' },
  { name: 'command', tag: 2, type: 'uint32' },
]);

const NTV2_C2C_USER_INFO = message([
  { name: 'accountType', tag: 1, type: 'uint32' },
  { name: 'targetUid', tag: 2, type: 'string' },
]);

const NTV2_GROUP_INFO = message([{ name: 'groupUin', tag: 1, type: 'uint32' }]);

const NTV2_SCENE_INFO = message([
  { name: 'requestType', tag: 101, type: 'uint32' },
  { name: 'businessType', tag: 102, type: 'uint32' },
  { name: 'sceneType', tag: 200, type: 'uint32' },
  { name: 'c2c', tag: 201, type: NTV2_C2C_USER_INFO },
  { name: 'group', tag: 202, type: NTV2_GROUP_INFO },
]);

const NTV2_CLIENT_META = message([{ name: 'agentType', tag: 1, type: 'uint32' }]);

const NTV2_REQ_HEAD = message([
  { name: 'common', tag: 1, type: NTV2_COMMON_HEAD },
  { name: 'scene', tag: 2, type: NTV2_SCENE_INFO },
  { name: 'client', tag: 3, type: NTV2_CLIENT_META },
]);

const NTV2_FILE_TYPE = message([
  { name: 'type', tag: 1, type: 'uint32' },
  { name: 'picFormat', tag: 2, type: 'uint32' },
  { name: 'videoFormat', tag: 3, type: 'uint32' },
  { name: 'voiceFormat', tag: 4, type: 'uint32' },
]);

const NTV2_FILE_INFO = message([
  { name: 'fileSize', tag: 1, type: 'uint32' },
  { name: 'fileHash', tag: 2, type: 'string' },
  { name: 'fileSha1', tag: 3, type: 'string' },
  { name: 'fileName', tag: 4, type: 'string' },
  { name: 'type', tag: 5, type: NTV2_FILE_TYPE },
  { name: 'width', tag: 6, type: 'uint32' },
  { name: 'height', tag: 7, type: 'uint32' },
  { name: 'time', tag: 8, type: 'uint32' },
  { name: 'original', tag: 9, type: 'uint32' },
]);

const NTV2_INDEX_NODE = message([
  { name: 'info', tag: 1, type: NTV2_FILE_INFO },
  { name: 'fileUuid', tag: 2, type: 'string' },
  { name: 'storeId', tag: 3, type: 'uint32' },
  { name: 'uploadTime', tag: 4, type: 'uint32' },
  { name: 'ttl', tag: 5, type: 'uint32' },
  { name: 'subType', tag: 6, type: 'uint32' },
]);

const NTV2_VIDEO_DOWNLOAD_EXT = message([
  { name: 'busiType', tag: 1, type: 'uint32' },
  { name: 'sceneType', tag: 2, type: 'uint32' },
  { name: 'subBusiType', tag: 3, type: 'uint32' },
]);

const NTV2_DOWNLOAD_EXT = message([{ name: 'video', tag: 2, type: NTV2_VIDEO_DOWNLOAD_EXT }]);

const NTV2_DOWNLOAD_REQ = message([
  { name: 'node', tag: 1, type: NTV2_INDEX_NODE },
  { name: 'download', tag: 2, type: NTV2_DOWNLOAD_EXT },
]);

const NTV2_DOWNLOAD_RKEY_REQ = message([{ name: 'types', tag: 1, type: 'uint32', repeated: true }]);

export const NTV2_RICH_MEDIA_REQ = message([
  { name: 'reqHead', tag: 1, type: NTV2_REQ_HEAD },
  { name: 'download', tag: 3, type: NTV2_DOWNLOAD_REQ },
  { name: 'downloadRkey', tag: 4, type: NTV2_DOWNLOAD_RKEY_REQ },
]);

const NTV2_RESP_HEAD = message([
  { name: 'common', tag: 1, type: NTV2_COMMON_HEAD },
  { name: 'retCode', tag: 2, type: 'uint32' },
  { name: 'message', tag: 3, type: 'string' },
]);

const NTV2_MEDIA_DOWNLOAD_INFO = message([
  { name: 'domain', tag: 1, type: 'string' },
  { name: 'urlPath', tag: 2, type: 'string' },
  { name: 'httpsPort', tag: 3, type: 'uint32' },
]);

const NTV2_MEDIA_DOWNLOAD_RESP = message([
  { name: 'rKeyParam', tag: 1, type: 'string' },
  { name: 'rKeyTtlSecond', tag: 2, type: 'uint32' },
  { name: 'info', tag: 3, type: NTV2_MEDIA_DOWNLOAD_INFO },
  { name: 'rKeyCreateTime', tag: 4, type: 'uint32' },
]);

export const NTV2_RICH_MEDIA_RESP = message([
  { name: 'respHead', tag: 1, type: NTV2_RESP_HEAD },
  { name: 'download', tag: 3, type: NTV2_MEDIA_DOWNLOAD_RESP },
]);

// ───────────────────────── private (c2c) file download — 0xE37_1200 ─────────────────────────

const OIDB_PRIVATE_FILE_DOWNLOAD_REQ_BODY = message([
  { name: 'receiverUid', tag: 10, type: 'string' },
  { name: 'fileUuid', tag: 20, type: 'string' },
  { name: 'type', tag: 30, type: 'uint32' },
  { name: 'fileHash', tag: 60, type: 'string' },
  { name: 't2', tag: 601, type: 'uint32' },
]);

export const OIDB_PRIVATE_FILE_DOWNLOAD_REQ = message([
  { name: 'subCommand', tag: 1, type: 'uint32' },
  { name: 'field2', tag: 2, type: 'uint32' },
  { name: 'body', tag: 14, type: OIDB_PRIVATE_FILE_DOWNLOAD_REQ_BODY },
  { name: 'field101', tag: 101, type: 'uint32' },
  { name: 'field102', tag: 102, type: 'uint32' },
  { name: 'field200', tag: 200, type: 'uint32' },
  { name: 'field99999', tag: 99999, type: 'bytes' },
]);

const OIDB_PRIVATE_FILE_DOWNLOAD_RESP_RESULT = message([
  { name: 'server', tag: 20, type: 'string' },
  { name: 'port', tag: 40, type: 'uint32' },
  { name: 'url', tag: 50, type: 'string' },
]);

const OIDB_PRIVATE_FILE_DOWNLOAD_RESP_BODY = message([
  { name: 'state', tag: 20, type: 'string' },
  { name: 'result', tag: 30, type: OIDB_PRIVATE_FILE_DOWNLOAD_RESP_RESULT },
]);

export const OIDB_PRIVATE_FILE_DOWNLOAD_RESP = message([
  { name: 'body', tag: 14, type: OIDB_PRIVATE_FILE_DOWNLOAD_RESP_BODY },
]);

// ───────────────────────── group file download — 0x6D6_2 ─────────────────────────

const OIDB_GROUP_FILE_DOWNLOAD_REQ = message([
  { name: 'groupUin', tag: 1, type: 'uint32' },
  { name: 'appId', tag: 2, type: 'uint32' },
  { name: 'busId', tag: 3, type: 'uint32' },
  { name: 'fileId', tag: 4, type: 'string' },
]);

export const OIDB_GROUP_FILE_REQ = message([
  { name: 'download', tag: 3, type: OIDB_GROUP_FILE_DOWNLOAD_REQ },
]);

const OIDB_GROUP_FILE_DOWNLOAD_RESP = message([
  { name: 'retCode', tag: 1, type: 'uint32' },
  { name: 'retMsg', tag: 2, type: 'string' },
  { name: 'clientWording', tag: 3, type: 'string' },
  { name: 'downloadIp', tag: 4, type: 'string' },
  { name: 'downloadDns', tag: 5, type: 'string' },
  { name: 'downloadUrl', tag: 6, type: 'bytes' },
  { name: 'saveFileName', tag: 11, type: 'string' },
]);

export const OIDB_GROUP_FILE_RESP = message([
  { name: 'download', tag: 3, type: OIDB_GROUP_FILE_DOWNLOAD_RESP },
]);

// ───────────────────────── group album media list (trpc) ─────────────────────────

const EXT_MAP_ENTRY = message([
  { name: 'key', tag: 1, type: 'string' },
  { name: 'value', tag: 2, type: 'string' },
]);

const ALBUM_REQ_INFO = message([
  { name: 'groupId', tag: 1, type: 'string' },
  { name: 'albumId', tag: 2, type: 'string' },
  { name: 'field3', tag: 3, type: 'int32' },
  { name: 'attachInfo', tag: 4, type: 'string' },
  { name: 'field5', tag: 5, type: 'string' },
]);

export const GET_MEDIA_LIST_REQUEST = message([
  { name: 'field1', tag: 1, type: 'int32' },
  { name: 'field2', tag: 2, type: 'bytes' },
  { name: 'field3', tag: 3, type: 'bytes' },
  { name: 'reqInfo', tag: 4, type: ALBUM_REQ_INFO },
  { name: 'traceId', tag: 5, type: 'string' },
  { name: 'extMap', tag: 10, type: EXT_MAP_ENTRY, repeated: true },
]);

const ALBUM_URL_INFO = message([
  { name: 'url', tag: 1, type: 'string' },
  { name: 'width', tag: 2, type: 'uint32' },
  { name: 'height', tag: 3, type: 'uint32' },
]);

const ALBUM_PHOTO_URL = message([
  { name: 'spec', tag: 1, type: 'uint32' },
  { name: 'url', tag: 2, type: ALBUM_URL_INFO },
]);

const ALBUM_IMAGE_INFO = message([
  { name: 'name', tag: 1, type: 'string' },
  { name: 'sloc', tag: 2, type: 'string' },
  { name: 'lloc', tag: 3, type: 'string' },
  { name: 'photoUrls', tag: 4, type: ALBUM_PHOTO_URL, repeated: true },
  { name: 'defaultUrl', tag: 5, type: ALBUM_URL_INFO },
  { name: 'isGif', tag: 6, type: 'bool' },
  { name: 'hasRaw', tag: 7, type: 'bool' },
]);

const ALBUM_MEDIA_INFO = message([
  { name: 'type', tag: 1, type: 'uint32' },
  { name: 'image', tag: 2, type: ALBUM_IMAGE_INFO },
  { name: 'uploader', tag: 6, type: 'string' },
  { name: 'batchId', tag: 7, type: 'uint64' },
  { name: 'uploadTime', tag: 8, type: 'uint64' },
]);

const ALBUM_INFO = message([
  { name: 'albumId', tag: 1, type: 'string' },
  { name: 'owner', tag: 2, type: 'string' },
  { name: 'name', tag: 3, type: 'string' },
]);

const ALBUM_RSP_DATA = message([
  { name: 'albumInfo', tag: 1, type: ALBUM_INFO },
  { name: 'mediaList', tag: 3, type: ALBUM_MEDIA_INFO, repeated: true },
  { name: 'prevAttachInfo', tag: 4, type: 'string' },
  { name: 'nextAttachInfo', tag: 5, type: 'string' },
]);

export const GET_MEDIA_LIST_RESPONSE = message([
  { name: 'field1', tag: 1, type: 'int32' },
  { name: 'field2', tag: 2, type: 'bytes' },
  { name: 'field3', tag: 3, type: 'bytes' },
  { name: 'data', tag: 4, type: ALBUM_RSP_DATA },
]);

// ───────────────────────── shared MediaIndexNode (input) ─────────────────────────

/**
 * Index describing a server-side rich-media object (voice / video). Built from
 * a parsed message element; consumed by the NTV2 URL fetchers. Only `fileUuid`
 * is required — the rest hardens the server's lookup.
 */
export interface MediaIndexNode {
  fileUuid: string;
  fileSize?: number;
  fileHash?: string;
  fileSha1?: string;
  fileName?: string;
  width?: number;
  height?: number;
  /** Duration in seconds (voice / video). */
  time?: number;
  original?: number;
  storeId?: number;
  uploadTime?: number;
  ttl?: number;
  subType?: number;
  type?: {
    type?: number;
    picFormat?: number;
    videoFormat?: number;
    voiceFormat?: number;
  };
}

/** Build the NTV2 `download.node` object from a {@link MediaIndexNode}. */
export function normalizeMediaNode(node: MediaIndexNode): Record<string, unknown> {
  if (!node.fileUuid) throw new Error('media node fileUuid is required');
  const t = node.type ?? {};
  return {
    info: {
      fileSize: node.fileSize ?? 0,
      fileHash: node.fileHash ?? '',
      fileSha1: node.fileSha1 ?? '',
      fileName: node.fileName ?? '',
      type: {
        type: t.type ?? 0,
        picFormat: t.picFormat ?? 0,
        videoFormat: t.videoFormat ?? 0,
        voiceFormat: t.voiceFormat ?? 0,
      },
      width: node.width ?? 0,
      height: node.height ?? 0,
      time: node.time ?? 0,
      original: node.original ?? 0,
    },
    fileUuid: node.fileUuid,
    storeId: node.storeId ?? 0,
    uploadTime: node.uploadTime ?? 0,
    ttl: node.ttl ?? 0,
    subType: node.subType ?? 0,
  };
}
