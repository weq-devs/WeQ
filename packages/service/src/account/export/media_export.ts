/**
 * Media export pipeline — the stages that run after messages + avatars, when
 * 导出媒体 is on. Each stage is independent and reports its own progress so the
 * task UI can show one bar per stage:
 *
 *   media  — copy locally-found pic / video / file into media/{image,video,file}
 *   record — SILK-decode locally-found voice clips into media/record/*.wav
 *   image  — CDN-complete the still-missing images into media/image/
 *
 * Destination paths are deterministic from each ref's original fileName (see
 * {@link mediaRelPath}), so the message file's injected `localPath` values match
 * what these stages write — whether or not a given download succeeds.
 *
 * video / file CDN download is intentionally deferred (the underlying download
 * interface is still being fixed): only their on-disk copies are exported.
 */

import { createWriteStream } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { basename, dirname, extname, join } from 'node:path';
import type { Element } from '@weq/codec';
import type { MsgService } from '../msg';
import type { MediaDownloadService } from '../media_download';
import type { MediaUrlService, MediaElement } from '../media_url';
import type { ConvKind } from './types';
import type { MediaRef, MediaScanResult } from './media_scan';

/** Decode a SILK voice file to a WAV at `destPath`. Injected (silk-wasm lives in the app). */
export type DecodeSilk = (silkPath: string, destPath: string) => Promise<boolean>;

/** Per-stage progress tick. */
export type StageProgress = (done: number, total: number) => void;

/** Subdirectory names under the bundle's `media/` folder, by purpose. */
export const MEDIA_SUBDIRS = {
  image: 'image',
  video: 'video',
  file: 'file',
  record: 'record',
} as const;

/** Counts returned by each media stage. */
export interface MediaStageResult {
  total: number;
  ok: number;
  failed: number;
}

