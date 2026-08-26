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
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { dirname } from 'node:path';
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

/**
 * 把缺失消息漫游缓存里的渲染元素（RenderElement）还原成 {@link MediaElement}，
 * 供 OIDB 下载 URL 解析。缺失消息不在本地 msg 表，媒体补全/下载回查时用它兜底。
 * 渲染元素只保留前端展示需要的字段，下载必需的 fileToken 等都在里面；私聊文件的
 * fileHash（transferFlag45504 / md5）在缺失消息解码链路里没有保留，这里如实缺省。
 */
export function mediaElementFromRenderElement(el: {
  type: string;
  data?: unknown;
}): MediaElement {
  const d = (el.data ?? {}) as Record<string, unknown>;
  const s = (k: string): string => (typeof d[k] === 'string' ? d[k] : '');
  const n = (k: string): number => (typeof d[k] === 'number' ? d[k] : Number(d[k]) || 0);
  return {
    kind: el.type,
    fileToken: s('fileToken'),
    fileName: s('fileName'),
    fileSize: n('fileSize'),
    imgWidth: n('imgWidth'),
    imgHeight: n('imgHeight'),
    videoWidth: n('videoWidth'),
    videoHeight: n('videoHeight'),
    videoDuration: n('videoDuration'),
    uploadTime: n('uploadTime'),
    fileTTL: n('fileTTL'),
    subType: n('subType'),
    isOriginal: Boolean(d.isOriginal),
  };
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

  const isVideo = el.kind === 'video' || el.kind === 'bubbleVideo';
  const typeInfo: MediaIndexNode['type'] =
    isVideo          ? { type: 2, videoFormat: 1 } :
    el.kind === 'ptt' ? { type: 3, voiceFormat: 1 } :
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
    storeId: isVideo ? (el.fileFlag45415 ?? 0) : 0,
    uploadTime: el.uploadTime ?? 0,
    ttl: el.fileTTL ?? 0,
    subType: el.subType ?? 0,
    type: typeInfo,
    videoExt: isVideo
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
  private readonly profileInfo: AccountSession['profileInfo'];
  private resolvedSelfUid: string | undefined;

  constructor(
    private readonly nt: Pick<NtHelperBinding, 'sendOidbPacket'>,
    session: AccountSession,
    private readonly resolvePid: () => number,
  ) {
    this.selfUid = session.uidMap.uidByUin(BigInt(session.context.uin)) ?? '';
    this.profileInfo = session.profileInfo;
  }

  private async getSelfUid(): Promise<string> {
    if (this.selfUid) return this.selfUid;
    if (this.resolvedSelfUid !== undefined) return this.resolvedSelfUid;
    this.resolvedSelfUid = await this.profileInfo.getSelfUid();
    return this.resolvedSelfUid;
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

  /** `fileName` 落到 URL 的 `?fname=` 上,决定浏览器/下载器看到的文件名。 */
  async getGroupFileUrl(groupId: number, fileId: string, busId = 102, fileName = ''): Promise<string> {
    const download = await this.getGroupFileDownload(groupId, fileId, busId);
    const name = download.saveFileName || fileName;
    return `${composeGroupFileDownloadUrl(download)}${encodeURIComponent(name)}`;
  }

  async getGroupFileUrlFromElement(groupId: number, element: MediaElement, busId = 102): Promise<string> {
    return this.getGroupFileUrl(groupId, element.fileToken, busId);
  }

  // ─── private / c2c ───

  async getPrivateVideoUrl(node: MediaIndexNode): Promise<string> {
    const selfUid = await this.getSelfUid();
    if (!selfUid) throw new Error('selfUid unavailable — uid map may not cover own uin');
    return GetPrivateVideoUrl.invoke(this.nt, this.resolvePid(), { selfUid, node });
  }

  async getPrivateVideoUrlFromElement(element: MediaElement): Promise<string> {
    return this.getPrivateVideoUrl(mediaNodeFromElement(element));
  }

  async getPrivatePttUrl(node: MediaIndexNode): Promise<string> {
    const selfUid = await this.getSelfUid();
    if (!selfUid) throw new Error('selfUid unavailable — uid map may not cover own uin');
    return GetPrivatePttUrl.invoke(this.nt, this.resolvePid(), { selfUid, node });
  }

  async getPrivateFileUrl(fileId: string, fileHash: string): Promise<string> {
    const selfUid = await this.getSelfUid();
    if (!selfUid) throw new Error('selfUid unavailable — uid map may not cover own uin');
    return GetPrivateFileUrl.invoke(this.nt, this.resolvePid(), {
      selfUid,
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

  // ─── high-level resolvers (kind-aware; non-group ⇒ private/c2c) ───

  /**
   * Resolve a video element's download URL, branching on conversation kind.
   * Non-group conversations are all treated as private (c2c). `groupId` is only
   * read for the group branch.
   */
  async resolveVideoUrl(kind: 'group' | 'c2c', groupId: number, element: MediaElement): Promise<string> {
    return kind === 'group'
      ? this.getGroupVideoUrlFromElement(groupId, element)
      : this.getPrivateVideoUrlFromElement(element);
  }

  /**
   * Resolve a file element's download URL, branching on conversation kind. The
   * group branch composes the URL then appends the encoded file name (QQ's
   * ftn_handler URL leaves `?fname=` empty).
   */
  async resolveFileUrl(
    kind: 'group' | 'c2c',
    groupId: number,
    element: MediaElement,
    fileName: string,
  ): Promise<string> {
    if (kind === 'group') {
      const base = await this.getGroupFileUrlFromElement(groupId, element);
      return `${base}${encodeURIComponent(fileName)}`;
    }
    return this.getPrivateFileUrlFromElement(element);
  }

  // ─── unknown-scene resolvers (合并转发) ───

  /**
   * Resolve a video URL when the media's ORIGINAL conversation is unknown.
   *
   * NTV2's scene must match where the media was uploaded, not where we're
   * viewing it — a video sent in a private chat and then forwarded into a group
   * still belongs to the c2c scene. Merged-forward snapshots (40900) carry no
   * chatType, so the only reliable move is to try both and keep the first that
   * answers. `groupId` 0 makes the group attempt pointless, so it's skipped.
   */
  async resolveVideoUrlUnknownScene(groupId: number, element: MediaElement): Promise<string> {
    return firstResolved([
      ...(groupId > 0 ? [() => this.getGroupVideoUrlFromElement(groupId, element)] : []),
      () => this.getPrivateVideoUrlFromElement(element),
    ]);
  }

  /**
   * File counterpart of {@link resolveVideoUrlUnknownScene}. The two scenes use
   * entirely different commands (group 0x6D6_2 → ftn_handler, private
   * 0xE37_1200) and different hash inputs, so each attempt has to stand alone.
   */
  async resolveFileUrlUnknownScene(
    groupId: number,
    element: MediaElement,
    fileName: string,
  ): Promise<string> {
    return firstResolved([
      ...(groupId > 0
        ? [
            async () => {
              const base = await this.getGroupFileUrlFromElement(groupId, element);
              return `${base}${encodeURIComponent(fileName)}`;
            },
          ]
        : []),
      () => this.getPrivateFileUrlFromElement(element),
    ]);
  }
}

/**
 * Run each resolver in order, returning the first non-empty URL. Throws with
 * every attempt's error when they all fail — a single scene's message ("group
 * file not found") would be misleading when the other scene was tried too.
 */
async function firstResolved(attempts: Array<() => Promise<string>>): Promise<string> {
  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const url = await attempt();
      if (url) return url;
      errors.push('empty url');
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  throw new Error(`all scenes failed: ${errors.join(' | ')}`);
}

// ─── streamed download (shared by export pipeline + chat-view completion) ───

/** Result of a streamed download: ok, or a human-readable failure reason. */
export type DownloadOutcome = { ok: true } | { ok: false; reason: string };

/** Retries / base backoff for streamed video & file downloads. */
const DL_RETRIES = 3;
const DL_BACKOFF_BASE_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function backoffMs(n: number): number {
  const base = DL_BACKOFF_BASE_MS * 2 ** n;
  return base + Math.floor(Math.random() * base * 0.4);
}

/** Read a (small) error response body for surfacing — trimmed + capped. */
async function readErrBody(res: Awaited<ReturnType<typeof fetch>>): Promise<string> {
  try {
    const text = (await res.text()).trim();
    return text ? ` body=${text.slice(0, 300)}` : '';
  } catch {
    return '';
  }
}

/**
 * Stream one URL to `dest`, with exponential-backoff retry on transient errors
 * (network / 5xx / 429). Streams the body to disk so large videos / files don't
 * balloon memory. The QQ CDN signals failures with a JSON/text body (sometimes
 * even under HTTP 200) — those are NOT media, so any non-binary content-type is
 * treated as a failure and its body is surfaced as the reason.
 */
export async function downloadUrlToFile(url: string, dest: string): Promise<DownloadOutcome> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < DL_RETRIES) { await sleep(backoffMs(attempt)); continue; }
        return { ok: false, reason: `HTTP ${res.status}${await readErrBody(res)}` };
      }
      const ct = res.headers.get('content-type') ?? '';
      // Non-2xx, empty, or a JSON/text body → CDN error envelope, not media.
      if (!res.ok || !res.body || ct.startsWith('text/') || ct.includes('json')) {
        return { ok: false, reason: `HTTP ${res.status} ct=${ct || 'n/a'}${await readErrBody(res)}` };
      }
      await mkdir(dirname(dest), { recursive: true });
      await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(dest));
      return { ok: true };
    } catch (e) {
      if (attempt < DL_RETRIES) { await sleep(backoffMs(attempt)); continue; }
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }
}
