/**
 * Media scanner — for a group export, find which referenced media files exist
 * on disk and which are missing (the rkey-download candidates).
 *
 * Speed strategy: instead of searching the filesystem once *per referenced
 * file* (N stat/readdir storms, with the same directory re-read many times — what
 * {@link FileSearchService} does for single-file lookups), we:
 *
 *   1. one DB pass to collect every media reference + which months they span;
 *   2. build an in-memory `stem → path` index by reading each relevant
 *      directory exactly once (concurrently, withFileTypes so no extra stat);
 *   3. match every reference against the index in O(1).
 *
 * So disk I/O is bounded by the number of directories, NOT the number of
 * referenced files — and each directory is touched at most once.
 *
 * Month scoping: pic/video/ptt files bucket by `<YYYY-MM>`, so we only index the
 * months the group actually spans (±1 for clock skew at month edges). Received
 * emoji are content-hashed and reused across months, so those index all months.
 * Files (`File/Ori`) have no month buckets — indexed by a recursive walk.
 */

import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { MsgService } from '../msg';
import type { RenderElement } from '../msg_view';
import { iterateGroupMessages } from './message_source';

export type MediaKind = 'pic' | 'video' | 'ptt' | 'emoji' | 'file';

const SCAN_KINDS: MediaKind[] = ['pic', 'video', 'ptt', 'emoji', 'file'];
/** Kinds whose files live in `<YYYY-MM>/Ori` month buckets. */
const MONTH_KINDS: MediaKind[] = ['pic', 'video', 'ptt'];

/** Absolute base directories for each media kind under an account. */
export interface MediaDirs {
  pic: string;
  video: string;
  ptt: string;
  /** `Emoji/emoji-recv` (received animated emoji). */
  emoji: string;
  file: string;
}

/** Build the media dirs from an account's user-data directory (`…/<uin>`). */
export function mediaDirsFromAccountDir(accountDir: string): MediaDirs {
  const data = join(accountDir, 'nt_qq', 'nt_data');
  return {
    pic: join(data, 'Pic'),
    video: join(data, 'Video'),
    ptt: join(data, 'Ptt'),
    emoji: join(data, 'Emoji', 'emoji-recv'),
    file: join(data, 'File'),
  };
}

/** One referenced media file. */
export interface MediaRef {
  msgId: string;
  msgSeq: string;
  sendTime: number;
  kind: MediaKind;
  /** Filename as stored on the element (with extension). */
  fileName: string;
  /** Lowercased stem (no extension) — the index key. */
  stem: string;
  /** CDN download token (empty for `file`, which carries none in the render view). */
  fileToken: string;
  /** Upload time (unix seconds), as stored on the element. */
  uploadTime: number;
  /** Upload timestamp (unix seconds), as stored on the element. */
  uploadTimestamp: number;
  /** File TTL in seconds (0 when unknown, e.g. `file`). */
  fileTTL: number;
  /**
   * Computed CDN expiry, unix seconds. 0 means "unknown" (no TTL on the
   * element — can't prove expiry, so treated as still-downloadable).
   */
  expiresAt: number;
  /** True only when {@link expiresAt} is known and in the past. */
  expired: boolean;
  /** Resolved absolute path once matched; null while missing. */
  path: string | null;
}

export interface KindCounts {
  /** Raw element references of this kind. */
  refs: number;
  /** Distinct files (deduped by stem). */
  unique: number;
  found: number;
  missing: number;
  /** Of the missing, how many are past their CDN TTL (undownloadable). */
  expired: number;
  /** Of the missing, how many are still downloadable (not proven expired). */
  downloadable: number;
}

export interface MediaScanResult {
  totalRefs: number;
  uniqueFiles: number;
  foundFiles: number;
  missingFiles: number;
  /** Of the missing, how many are past their CDN TTL (undownloadable). */
  expiredFiles: number;
  /** Of the missing, how many are still downloadable (the real work-list size). */
  downloadableFiles: number;
  byKind: Record<MediaKind, KindCounts>;
  /** Deduped, one entry per missing (kind, stem) — includes expired ones. */
  missing: MediaRef[];
  /** Missing AND still downloadable (expired excluded). The rkey-download work-list. */
  downloadList: MediaRef[];
  /** ms spent paging messages out of the DB. */
  collectMs: number;
  /** ms spent building the on-disk index. */
  indexBuildMs: number;
  /** ms spent matching references against the index. */
  matchMs: number;
  /** total ms. */
  durationMs: number;
  /** directories read while indexing. */
  indexedDirs: number;
  /** files indexed. */
  indexedFiles: number;
}

export interface ScanOptions {
  pageSize?: number;
  /** Concurrency for index-building readdir calls (default 24). */
  concurrency?: number;
}