/** Drop a trailing extension: `AB.MP4` → `AB`. */
function dropExt(filename: string): string {
  const ext = extname(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

/** Map a scanned media kind to its bundle subdirectory (null = not copied here). */
function copyKindDir(kind: MediaRef['kind']): string | null {
  switch (kind) {
    case 'pic':
    case 'emoji':
      return MEDIA_SUBDIRS.image;
    case 'video':
      return MEDIA_SUBDIRS.video;
    case 'file':
      return MEDIA_SUBDIRS.file;
    default:
      return null; // ptt is handled by the record stage
  }
}

/** Run `worker` over `items` with at most `concurrency` in flight. */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function run(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

/**
 * Stage `media`: copy every locally-found pic / video / file into the bundle's
 * media/{image,video,file} directories. Voice (ptt) is skipped — it's decoded
 * in the record stage. Returns copy counts.
 */
export async function copyFoundMedia(
  scan: MediaScanResult,
  mediaRoot: string,
  onProgress?: StageProgress,
  concurrency = 8,
): Promise<MediaStageResult> {
  const items = scan.found.filter((ref) => ref.path && copyKindDir(ref.kind));
  const result: MediaStageResult = { total: items.length, ok: 0, failed: 0 };
  if (items.length === 0) return result;

  // Pre-create the destination dirs once.
  const subdirs = new Set(items.map((ref) => copyKindDir(ref.kind)!));
  await Promise.all([...subdirs].map((d) => mkdir(join(mediaRoot, d), { recursive: true })));

  let done = 0;
  await runWithConcurrency(items, concurrency, async (ref) => {
    try {
      const dir = copyKindDir(ref.kind)!;
      await copyFile(ref.path!, join(mediaRoot, dir, ref.fileName));
      result.ok += 1;
    } catch {
      result.failed += 1;
    } finally {
      done += 1;
      onProgress?.(done, items.length);
    }
  });
  return result;
}

/**
 * Stage `record`: SILK-decode every locally-found voice clip into
 * media/record/<stem>.wav. Missing-but-downloadable voice is not fetched here
 * (voice download is deferred with video/file). Returns decode counts.
 */
export async function decodeFoundVoices(
  scan: MediaScanResult,
  mediaRoot: string,
  decodeSilk: DecodeSilk,
  onProgress?: StageProgress,
  concurrency = 4,
): Promise<MediaStageResult> {
  const items = scan.found.filter((ref) => ref.kind === 'ptt' && ref.path);
  const result: MediaStageResult = { total: items.length, ok: 0, failed: 0 };
  if (items.length === 0) return result;

  const recordDir = join(mediaRoot, MEDIA_SUBDIRS.record);
  await mkdir(recordDir, { recursive: true });

  let done = 0;
  await runWithConcurrency(items, concurrency, async (ref) => {
    try {
      const dest = join(recordDir, `${dropExt(ref.fileName)}.wav`);
      const ok = await decodeSilk(ref.path!, dest);
      if (ok) result.ok += 1;
      else result.failed += 1;
    } catch {
      result.failed += 1;
    } finally {
      done += 1;
      onProgress?.(done, items.length);
    }
  });
  return result;
}

/**
 * Stage `image`: CDN-complete the still-missing images (pic + received emoji)
 * into media/image/<fileName>, using a live download rkey. Expired refs are
 * already excluded from `downloadList`. Video / file are deferred. Returns
 * download counts.
 */
export async function downloadMissingImages(
  scan: MediaScanResult,
  mediaRoot: string,
  mediaDownload: MediaDownloadService,
  onProgress?: StageProgress,
  concurrency = 6,
): Promise<MediaStageResult> {
  const items = scan.downloadList.filter(
    (ref) => (ref.kind === 'pic' || ref.kind === 'emoji') && ref.fileToken,
  );
  const result: MediaStageResult = { total: items.length, ok: 0, failed: 0 };
  if (items.length === 0) return result;

  const imageDir = join(mediaRoot, MEDIA_SUBDIRS.image);
  await mkdir(imageDir, { recursive: true });

  let done = 0;
  await runWithConcurrency(items, concurrency, async (ref) => {
    try {
      const ext = extname(ref.fileName) || '.jpg';
      const cached = await mediaDownload.download(ref.fileToken, {
        ext,
        originalUrl: ref.originalUrl,
      });
      if (cached) {
        await copyFile(cached, join(imageDir, ref.fileName));
        result.ok += 1;
      } else {
        result.failed += 1;
      }
    } catch {
      result.failed += 1;
    } finally {
      done += 1;
      onProgress?.(done, items.length);
    }
  });
  return result;
}

/** Lowercased stem (no extension) — matches MediaRef.stem. */
function stemOf(filename: string): string {
  const ext = extname(filename);
  return (ext ? filename.slice(0, -ext.length) : filename).toLowerCase();
}

/** Retries / base backoff for video & file downloads (mirrors media_download). */
const DL_RETRIES = 3;
const DL_BACKOFF_BASE_MS = 300;
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function backoffMs(n: number): number {
  const base = DL_BACKOFF_BASE_MS * 2 ** n;
  return base + Math.floor(Math.random() * base * 0.4);
}

/**
 * Stream one URL to `dest`, with exponential-backoff retry on transient errors
 * (network / 5xx / 429). 4xx and text/* error pages fail fast. Streams the body
 * to disk so large videos / files don't balloon memory. Returns true on success.
 */
async function downloadUrlToFile(url: string, dest: string, tag = '[export]'): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < DL_RETRIES) { await sleep(backoffMs(attempt)); continue; }
        console.warn(`${tag} download http ${res.status} (gave up): ${url.slice(0, 90)}`);
        return false;
      }
      if (!res.ok || !res.body) {
        console.warn(`${tag} download http ${res.status} body=${res.body ? 'y' : 'n'}: ${url.slice(0, 120)}`);
        return false;
      }
      const ct = res.headers.get('content-type') ?? '';
      if (ct.startsWith('text/')) {
        console.warn(`${tag} download got text/* (not media), ct=${ct}: ${url.slice(0, 120)}`);
        return false; // error page, not media
      }
      await mkdir(dirname(dest), { recursive: true });
      await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(dest));
      return true;
    } catch (e) {
      if (attempt < DL_RETRIES) { await sleep(backoffMs(attempt)); continue; }
      console.warn(`${tag} download fetch error (gave up): ${e instanceof Error ? e.message : String(e)} | ${url.slice(0, 90)}`);
      return false;
    }
  }
}

/** Re-read a ref's message and find the raw codec element it refers to. */
async function findRawElement(
  msgs: Pick<MsgService, 'getRawElements'>,
  ref: MediaRef,
  kind: 'video' | 'file',
): Promise<Element | null> {
  let raw: Awaited<ReturnType<MsgService['getRawElements']>>;
  try {
    raw = await msgs.getRawElements(BigInt(ref.msgId));
  } catch {
    return null;
  }
  if (!raw) return null;
  const matches = raw.elements.filter((e) => e.kind === kind);
  // Match by stem when a message carries several of the same kind; else the one.
  return (
    matches.find((e) => stemOf(((e as { fileName?: string }).fileName) ?? '') === ref.stem) ??
    matches[0] ??
    null
  );
}

/** Shared context for the OIDB-backed video / file download stages. */
export interface UrlDownloadCtx {
  mediaUrl: MediaUrlService;
  msgs: Pick<MsgService, 'getRawElements'>;
  kind: ConvKind;
  /** Group code (群号) for group conversations; unused for c2c. */
  conv: string;
}

/**
 * Stage `video`: resolve each missing video's download URL via OIDB (needs an
 * online QQ) and stream it into media/video/<fileName>. TTL-expired videos are
 * already excluded from `downloadList`.
 */
