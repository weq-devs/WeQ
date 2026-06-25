/**
 * MediaUrlService — resolve download URLs for group/private voice, video, and
 * file elements via the OIDB/NTV2 protocol.
 *
 * `mediaNodeFromElement` converts a parsed message element into a
 * {@link MediaIndexNode} so callers don't need to do the field mapping.
 * `fileToken` (field 45503) on video/ptt elements is the `fileUuid` the
 * NTV2 request needs. For group files the `fileToken` acts as `fileId`.
 */

import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import {
  GetGroupFileUrl,
  GetGroupPttUrl,
  GetGroupVideoUrl,
  GetPrivateFileUrl,
  GetPrivatePttUrl,
  GetPrivateVideoUrl,
  composeGroupFileDownloadUrl,
  type GroupFileDownload,
  type MediaIndexNode,
} from '@weq/protocol';

export type { GroupFileDownload } from '@weq/protocol';

/** Minimal element surface used to build a {@link MediaIndexNode}. Compatible
 *  with `VideoElement`, `PttElement`, and `FileElement` from `@weq/codec`. */
export interface MediaElement {
  kind: string;
  fileToken: string;
  fileName?: string;
  fileSize?: number;
  /** Lowercase hex md5 (preferred over md5Bytes when present). */
  md5?: string;
  md5Bytes?: Uint8Array;
  md5Bytes2?: Uint8Array;
  contentHash?: Uint8Array;
  /** Private-file transfer blob (field 45504) — the OIDB 0xe37 `fileHash`. */
  transferFlag45504?: string;
  imgWidth?: number;
  imgHeight?: number;
  videoWidth?: number;
  videoHeight?: number;
  fileFlag45415?: number;
  videoFlag45421?: Uint8Array;
  /** Duration in seconds (video / ptt). */
  videoDuration?: number;
  uploadTime?: number;
  fileTTL?: number;
  subType?: number;
  isOriginal?: boolean;
  channelParams?: Uint8Array;
  videoFlag45863?: number;
}

/** Bytes → lowercase hex. */
function hexOf(bytes: Uint8Array | undefined): string {
  if (!bytes?.length) return '';
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

function textOrHexOf(bytes: Uint8Array | undefined): string {
  if (!bytes?.length) return '';
  const text = new TextDecoder().decode(bytes);
  return /^[\x20-\x7e]+$/.test(text) ? text : hexOf(bytes);
}

/**
 * Build a {@link MediaIndexNode} from a parsed message element. Only
 * `fileUuid` (= `fileToken`) is required; the rest fills the NTV2 node's
 * optional fields and doesn't block the URL resolution.
 */
export function mediaNodeFromElement(el: MediaElement): MediaIndexNode {
  const fileHash = el.md5 || hexOf(el.md5Bytes);
  const fileSha1 = hexOf(el.contentHash);

  const typeInfo: MediaIndexNode['type'] =
    el.kind === 'video' ? { type: 2, videoFormat: 1 } :
    el.kind === 'ptt'   ? { type: 3, voiceFormat: 1 } :
    {};

  return {
    fileUuid: el.fileToken,
    fileSize: el.fileSize ?? 0,
    fileHash,
    fileSha1,
    fileName: el.fileName ?? '',
    width: el.videoWidth ?? el.imgWidth ?? 0,
    height: el.videoHeight ?? el.imgHeight ?? 0,
    time: el.videoDuration ?? 0,
    original: el.isOriginal ? 1 : 0,
    storeId: el.kind === 'video' ? (el.fileFlag45415 ?? 0) : 0,
    uploadTime: el.uploadTime ?? 0,
    ttl: el.fileTTL ?? 0,
    subType: el.subType ?? 0,
    type: typeInfo,
    videoExt: el.kind === 'video'
      ? {
          channelParams: hexOf(el.channelParams),
          videoFlag45421: hexOf(el.videoFlag45421),
          videoFlag45863: el.videoFlag45863 ?? 0,
        }
      : undefined,
  };
}

export class MediaUrlService {
  private readonly selfUid: string;

  constructor(
    private readonly nt: Pick<NtHelperBinding, 'sendOidbPacket'>,
    session: AccountSession,
    private readonly resolvePid: () => number,
  ) {
    this.selfUid = session.uidMap.uidByUin(BigInt(session.context.uin)) ?? '';
  }

  // ─── group ───

  async getGroupVideoUrl(groupId: number, node: MediaIndexNode): Promise<string> {
    return GetGroupVideoUrl.invoke(this.nt, this.resolvePid(), { groupId, node });
  }

  async getGroupVideoUrlFromElement(groupId: number, element: MediaElement): Promise<string> {
    return this.getGroupVideoUrl(groupId, mediaNodeFromElement(element));
  }

  async getGroupPttUrl(groupId: number, node: MediaIndexNode): Promise<string> {
    return GetGroupPttUrl.invoke(this.nt, this.resolvePid(), { groupId, node });
  }

  /**
   * Returns {@link GroupFileDownload}; caller composes:
   * `https://${d.dns}/ftn_handler/${d.urlHex}/?fname=${encodeURIComponent(fileId)}`
   */
  async getGroupFileDownload(groupId: number, fileId: string, busId = 102): Promise<GroupFileDownload> {
    return GetGroupFileUrl.invoke(this.nt, this.resolvePid(), { groupId, fileId, busId });
  }

  async getGroupFileUrl(groupId: number, fileId: string, busId = 102): Promise<string> {
    return composeGroupFileDownloadUrl(await this.getGroupFileDownload(groupId, fileId, busId));
  }

  async getGroupFileUrlFromElement(groupId: number, element: MediaElement, busId = 102): Promise<string> {
    return this.getGroupFileUrl(groupId, element.fileToken, busId);
  }

  // ─── private / c2c ───

  async getPrivateVideoUrl(node: MediaIndexNode): Promise<string> {
    if (!this.selfUid) throw new Error('selfUid unavailable — uid map may not cover own uin');
    return GetPrivateVideoUrl.invoke(this.nt, this.resolvePid(), { selfUid: this.selfUid, node });
  }

  async getPrivateVideoUrlFromElement(element: MediaElement): Promise<string> {
    return this.getPrivateVideoUrl(mediaNodeFromElement(element));
  }

  async getPrivatePttUrl(node: MediaIndexNode): Promise<string> {
    if (!this.selfUid) throw new Error('selfUid unavailable — uid map may not cover own uin');
    return GetPrivatePttUrl.invoke(this.nt, this.resolvePid(), { selfUid: this.selfUid, node });
  }

  async getPrivateFileUrl(fileId: string, fileHash: string): Promise<string> {
    if (!this.selfUid) throw new Error('selfUid unavailable — uid map may not cover own uin');
    return GetPrivateFileUrl.invoke(this.nt, this.resolvePid(), {
      selfUid: this.selfUid,
      fileId,
      fileHash,
    });
  }

  async getPrivateFileUrlFromElement(element: MediaElement): Promise<string> {
    // OIDB 0xe37_1200 wants the 45504 transfer blob as the fileHash (verified
    // against real rows); md5 is only a fallback for older rows lacking it.
    const fileHash =
      element.transferFlag45504 || textOrHexOf(element.md5Bytes2) || element.md5 || hexOf(element.md5Bytes);
    if (!fileHash) throw new Error('private file element missing transferFlag45504/md5');
    return this.getPrivateFileUrl(element.fileToken, fileHash);
  }
}
