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
import { createWriteStream, createReadStream, constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, link, unlink, lstat, copyFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
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
  /** NTV2 storeId（老 wire 解码带出，优先于 fileFlag45415）。 */
  storeId?: number;
  /** 群文件 busId（老 wire 解码带出，缺省 102）。 */
  busId?: number;
  videoFlag45421?: Uint8Array;
  /** Duration in seconds (video / ptt). */
  videoDuration?: number;
  /** Clip duration in seconds (ptt only; NTV2 node 的 time 槽位）。 */
  pttDuration?: number;
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
export function mediaElementFromRenderElement(el: { type: string; data?: unknown }): MediaElement {
  const d = (el.data ?? {}) as Record<string, unknown>;
  const s = (k: string): string => (typeof d[k] === 'string' ? d[k] : '');
  const n = (k: string): number => (typeof d[k] === 'number' ? d[k] : Number(d[k]) || 0);
  // 渲染 data 里的字节字段存的是小写 hex 字符串（msg_view.toHex），还原成 bytes。
  const bytes = (k: string): Uint8Array | undefined => {
    const v = d[k];
    if (v instanceof Uint8Array) return v;
    if (typeof v !== 'string' || v.length === 0 || v.length % 2 !== 0) return undefined;
    const out = new Uint8Array(v.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(v.slice(i * 2, i * 2 + 2), 16);
    return out;
  };
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
    pttDuration: n('pttDuration'),
    uploadTime: n('uploadTime'),
    fileTTL: n('fileTTL'),
    subType: n('subType'),
    isOriginal: Boolean(d.isOriginal),
    md5Bytes: bytes('md5Bytes'),
    md5Bytes2: bytes('md5Bytes2'),
    contentHash: bytes('contentHash'),
    channelParams: bytes('channelParams'),
    videoFlag45421: bytes('videoFlag45421'),
    videoFlag45863: n('videoFlag45863'),
    fileFlag45415: n('fileFlag45415'),
    storeId: n('storeId'),
    busId: n('busId'),
    transferFlag45504: s('transferFlag45504') || undefined,
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
  const typeInfo: MediaIndexNode['type'] = isVideo
    ? { type: 2, videoFormat: 1 }
    : el.kind === 'ptt'
      ? { type: 3, voiceFormat: 1 }
      : {};

  return {
    fileUuid: el.fileToken,
    fileSize: el.fileSize ?? 0,
    fileHash,
    fileSha1,
    fileName: el.fileName ?? '',
    width: el.videoWidth ?? el.imgWidth ?? 0,
    height: el.videoHeight ?? el.imgHeight ?? 0,
    // ptt 的时长走 pttDuration（videoDuration 只在 video 元素上有）。
    time: el.videoDuration ?? el.pttDuration ?? 0,
    original: el.isOriginal ? 1 : 0,
    storeId: el.storeId ?? (isVideo ? el.fileFlag45415 : 1),
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
  private readonly selfUin: string;
  private readonly profileInfo: AccountSession['profileInfo'];
  private resolvedSelfUid: string | undefined;

  constructor(
    private readonly nt: Pick<NtHelperBinding, 'sendOidbPacket'>,
    session: AccountSession,
    private readonly resolvePid: () => number,
  ) {
    // Resolved once at session open — `uidMap` never holds the owner's row.
    this.selfUid = session.selfUid;
    this.profileInfo = session.profileInfo;
    this.selfUin = session.context.uin;
  }

  private async getSelfUid(): Promise<string> {
    if (this.selfUid) return this.selfUid;
    if (this.resolvedSelfUid !== undefined) return this.resolvedSelfUid;
    this.resolvedSelfUid = /^\d+$/.test(this.selfUin)
      ? await this.profileInfo.getUidByUin(BigInt(this.selfUin))
      : '';
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

  async getGroupPttUrlFromElement(groupId: number, element: MediaElement): Promise<string> {
    return this.getGroupPttUrl(groupId, mediaNodeFromElement(element));
  }

  /**
   * Returns {@link GroupFileDownload}; caller composes:
   * `https://${d.dns}/ftn_handler/${d.urlHex}/?fname=${encodeURIComponent(fileId)}`
   */
  async getGroupFileDownload(
    groupId: number,
    fileId: string,
    busId = 102,
  ): Promise<GroupFileDownload> {
    return GetGroupFileUrl.invoke(this.nt, this.resolvePid(), { groupId, fileId, busId });
  }

  /** `fileName` 落到 URL 的 `?fname=` 上,决定浏览器/下载器看到的文件名。 */
  async getGroupFileUrl(
    groupId: number,
    fileId: string,
    busId = 102,
    fileName = '',
  ): Promise<string> {
    const download = await this.getGroupFileDownload(groupId, fileId, busId);
    const name = download.saveFileName || fileName;
    return `${composeGroupFileDownloadUrl(download)}${encodeURIComponent(name)}`;
  }

  async getGroupFileUrlFromElement(
    groupId: number,
    element: MediaElement,
    busId = 102,
  ): Promise<string> {
    return this.getGroupFileUrl(groupId, element.fileToken, element.busId ?? busId);
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

  async getPrivatePttUrlFromElement(element: MediaElement): Promise<string> {
    return this.getPrivatePttUrl(mediaNodeFromElement(element));
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
      element.transferFlag45504 ||
      textOrHexOf(element.md5Bytes2) ||
      element.md5 ||
      hexOf(element.md5Bytes);
    if (!fileHash) throw new Error('private file element missing transferFlag45504/md5');
    return this.getPrivateFileUrl(element.fileToken, fileHash);
  }

  // ─── high-level resolvers (kind-aware; non-group ⇒ private/c2c) ───

  /**
   * Resolve a video element's download URL, branching on conversation kind.
   * Non-group conversations are all treated as private (c2c). `groupId` is only
   * read for the group branch.
   */
  async resolveVideoUrl(
    kind: 'group' | 'c2c',
    groupId: number,
    element: MediaElement,
  ): Promise<string> {
    return kind === 'group'
      ? this.getGroupVideoUrlFromElement(groupId, element)
      : this.getPrivateVideoUrlFromElement(element);
  }

  /**
   * Resolve a ptt (voice) element's download URL, branching on conversation
   * kind — SnowLuma 同款 NTV2 0x126E_200 / 0x126D_200。`groupId` 只在群聊分支用。
   */
  async resolvePttUrl(
    kind: 'group' | 'c2c',
    groupId: number,
    element: MediaElement,
  ): Promise<string> {
    return kind === 'group'
      ? this.getGroupPttUrlFromElement(groupId, element)
      : this.getPrivatePttUrlFromElement(element);
  }

  /**
   * Ptt counterpart of {@link resolveVideoUrlUnknownScene}: merged-forward voice
   * snapshots (40900) carry no chatType, so try the group scene first (when a
   * groupId is known) and fall back to c2c.
   */
  async resolvePttUrlUnknownScene(groupId: number, element: MediaElement): Promise<string> {
    return firstResolved([
      ...(groupId > 0 ? [() => this.getGroupPttUrlFromElement(groupId, element)] : []),
      () => this.getPrivatePttUrlFromElement(element),
    ]);
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

/** Successful download evidence; it does not prove that a server supplied the original variant. */
export type DownloadOutcome =
  | { ok: true; bytes: number; sha256: string; contentType: string }
  | { ok: false; reason: string };

export interface DownloadOptions {
  signal?: AbortSignal;
  expectedKind?: 'image' | 'video';
  expectedSize?: number;
  expectedSha256?: string;
  maxBytes?: number;
  timeoutMs?: number;
}

function mediaSignature(bytes: Buffer, kind: 'image' | 'video'): boolean {
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const gif = /^(GIF87a|GIF89a)/.test(bytes.toString('ascii', 0, 6));
  const webp =
    bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  const bmp = bytes.toString('ascii', 0, 2) === 'BM';
  const ftyp = bytes.toString('ascii', 4, 8) === 'ftyp';
  const brand = bytes.toString('ascii', 8, 12);
  const avif = ftyp && /^(avif|avis|heic|heix|mif1)$/.test(brand);
  const webm = bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return kind === 'image' ? png || jpeg || gif || webp || bmp || avif : (ftyp && !avif) || webm;
}

async function waitRetry(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Stream to a private temporary file, verify, then publish without replacing existing media. */
export async function downloadUrlToFile(
  url: string,
  dest: string,
  options: DownloadOptions = {},
): Promise<DownloadOutcome> {
  for (let attempt = 0; attempt <= 3; attempt++) {
    const temporary = `${dest}.${randomUUID()}.part`;
    const controller = new AbortController();
    const cancel = () => controller.abort(options.signal?.reason);
    const timer = setTimeout(
      () => controller.abort(new Error('媒体下载超时。')),
      options.timeoutMs ?? 60_000,
    );
    options.signal?.addEventListener('abort', cancel, { once: true });
    let retry = true;
    try {
      options.signal?.throwIfAborted();
      const res = await fetch(url, { signal: controller.signal });
      const ct = (res.headers.get('content-type') ?? '').toLowerCase();
      if (
        !res.ok ||
        !res.body ||
        ct.startsWith('text/') ||
        ct.includes('json') ||
        ct.includes('xml')
      ) {
        await res.body?.cancel();
        retry = res.status === 429 || res.status >= 500;
        if (!retry || attempt === 3)
          return { ok: false, reason: `HTTP ${res.status} ct=${ct || 'n/a'}` };
      } else {
        const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
        const length = Number(res.headers.get('content-length') ?? 0);
        if (length > maxBytes) {
          await res.body.cancel();
          throw new Error('媒体超过大小上限。');
        }
        await mkdir(dirname(dest), { recursive: true });
        const hash = createHash('sha256');
        let bytes = 0;
        let prefix = Buffer.alloc(0);
        const inspect = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            bytes += chunk.length;
            if (bytes > maxBytes) {
              done(new Error('媒体超过大小上限。'));
              return;
            }
            hash.update(chunk);
            if (prefix.length < 512)
              prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)]);
            done(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
          inspect,
          createWriteStream(temporary, { flags: 'wx' }),
          { signal: controller.signal },
        );
        retry = false;
        const sha256 = hash.digest('hex');
        if (!bytes || /^\s*(?:<!doctype|<html|<\?xml)/i.test(prefix.toString('utf8')))
          throw new Error('媒体为空或返回了错误页面。');
        if (options.expectedKind && !mediaSignature(prefix, options.expectedKind))
          throw new Error('媒体格式与期望不符，可能返回了错误页面。');
        if (options.expectedSize !== undefined && bytes !== options.expectedSize)
          throw new Error('媒体大小与来源记录不符。');
        if (options.expectedSha256 && sha256 !== options.expectedSha256.toLowerCase())
          throw new Error('媒体哈希与来源记录不符。');
        try {
          try {
            await link(temporary, dest);
          } catch (error) {
            if (
              !['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'].includes(
                (error as NodeJS.ErrnoException).code ?? '',
              )
            )
              throw error;
            // Filesystems without hard links still get verified, exclusive publication.
            await copyFile(temporary, dest, constants.COPYFILE_EXCL);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const info = await lstat(dest);
          if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes)
            throw new Error('目标已有不同内容，已保留原文件。');
          const existing = createHash('sha256');
          for await (const chunk of createReadStream(dest)) {
            controller.signal.throwIfAborted();
            existing.update(chunk);
          }
          if (existing.digest('hex') !== sha256)
            throw new Error('目标已有不同内容，已保留原文件。');
        }
        return { ok: true, bytes, sha256, contentType: ct };
      }
    } catch (error) {
      if (options.signal?.aborted || attempt === 3 || !retry)
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    try {
      await waitRetry(300 * 2 ** attempt, options.signal);
    } catch {
      return { ok: false, reason: '媒体下载已取消。' };
    }
  }
  return { ok: false, reason: '媒体下载失败。' };
}
