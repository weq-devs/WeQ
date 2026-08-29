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
 * video / file / ptt CDN download is OIDB-backed: missing originals are
 * re-resolved and streamed into the bundle when the matching toggles are on.
 */

import { copyFile, mkdir, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Element } from '@weq/codec';
import type { MsgService } from '../msg';
import type { GapHistoryService } from '../gap_history';
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

/** 每项文件的详细日志（Docker TUI 风格，前端按 stage 滚动展示）。 */
export type StageLog = (text: string, level?: 'info' | 'warn' | 'error') => void;

/** 一个并发子任务的状态变化（如媒体搬运中的单个文件）。 */
export interface SubtaskEvent {
  /** 子任务唯一 key（前端按 stage + key 归集日志）。 */
  key: string;
  /** 展示名（文件路径 / 文件名）。 */
  label: string;
  status: 'running' | 'completed' | 'failed';
  /** 状态附注（失败原因等）。 */
  note?: string;
  /** 随状态变化输出的一行终端日志。 */
  log?: { text: string; level?: 'info' | 'warn' | 'error' };
}

/** 子任务进度上报回调（并发阶段逐项推送）。 */
export type SubtaskReporter = (ev: SubtaskEvent) => void;

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
  stage: 'image' | 'video' | 'file' | 'ptt' | 'media' | 'record' | 'transcribe' | 'sticker';
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
function pushFailure(out: MediaFailure[] | undefined, f: MediaFailure): MediaFailure[] {
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
  kinds?: { image?: boolean; video?: boolean; file?: boolean },
  onSubtask?: SubtaskReporter,
): Promise<MediaStageResult> {
  const items = scan.found
    .map((ref, index) => ({ ref, key: String(index) }))
    .filter(({ ref }) => {
      if (!ref.path) return false;
      const dir = copyKindDir(ref.kind);
      if (!dir) return false;
      if (dir === MEDIA_SUBDIRS.image && kinds && kinds.image === false) return false;
      if (dir === MEDIA_SUBDIRS.video && kinds && kinds.video === false) return false;
      if (dir === MEDIA_SUBDIRS.file && kinds && kinds.file === false) return false;
      return true;
    });
  const result: MediaStageResult = { total: items.length, ok: 0, failed: 0 };
  if (items.length === 0) return result;

  // Pre-create the destination dirs once.
  const subdirs = new Set(items.map(({ ref }) => copyKindDir(ref.kind)!));
  await Promise.all([...subdirs].map((d) => mkdir(join(mediaRoot, d), { recursive: true })));

  let done = 0;
  await runWithConcurrency(items, concurrency, async ({ ref, key }) => {
    const dir = copyKindDir(ref.kind)!;
    const label = `${dir}/${ref.fileName}`;
    try {
      onSubtask?.({
        key,
        label,
        status: 'running',
        log: { text: `开始搬运 ${label}` },
      });
      await copyFile(ref.path!, join(mediaRoot, dir, ref.fileName));
      result.ok += 1;
      onSubtask?.({
        key,
        label,
        status: 'completed',
        log: { text: `已搬运 ${label}（${done + 1}/${items.length}）` },
      });
    } catch (e) {
      result.failed += 1;
      result.failures = pushFailure(result.failures, {
        stage: 'media',
        fileName: ref.fileName,
        error: e instanceof Error ? e.message : String(e),
      });
      const reason = e instanceof Error ? e.message : String(e);
      onSubtask?.({
        key,
        label,
        status: 'failed',
        note: reason,
        log: { text: `搬运失败 ${label}：${reason}`, level: 'warn' },
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
 * media/record/<stem>.wav. Missing-but-downloadable voice is fetched by
 * {@link downloadMissingVoices} (stage `ptt`) instead. Returns decode counts.
 */
export async function decodeFoundVoices(
  scan: MediaScanResult,
  mediaRoot: string,
  decodeSilk: DecodeSilk,
  onProgress?: StageProgress,
  concurrency = 4,
  onLog?: StageLog,
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
        onLog?.(`已解码 ${dropExt(ref.fileName)}.wav（${done + 1}/${items.length}）`);
      } else {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'record',
          fileName: ref.fileName,
          error: 'silk decode returned false',
        });
        onLog?.(`解码失败 ${ref.fileName}：silk decode returned false`, 'warn');
      }
    } catch (e) {
      result.failed += 1;
      result.failures = pushFailure(result.failures, {
        stage: 'record',
        fileName: ref.fileName,
        error: e instanceof Error ? e.message : String(e),
      });
      onLog?.(`解码异常 ${ref.fileName}：${e instanceof Error ? e.message : String(e)}`, 'warn');
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
 *
 * Clips that already carry a transcript on the element (wire tag 45923 — QQ's
 * own 转文字, or a previous WeQ run that wrote back) are reused as-is and never
 * re-recognized. `onTranscribed` persists a fresh result back onto the element
 * so the next export skips it too.
 */
export async function transcribeFoundVoices(
  scan: MediaScanResult,
  bundleDir: string,
  transcribe: TranscribeVoiceFn,
  onProgress?: StageProgress,
  concurrency = 2,
  onTranscribed?: (ref: MediaRef, text: string) => Promise<void>,
  onLog?: StageLog,
): Promise<MediaStageResult> {
  const voices = scan.found.filter((ref) => ref.kind === 'ptt');
  const transcripts: Record<string, string> = {};
  for (const ref of voices) {
    if (ref.transcript) transcripts[ref.fileName] = ref.transcript;
  }

  const items = voices.filter((ref) => ref.path && !ref.transcript);
  const cached = voices.length - items.length;
  const result: MediaStageResult = { total: voices.length, ok: cached, failed: 0 };

  const flush = async (): Promise<void> => {
    await writeFile(
      join(bundleDir, TRANSCRIPTS_FILE),
      JSON.stringify(transcripts, null, 2),
      'utf-8',
    );
  };
  if (items.length === 0) {
    await flush();
    onProgress?.(result.total, result.total);
    return result;
  }

  let done = cached;
  onProgress?.(done, result.total);
  await runWithConcurrency(items, concurrency, async (ref) => {
    try {
      const r = await transcribe(ref.path!);
      if (r.ok) {
        const text = r.text ?? '';
        transcripts[ref.fileName] = text;
        result.ok += 1;
        onLog?.(`已转写 ${ref.fileName}（${done}/${result.total}）`);
        // Best-effort back-write; a DB failure must not fail the stage.
        if (onTranscribed) await onTranscribed(ref, text).catch(() => undefined);
      } else {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'transcribe',
          fileName: ref.fileName,
          error: r.error ?? '转写失败',
        });
        onLog?.(`转写失败 ${ref.fileName}：${r.error ?? '转写失败'}`, 'warn');
      }
    } catch (e) {
      result.failed += 1;
      result.failures = pushFailure(result.failures, {
        stage: 'transcribe',
        fileName: ref.fileName,
        error: e instanceof Error ? e.message : String(e),
      });
      onLog?.(`转写异常 ${ref.fileName}：${e instanceof Error ? e.message : String(e)}`, 'warn');
    } finally {
      done += 1;
      onProgress?.(done, result.total);
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
  onLog?: StageLog,
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
        onLog?.(`已补全图片 ${ref.fileName}（${done + 1}/${items.length}）`);
      } else {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'image',
          fileName: ref.fileName,
          error: 'rkey download returned no cached path',
        });
        onLog?.(`补全图片失败 ${ref.fileName}：rkey download returned no cached path`, 'warn');
      }
    } catch (e) {
      result.failed += 1;
      result.failures = pushFailure(result.failures, {
        stage: 'image',
        fileName: ref.fileName,
        error: e instanceof Error ? e.message : String(e),
      });
      onLog?.(
        `补全图片异常 ${ref.fileName}：${e instanceof Error ? e.message : String(e)}`,
        'warn',
      );
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

/**
 * Re-read a ref's message and find the raw codec element it refers to.
 * Roam-backfilled messages (缺失消息补全) live only in the roam cache, so when
 * the local msg tables miss we fall back to the gap-history cache by msgId.
 */
async function findRawElement(
  ctx: UrlDownloadCtx,
  ref: MediaRef,
  kind: 'video' | 'file' | 'ptt',
): Promise<Element | null> {
  let raw: Awaited<ReturnType<MsgService['getRawElements']>>;
  try {
    raw = await ctx.msgs.getRawElements(BigInt(ref.msgId));
  } catch {
    raw = null;
  }
  if (raw) {
    const matches = raw.elements.filter((e) => e.kind === kind);
    // Match by stem when a message carries several of the same kind; else the one.
    const el =
      matches.find((e) => stemOf((e as { fileName?: string }).fileName ?? '') === ref.stem) ??
      matches[0] ??
      null;
    if (el) return el;
  }
  const gap = ctx.gapHistory;
  if (!gap) return null;
  const hit = await gap.findMediaElement(ref.msgId, kind, '');
  return hit ? (hit.element as unknown as Element) : null;
}

/** Shared context for the OIDB-backed video / file / ptt download stages. */
export interface UrlDownloadCtx {
  mediaUrl: MediaUrlService;
  msgs: Pick<MsgService, 'getRawElements'>;
  kind: ConvKind;
  /** Group code (群号) for group conversations; unused for c2c. */
  conv: string;
  /** 漫游缓存回退：缺失消息补全的消息不在本地 msg 表，需要按 msgId 定位媒体元素。 */
  gapHistory?: Pick<GapHistoryService, 'findMediaElement'>;
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
  onLog?: StageLog,
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
      const el = await findRawElement(ctx, ref, 'video');
      if (!el) {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'video',
          fileName: ref.fileName,
          error: `raw video element not found for msgId=${ref.msgId}`,
        });
        onLog?.(`补全视频失败 ${ref.fileName}：找不到原始视频元素`, 'warn');
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
          error: `OIDB resolve failed: ${e instanceof Error ? e.message : String(e)}`,
        });
        onLog?.(`补全视频失败 ${ref.fileName}：OIDB 解析失败`, 'warn');
        return;
      }
      if (!url) {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'video',
          fileName: ref.fileName,
          error: 'OIDB resolve returned empty url',
        });
        onLog?.(`补全视频失败 ${ref.fileName}：OIDB 返回空地址`, 'warn');
        return;
      }
      const outcome = await downloadUrlToFile(url, join(videoDir, ref.fileName));
      if (outcome.ok) {
        result.ok += 1;
        onLog?.(`已补全视频 ${ref.fileName}（${done + 1}/${items.length}）`);
      } else {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'video',
          fileName: ref.fileName,
          error: outcome.reason,
        });
        onLog?.(`补全视频失败 ${ref.fileName}：${outcome.reason}`, 'warn');
      }
    } catch (e) {
      result.failed += 1;
      result.failures = pushFailure(result.failures, {
        stage: 'video',
        fileName: ref.fileName,
        error: `unexpected: ${e instanceof Error ? e.message : String(e)}`,
      });
      onLog?.(
        `补全视频异常 ${ref.fileName}：${e instanceof Error ? e.message : String(e)}`,
        'warn',
      );
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
  onLog?: StageLog,
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
      const el = await findRawElement(ctx, ref, 'file');
      if (!el) {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'file',
          fileName: ref.fileName,
          error: `raw file element not found for msgId=${ref.msgId}`,
        });
        onLog?.(`补全文件失败 ${ref.fileName}：找不到原始文件元素`, 'warn');
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
          error: `OIDB resolve failed: ${e instanceof Error ? e.message : String(e)}`,
        });
        onLog?.(`补全文件失败 ${ref.fileName}：OIDB 解析失败`, 'warn');
        return;
      }
      if (!url) {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'file',
          fileName: ref.fileName,
          error: 'OIDB resolve returned empty url',
        });
        onLog?.(`补全文件失败 ${ref.fileName}：OIDB 返回空地址`, 'warn');
        return;
      }
      const outcome = await downloadUrlToFile(url, join(fileDir, ref.fileName));
      if (outcome.ok) {
        result.ok += 1;
        onLog?.(`已补全文件 ${ref.fileName}（${done + 1}/${items.length}）`);
      } else {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'file',
          fileName: ref.fileName,
          error: outcome.reason,
        });
        onLog?.(`补全文件失败 ${ref.fileName}：${outcome.reason}`, 'warn');
      }
    } catch (e) {
      result.failed += 1;
      result.failures = pushFailure(result.failures, {
        stage: 'file',
        fileName: ref.fileName,
        error: `unexpected: ${e instanceof Error ? e.message : String(e)}`,
      });
      onLog?.(
        `补全文件异常 ${ref.fileName}：${e instanceof Error ? e.message : String(e)}`,
        'warn',
      );
    } finally {
      done += 1;
      onProgress?.(done, items.length);
    }
  });
  return result;
}

