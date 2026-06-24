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
 *   oidb/get-album-media-list.ts — GetAlbumMediaList trpc namespace.
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
export { GetGroupFileUrl, GetPrivateFileUrl, composeGroupFileDownloadUrl } from './oidb/get-file-url';
export type { GroupFileDownload } from './oidb/get-file-url';
export { GetAlbumMediaList } from './oidb/get-album-media-list';
