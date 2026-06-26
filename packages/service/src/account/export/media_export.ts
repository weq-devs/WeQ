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

import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Element } from '@weq/codec';
import type { MsgService } from '../msg';
import type { MediaDownloadService } from '../media_download';
import { downloadUrlToFile, type MediaUrlService, type MediaElement } from '../media_url';
import type { ConvKind } from './types';
import type { MediaRef, MediaScanResult } from './media_scan';

/** Decode a SILK voice file to a WAV at `destPath`. Injected (silk-wasm lives in the app). */
export type DecodeSilk = (silkPath: string, destPath: string) => Promise<boolean>;

/** Outcome of one voice transcription. */
export interface TranscribeOutcome {
  ok: boolean;
  text?: string;
  error?: string;
}

/**
 * Transcribe a SILK voice file to text. Injected from the app — the sherpa-onnx
 * recognition engine is native and lives in the Electron main process (the
 * service stays zero-native, mirroring the silk-wasm split). The closure resolves
 * the selected model + decodes the silk to 16 kHz WAV internally.
 */
export type TranscribeVoiceFn = (silkPath: string) => Promise<TranscribeOutcome>;

/** File name of the per-bundle voice transcript map written by the transcribe stage. */
export const TRANSCRIPTS_FILE = 'transcripts.json';

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
  /** Per-file failure detail for the stage (capped). Surfaced in the UI. */
  failures?: MediaFailure[];
}

/** One file that failed in a media stage — surfaced in the UI's failure lightbox. */
export interface MediaFailure {
  /** Stage the failure happened in. */
  stage: 'image' | 'video' | 'file' | 'media' | 'record' | 'transcribe';
  fileName: string;
  /** Human-readable reason (HTTP status, OIDB error, decode failure, …). */
  error: string;
}

/** Drop a trailing extension: `AB.MP4` → `AB`. */
function dropExt(filename: string): string {
  const ext = extname(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

/** Cap on per-stage failure entries kept for the UI (older entries dropped). */
const FAILURES_CAP = 200;

/** Append a failure, dropping the oldest entries when the cap is reached. */
function pushFailure(
  out: MediaFailure[] | undefined,
  f: MediaFailure,
): MediaFailure[] {
  const arr = out ?? [];
  arr.push(f);
  if (arr.length > FAILURES_CAP) arr.splice(0, arr.length - FAILURES_CAP);
  return arr;
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
    } catch (e) {
      result.failed += 1;
      result.failures = pushFailure(result.failures, {
        stage: 'media',
        fileName: ref.fileName,
        error: e instanceof Error ? e.message : String(e),
      });
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
      if (ok) {
        result.ok += 1;
      } else {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'record',
          fileName: ref.fileName,
          error: 'silk decode returned false',
        });
      }
    } catch (e) {
      result.failed += 1;
      result.failures = pushFailure(result.failures, {
        stage: 'record',
        fileName: ref.fileName,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      done += 1;
      onProgress?.(done, items.length);
    }
  });
  return result;
}

/**
 * Stage `transcribe`: run the selected voice model over every locally-found
 * voice clip and write a single `transcripts.json` at the bundle root mapping
 * each voice file name → recognized text. Concurrency is kept low because each
 * call forks a native sherpa-onnx worker (CPU-heavy). The JSON is written even
 * when there are no voices (an empty map), so the artifact is always present.
 */
export async function transcribeFoundVoices(
  scan: MediaScanResult,
  bundleDir: string,
  transcribe: TranscribeVoiceFn,
  onProgress?: StageProgress,
  concurrency = 2,
): Promise<MediaStageResult> {
  const items = scan.found.filter((ref) => ref.kind === 'ptt' && ref.path);
  const result: MediaStageResult = { total: items.length, ok: 0, failed: 0 };
  const transcripts: Record<string, string> = {};

  const flush = async (): Promise<void> => {
    await writeFile(join(bundleDir, TRANSCRIPTS_FILE), JSON.stringify(transcripts, null, 2), 'utf-8');
  };
  if (items.length === 0) {
    await flush();
    return result;
  }

  let done = 0;
  await runWithConcurrency(items, concurrency, async (ref) => {
    try {
      const r = await transcribe(ref.path!);
      if (r.ok) {
        transcripts[ref.fileName] = r.text ?? '';
        result.ok += 1;
      } else {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'transcribe',
          fileName: ref.fileName,
          error: r.error ?? '转写失败',
        });
      }
    } catch (e) {
      result.failed += 1;
      result.failures = pushFailure(result.failures, {
        stage: 'transcribe',
        fileName: ref.fileName,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      done += 1;
      onProgress?.(done, items.length);
    }
  });

  await flush();
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
        result.failures = pushFailure(result.failures, {
          stage: 'image',
          fileName: ref.fileName,
          error: 'rkey download returned no cached path',
        });
      }
    } catch (e) {
      result.failed += 1;
      result.failures = pushFailure(result.failures, {
        stage: 'image',
        fileName: ref.fileName,
        error: e instanceof Error ? e.message : String(e),
      });
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

  let done = 0;
  await runWithConcurrency(items, concurrency, async (ref) => {
    try {
      const el = await findRawElement(ctx.msgs, ref, 'video');
      if (!el) {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'video',
          fileName: ref.fileName,
          error: 'raw video element not found for msgId=' + ref.msgId,
        });
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
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'video',
          fileName: ref.fileName,
          error: 'OIDB resolve failed: ' + (e instanceof Error ? e.message : String(e)),
        });
        return;
      }
      if (!url) {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'video',
          fileName: ref.fileName,
          error: 'OIDB resolve returned empty url',
        });
        return;
      }
      const outcome = await downloadUrlToFile(url, join(videoDir, ref.fileName));
      if (outcome.ok) {
        result.ok += 1;
      } else {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'video',
          fileName: ref.fileName,
          error: outcome.reason,
        });
      }
    } catch (e) {
      result.failed += 1;
      result.failures = pushFailure(result.failures, {
        stage: 'video',
        fileName: ref.fileName,
        error: 'unexpected: ' + (e instanceof Error ? e.message : String(e)),
      });
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

  let done = 0;
  await runWithConcurrency(items, concurrency, async (ref) => {
    try {
      const el = await findRawElement(ctx.msgs, ref, 'file');
      if (!el) {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'file',
          fileName: ref.fileName,
          error: 'raw file element not found for msgId=' + ref.msgId,
        });
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
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'file',
          fileName: ref.fileName,
          error: 'OIDB resolve failed: ' + (e instanceof Error ? e.message : String(e)),
        });
        return;
      }
      if (!url) {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'file',
          fileName: ref.fileName,
          error: 'OIDB resolve returned empty url',
        });
        return;
      }
      const outcome = await downloadUrlToFile(url, join(fileDir, ref.fileName));
      if (outcome.ok) result.ok += 1;
      else {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'file',
          fileName: ref.fileName,
          error: outcome.reason,
        });
      }
    } catch (e) {
      result.failed += 1;
      result.failures = pushFailure(result.failures, {
        stage: 'file',
        fileName: ref.fileName,
        error: 'unexpected: ' + (e instanceof Error ? e.message : String(e)),
      });
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