/**
 * Stage `ptt`: resolve each missing voice's download URL via OIDB (needs an
 * online QQ), fetch the silk, then SILK-decode it into media/record/<stem>.wav
 * — the same path locally-found voices land on, so the message file's
 * `media/record/…` references resolve either way. The fetched silk is kept only
 * transiently and removed after decoding.
 */
export async function downloadMissingVoices(
  scan: MediaScanResult,
  mediaRoot: string,
  ctx: UrlDownloadCtx,
  decodeSilk: DecodeSilk,
  onProgress?: StageProgress,
  concurrency = 3,
  onLog?: StageLog,
): Promise<MediaStageResult> {
  const items = scan.downloadList.filter((r) => r.kind === 'ptt');
  const result: MediaStageResult = { total: items.length, ok: 0, failed: 0 };
  if (items.length === 0) return result;
  const recordDir = join(mediaRoot, MEDIA_SUBDIRS.record);
  await mkdir(recordDir, { recursive: true });
  const groupId = ctx.kind === 'group' ? Number(ctx.conv) : 0;

  let done = 0;
  await runWithConcurrency(items, concurrency, async (ref) => {
    const tmpSilk = join(recordDir, `${dropExt(ref.fileName)}.silk.tmp`);
    try {
      const el = await findRawElement(ctx, ref, 'ptt');
      if (!el) {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'ptt',
          fileName: ref.fileName,
          error: `raw ptt element not found for msgId=${ref.msgId}`,
        });
        onLog?.(`补全语音失败 ${ref.fileName}：找不到原始语音元素`, 'warn');
        return;
      }
      const element = el as unknown as MediaElement;
      let url: string;
      try {
        url =
          ctx.kind === 'group'
            ? await ctx.mediaUrl.getGroupPttUrlFromElement(groupId, element)
            : await ctx.mediaUrl.getPrivatePttUrlFromElement(element);
      } catch (e) {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'ptt',
          fileName: ref.fileName,
          error: `OIDB resolve failed: ${e instanceof Error ? e.message : String(e)}`,
        });
        onLog?.(`补全语音失败 ${ref.fileName}：OIDB 解析失败`, 'warn');
        return;
      }
      if (!url) {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'ptt',
          fileName: ref.fileName,
          error: 'OIDB resolve returned empty url',
        });
        onLog?.(`补全语音失败 ${ref.fileName}：OIDB 返回空地址`, 'warn');
        return;
      }
      const outcome = await downloadUrlToFile(url, tmpSilk);
      if (!outcome.ok) {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'ptt',
          fileName: ref.fileName,
          error: outcome.reason,
        });
        onLog?.(`补全语音失败 ${ref.fileName}：${outcome.reason}`, 'warn');
        return;
      }
      const dest = join(recordDir, `${dropExt(ref.fileName)}.wav`);
      const ok = await decodeSilk(tmpSilk, dest);
      if (ok) {
        result.ok += 1;
        onLog?.(`已补全语音 ${dropExt(ref.fileName)}.wav（${done + 1}/${items.length}）`);
      } else {
        result.failed += 1;
        result.failures = pushFailure(result.failures, {
          stage: 'ptt',
          fileName: ref.fileName,
          error: 'silk decode returned false',
        });
        onLog?.(`补全语音解码失败 ${ref.fileName}：silk decode returned false`, 'warn');
      }
    } catch (e) {
      result.failed += 1;
      result.failures = pushFailure(result.failures, {
        stage: 'ptt',
        fileName: ref.fileName,
        error: `unexpected: ${e instanceof Error ? e.message : String(e)}`,
      });
      onLog?.(
        `补全语音异常 ${ref.fileName}：${e instanceof Error ? e.message : String(e)}`,
        'warn',
      );
    } finally {
      try {
        await unlink(tmpSilk);
      } catch {
        /* already gone / never written — nothing to clean */
      }
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