/** Drop a trailing extension and lowercase: `AB.MP4` → `ab`. */
function stemOf(filename: string): string {
  const ext = extname(filename);
  const base = ext ? filename.slice(0, -ext.length) : filename;
  return base.toLowerCase();
}

/** `YYYY-MM` for a unix-seconds timestamp. */
function monthOf(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** `YYYY-MM` shifted by `delta` months. */
function shiftMonth(unixSec: number, delta: number): string {
  const d = new Date(unixSec * 1000);
  d.setMonth(d.getMonth() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) break;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}

/**
 * Compute a file's CDN expiry (unix seconds), or 0 when unknown.
 *
 * Video carries an absolute `expireTimestamp` — authoritative when present.
 * Otherwise the window is `uploadBase + fileTTL`, where the base is the
 * unix-seconds upload time (`uploadTimestamp` preferred, `uploadTime` as
 * fallback). No TTL → 0 (can't prove expiry).
 */
function computeExpiry(
  kind: MediaKind,
  uploadTime: number,
  uploadTimestamp: number,
  fileTTL: number,
  expireTimestamp: number,
): number {
  if (kind === 'video' && expireTimestamp > 0) return expireTimestamp;
  const base = uploadTimestamp > 0 ? uploadTimestamp : uploadTime;
  if (base > 0 && fileTTL > 0) return base + fileTTL;
  return 0;
}

/** Pull every media reference out of one message's elements. */
function collectFromElements(
  els: RenderElement[],
  msgId: string,
  msgSeq: string,
  sendTime: number,
  out: MediaRef[],
): void {
  for (const el of els) {
    let kind: MediaKind | null = null;
    let fileName = '';
    let fileToken = '';
    let uploadTime = 0;
    let uploadTimestamp = 0;
    let fileTTL = 0;
    let expireTimestamp = 0;
    switch (el.type) {
      case 'pic':
        kind = el.data.subType === 1 ? 'emoji' : 'pic';
        fileName = el.data.fileName;
        fileToken = el.data.fileToken;
        uploadTime = el.data.uploadTime;
        uploadTimestamp = el.data.uploadTimestamp;
        fileTTL = el.data.fileTTL;
        break;
      case 'video':
        kind = 'video';
        fileName = el.data.fileName;
        fileToken = el.data.fileToken;
        uploadTime = el.data.uploadTime;
        uploadTimestamp = el.data.uploadTimestamp;
        fileTTL = el.data.fileTTL;
        expireTimestamp = el.data.expireTimestamp;
        break;
      case 'ptt':
        kind = 'ptt';
        fileName = el.data.fileName;
        fileToken = el.data.fileToken;
        uploadTime = el.data.uploadTime;
        uploadTimestamp = el.data.uploadTimestamp;
        fileTTL = el.data.fileTTL;
        break;
      case 'file':
        kind = 'file';
        fileName = el.data.fileName;
        break;
      default:
        continue;
    }
    if (!kind || !fileName) continue;
    out.push({
      msgId,
      msgSeq,
      sendTime,
      kind,
      fileName,
      stem: stemOf(fileName),
      fileToken,
      uploadTime,
      uploadTimestamp,
      fileTTL,
      expiresAt: computeExpiry(kind, uploadTime, uploadTimestamp, fileTTL, expireTimestamp),
      expired: false,
      path: null,
    });
  }
}

/** Directory names directly under `base` (one readdir, no stat). */
async function listSubdirs(base: string): Promise<string[]> {
  try {
    const entries = await readdir(base, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Recursively collect files under `dir`, calling `onFile` for each. */
async function walkFiles(
  dir: string,
  onFile: (fullPath: string, name: string) => void,
  onDir: () => void,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  onDir();
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walkFiles(full, onFile, onDir);
    else if (e.isFile()) onFile(full, e.name);
  }
}

/**
 * Scan a group's media against the local disk. Returns counts + the missing
 * work-list. Pure measurement — does not download or copy anything.
 */
export async function scanGroupMedia(
  msgs: MsgService,
  groupCode: string,
  dirs: MediaDirs,
  opts: ScanOptions = {},
): Promise<MediaScanResult> {
  const startedAt = Date.now();
  const concurrency = opts.concurrency ?? 24;

  // ---- 1. collect references (one DB pass) ----
  const t0 = Date.now();
  const rawRefs: MediaRef[] = [];
  for await (const m of iterateGroupMessages(msgs, groupCode, { pageSize: opts.pageSize })) {
    collectFromElements(
      m.elements,
      m.msgId.toString(),
      m.msgSeq.toString(),
      Number(m.sendTime),
      rawRefs,
    );
  }
  const collectMs = Date.now() - t0;

  // Dedupe by (kind, stem); keep the first occurrence as the representative.
  const uniqueByKey = new Map<string, MediaRef>();
  const months: Record<MediaKind, Set<string>> = {
    pic: new Set(), video: new Set(), ptt: new Set(), emoji: new Set(), file: new Set(),
  };
  for (const ref of rawRefs) {
    const key = `${ref.kind}:${ref.stem}`;
    if (!uniqueByKey.has(key)) uniqueByKey.set(key, ref);
    if (MONTH_KINDS.includes(ref.kind)) {
      months[ref.kind].add(monthOf(ref.sendTime));
      months[ref.kind].add(shiftMonth(ref.sendTime, -1));
      months[ref.kind].add(shiftMonth(ref.sendTime, 1));
    }
  }

  // ---- 2. build the on-disk index (readdir each relevant dir once) ----
  const t1 = Date.now();
  const index: Record<MediaKind, Map<string, string>> = {
    pic: new Map(), video: new Map(), ptt: new Map(), emoji: new Map(), file: new Map(),
  };
  let indexedDirs = 0;
  let indexedFiles = 0;

  // Month-bucketed kinds: only the spanned months, Ori only (the source).
  const dirTasks: Array<{ kind: MediaKind; dir: string }> = [];
  for (const kind of MONTH_KINDS) {
    for (const month of months[kind]) {
      dirTasks.push({ kind, dir: join(dirs[kind], month, 'Ori') });
    }
  }
  // Emoji: all months, both Ori and Thumb (display can be in either).
  for (const month of await listSubdirs(dirs.emoji)) {
    dirTasks.push({ kind: 'emoji', dir: join(dirs.emoji, month, 'Ori') });
    dirTasks.push({ kind: 'emoji', dir: join(dirs.emoji, month, 'Thumb') });
  }

  await mapLimit(dirTasks, concurrency, async (task) => {
    let entries;
    try {
      entries = await readdir(task.dir, { withFileTypes: true });
    } catch {
      return;
    }
    indexedDirs += 1;
    const map = index[task.kind];
    for (const e of entries) {
      if (!e.isFile()) continue;
      indexedFiles += 1;
      const stem = stemOf(e.name);
      if (!map.has(stem)) map.set(stem, join(task.dir, e.name));
    }
  });

  // Files: recursive walk of File/Ori (no month buckets).
  await walkFiles(
    join(dirs.file, 'Ori'),
    (full, name) => {
      indexedFiles += 1;
      const stem = stemOf(name);
      if (!index.file.has(stem)) index.file.set(stem, full);
    },
    () => {
      indexedDirs += 1;
    },
  );
  const indexBuildMs = Date.now() - t1;

  // ---- 3. match (+ TTL classification of the misses) ----
  const t2 = Date.now();
  const nowSec = Math.floor(Date.now() / 1000);
  const byKind: Record<MediaKind, KindCounts> = {
    pic: { refs: 0, unique: 0, found: 0, missing: 0, expired: 0, downloadable: 0 },
    video: { refs: 0, unique: 0, found: 0, missing: 0, expired: 0, downloadable: 0 },
    ptt: { refs: 0, unique: 0, found: 0, missing: 0, expired: 0, downloadable: 0 },
    emoji: { refs: 0, unique: 0, found: 0, missing: 0, expired: 0, downloadable: 0 },
    file: { refs: 0, unique: 0, found: 0, missing: 0, expired: 0, downloadable: 0 },
  };
  for (const ref of rawRefs) byKind[ref.kind].refs += 1;

  const missing: MediaRef[] = [];
  const downloadList: MediaRef[] = [];
  for (const ref of uniqueByKey.values()) {
    const counts = byKind[ref.kind];
    counts.unique += 1;
    const hit = index[ref.kind].get(ref.stem);
    if (hit) {
      counts.found += 1;
      ref.path = hit;
      continue;
    }
    counts.missing += 1;
    ref.expired = ref.expiresAt > 0 && nowSec > ref.expiresAt;
    missing.push(ref);
    if (ref.expired) {
      counts.expired += 1;
    } else {
      counts.downloadable += 1;
      downloadList.push(ref);
    }
  }
  const matchMs = Date.now() - t2;

  let uniqueFiles = 0;
  let foundFiles = 0;
  for (const kind of SCAN_KINDS) {
    uniqueFiles += byKind[kind].unique;
    foundFiles += byKind[kind].found;
  }

  return {
    totalRefs: rawRefs.length,
    uniqueFiles,
    foundFiles,
    missingFiles: missing.length,
    expiredFiles: missing.length - downloadList.length,
    downloadableFiles: downloadList.length,
    byKind,
    missing,
    downloadList,
    collectMs,
    indexBuildMs,
    matchMs,
    durationMs: Date.now() - startedAt,
    indexedDirs,
    indexedFiles,
  };
}