export async function downloadMissingVideos(
  scan: MediaScanResult,
  mediaRoot: string,
  ctx: UrlDownloadCtx,
  onProgress?: StageProgress,
  concurrency = 3,
): Promise<MediaStageResult> {
  const items = scan.downloadList.filter((r) => r.kind === 'video');
  const result: MediaStageResult = { total: items.length, ok: 0, failed: 0 };
  if (items.length === 0) return result;
  const videoDir = join(mediaRoot, MEDIA_SUBDIRS.video);
  await mkdir(videoDir, { recursive: true });
  const groupId = ctx.kind === 'group' ? Number(ctx.conv) : 0;

  const tag = `[export][${ctx.kind === 'group' ? 'group' : 'private'} video]`;
  let done = 0;
  await runWithConcurrency(items, concurrency, async (ref) => {
    try {
      const el = await findRawElement(ctx.msgs, ref, 'video');
      if (!el) {
        console.warn(`${tag} no raw element: msgId=${ref.msgId} file=${ref.fileName}`);
        result.failed += 1;
        return;
      }
      const element = el as unknown as MediaElement;
      let url: string;
      try {
        url =
          ctx.kind === 'group'
            ? await ctx.mediaUrl.getGroupVideoUrlFromElement(groupId, element)
            : await ctx.mediaUrl.getPrivateVideoUrlFromElement(element);
      } catch (e) {
        console.warn(`${tag} url resolve failed: file=${ref.fileName} token=${ref.fileToken.slice(0, 16)}… err=${e instanceof Error ? e.message : String(e)}`);
        result.failed += 1;
        return;
      }
      if (!url) {
        console.warn(`${tag} empty url: file=${ref.fileName}`);
        result.failed += 1;
        return;
      }
      if (await downloadUrlToFile(url, join(videoDir, ref.fileName), tag)) result.ok += 1;
      else result.failed += 1;
    } catch (e) {
      console.warn(`${tag} unexpected: file=${ref.fileName} err=${e instanceof Error ? e.message : String(e)}`);
      result.failed += 1;
    } finally {
      done += 1;
      onProgress?.(done, items.length);
    }
  });
  return result;
}

/**
 * Stage `file`: resolve each missing file's download URL via OIDB (needs an
 * online QQ) and stream it into media/file/<fileName>. Group files have no TTL,
 * so all referenced files are attempted.
 */
export async function downloadMissingFiles(
  scan: MediaScanResult,
  mediaRoot: string,
  ctx: UrlDownloadCtx,
  onProgress?: StageProgress,
  concurrency = 3,
): Promise<MediaStageResult> {
  const items = scan.downloadList.filter((r) => r.kind === 'file');
  const result: MediaStageResult = { total: items.length, ok: 0, failed: 0 };
  if (items.length === 0) return result;
  const fileDir = join(mediaRoot, MEDIA_SUBDIRS.file);
  await mkdir(fileDir, { recursive: true });
  const groupId = ctx.kind === 'group' ? Number(ctx.conv) : 0;

  const tag = `[export][${ctx.kind === 'group' ? 'group' : 'private'} file]`;
  let done = 0;
  await runWithConcurrency(items, concurrency, async (ref) => {
    try {
      const el = await findRawElement(ctx.msgs, ref, 'file');
      if (!el) {
        console.warn(`${tag} no raw element: msgId=${ref.msgId} file=${ref.fileName}`);
        result.failed += 1;
        return;
      }
      const element = el as unknown as MediaElement;
      let url: string;
      try {
        if (ctx.kind === 'group') {
          // composeGroupFileDownloadUrl leaves `?fname=` empty — append the name.
          const base = await ctx.mediaUrl.getGroupFileUrlFromElement(groupId, element);
          url = `${base}${encodeURIComponent(ref.fileName)}`;
        } else {
          url = await ctx.mediaUrl.getPrivateFileUrlFromElement(element);
        }
      } catch (e) {
        const fe = element as { fileToken?: string; md5Bytes2?: Uint8Array; md5?: string };
        console.warn(
          `${tag} url resolve failed: file=${ref.fileName} fileId=${(fe.fileToken ?? '').slice(0, 24)}… ` +
            `hasMd5Bytes2=${fe.md5Bytes2 ? fe.md5Bytes2.length : 0} hasMd5=${fe.md5 ? 'y' : 'n'} ` +
            `err=${e instanceof Error ? e.message : String(e)}`,
        );
        result.failed += 1;
        return;
      }
      if (!url) {
        console.warn(`${tag} empty url: file=${ref.fileName}`);
        result.failed += 1;
        return;
      }
      if (await downloadUrlToFile(url, join(fileDir, ref.fileName), tag)) result.ok += 1;
      else result.failed += 1;
    } catch (e) {
      console.warn(`${tag} unexpected: file=${ref.fileName} err=${e instanceof Error ? e.message : String(e)}`);
      result.failed += 1;
    } finally {
      done += 1;
      onProgress?.(done, items.length);
    }
  });
  return result;
}

/** Strip a directory off a path, for log lines. */
export function fileLabel(path: string): string {
  return basename(path);
}
