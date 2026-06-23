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
  contentHash?: Uint8Array;
  imgWidth?: number;
  imgHeight?: number;
  /** Duration in seconds (video / ptt). */
  videoDuration?: number;
  uploadTime?: number;
  fileTTL?: number;
  subType?: number;
  isOriginal?: boolean;
}

/** Bytes → lowercase hex. */
function hexOf(bytes: Uint8Array | undefined): string {
  if (!bytes?.length) return '';
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
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
    width: el.imgWidth ?? 0,
    height: el.imgHeight ?? 0,
    time: el.videoDuration ?? 0,
    original: el.isOriginal ? 1 : 0,
    uploadTime: el.uploadTime ?? 0,
    ttl: el.fileTTL ?? 0,
    subType: el.subType ?? 0,
    type: typeInfo,
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

  // ─── private / c2c ───

  async getPrivateVideoUrl(node: MediaIndexNode): Promise<string> {
    if (!this.selfUid) throw new Error('selfUid unavailable — uid map may not cover own uin');
    return GetPrivateVideoUrl.invoke(this.nt, this.resolvePid(), { selfUid: this.selfUid, node });
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
}
