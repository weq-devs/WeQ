/**
 * `@weq/protocol` — protobuf (de)serialization + custom-packet transport over
 * the native QQ hook.
 *
 *   protobuf.ts           — runtime, schema-driven protobuf encode/decode (no build step).
 *   transport.ts          — sendOidb / sendPacket wrappers around the native addon.
 *   oidb/invoke.ts        — invokeOidb / invokeTrpc dispatchers + spec shapes.
 *   oidb/shared.ts        — toInt / ensureRetCodeZero / hex utils.
 *   oidb/media-schemas.ts — NTV2 + file + album proto schemas + MediaIndexNode.
 *   oidb/ntv2.ts          — buildNtv2DownloadReq / parseNtv2DownloadUrl.
 *   oidb/get-ptt-url.ts   — GetGroupPttUrl / GetPrivatePttUrl namespaces.
 *   oidb/get-video-url.ts — GetGroupVideoUrl / GetPrivateVideoUrl namespaces.
 *   oidb/get-file-url.ts  — GetGroupFileUrl / GetPrivateFileUrl namespaces.
 *   oidb/list-group-files.ts     — ListGroupFiles (0x6D8_1, 群文件/文件夹分页列表)。
 *   oidb/get-album-media-list.ts — GetAlbumMediaList trpc namespace.
 *   oidb/get-user-qq-level.ts    — GetUserQqLevel (0xFE1_2, 只查 QQ 等级)。
 *   oidb/get-qq-show-url.ts      — GetQqShowUrl (0xFE1_3, QQ 秀 URL)。
 *   oidb/get-profile-like.ts     — GetProfileLike (0x7ED_12, 资料卡赞/收藏数)。
 *   oidb/send-tuwen-ark.ts       — SendTuwenArk (0xdc2_34, 图文 Ark 卡片发送)。
 *   scupdate/            — 个性装扮资源(气泡/字体)的下载地址获取(见该目录 index)。
 *   highway/             — 闪传/富媒体传输层(流式哈希 + sliceupload 直传)。
 *   oidb/flashtransfer/  — 闪传 fileset OIDB 服务 + 上传编排。
 */

export { encode, decode, message } from './protobuf';
export type { ProtoMessage, ProtoField, ScalarType } from './protobuf';

export { sendOidb, sendPacket } from './transport';
export type { PacketNative, OidbNative, TrpcNative, OidbRequest } from './transport';

export { invokeOidb, invokeTrpc } from './oidb/invoke';
export type { OidbSpec, TrpcSpec } from './oidb/invoke';

export { toInt, ensureRetCodeZero, bytesToHex, bytesToHexUpper } from './oidb/shared';

export { normalizeMediaNode } from './oidb/media-schemas';
export type { MediaIndexNode } from './oidb/media-schemas';

export { GetGroupPttUrl, GetPrivatePttUrl } from './oidb/get-ptt-url';
export { GetGroupVideoUrl, GetPrivateVideoUrl } from './oidb/get-video-url';
export {
  GetGroupFileUrl,
  GetPrivateFileUrl,
  composeGroupFileDownloadUrl,
} from './oidb/get-file-url';
export type { GroupFileDownload } from './oidb/get-file-url';
export { ListGroupFiles } from './oidb/list-group-files';
export type { GroupFileItem, GroupFolderItem, GroupFilePage } from './oidb/list-group-files';
export { GetAlbumMediaList } from './oidb/get-album-media-list';
export { GetUserQqLevel } from './oidb/get-user-qq-level';
export type { QqLevelInfo } from './oidb/get-user-qq-level';
export { GetQqShowUrl } from './oidb/get-qq-show-url';
export type { QqShowInfo } from './oidb/get-qq-show-url';
export { GetProfileLike } from './oidb/get-profile-like';
export type { LikeInfo, InteractionCounts } from './oidb/get-profile-like';
export { SendTuwenArk } from './oidb/send-tuwen-ark';
export type { SendTuwenArkParams } from './oidb/send-tuwen-ark';

export * from './scupdate';
export * from './highway';
export * from './oidb/flashtransfer';

export * from './msg';
