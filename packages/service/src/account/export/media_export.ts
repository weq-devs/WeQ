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

import { copyFile, mkdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { MediaDownloadService } from '../media_download';
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

/** Strip a directory off a path, for log lines. */
export function fileLabel(path: string): string {
  return basename(path);
}
