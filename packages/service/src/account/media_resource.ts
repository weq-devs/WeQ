/**
 * Local media resource browser for the current QQ account.
 *
 * Four `nt_data` trees, two structural shapes, all surfaced by this one service:
 *
 *   1. **图片墙 / QQ空间缓存** — `nt_data/PhotoWall` and `nt_data/Qzone`. Both are
 *      FLAT hash caches bucketed by the first two hex chars of the file name, one
 *      un-suffixed image file per hash (no extension), e.g.
 *        nt_data/PhotoWall/02/026a14b1…f0   ← a 100×100 wall thumbnail (JPEG)
 *        nt_data/Qzone/01/012f1596…a4       ← a Qzone browse-cache image (PNG)
 *      Rendered as a simple grid; {@link listFlat} pages over the buckets.
 *
 *   2. **图片 / 视频** — `nt_data/Pic` and `nt_data/Video`. Both are bucketed by
 *      month with an `Ori/` (original) + `Thumb/` (preview) split, e.g.
 *        nt_data/Pic/2025-07/Ori/001c2de1….jpg      ← original image
 *        nt_data/Pic/2025-07/Thumb/001c2de1…_0.jpg  ← thumbnail(s) (_0 / _720 …)
 *        nt_data/Video/2026-07/Ori/036cc445….mp4    ← original video
 *        nt_data/Video/2026-07/Thumb/036cc445…_0.png ← cover frame
 *      The `Ori` + `Thumb` files of one hash are the SAME item, so {@link listMonth}
 *      MERGES them into a single {@link MonthMediaEntry} carrying which variants
 *      exist (like the avatar browser's 大图/缩略图 badge). For video this lets the
 *      UI show the cover, flag whether the original mp4 is on disk, and (when it
 *      is) open it in a player.
 *
 * This service only enumerates + resolves paths inside the account's own media
 * trees; bytes stream to the renderer via `weq-media://localmedia`, which
 * re-validates every path through {@link MediaResourceService.resolveFile}.
 * Nothing here decrypts.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';

/** Which media tree to browse. */
export type MediaResourceKind = 'photoWall' | 'qzone' | 'pic' | 'video' | 'ptt';

/** The flat, hex-bucketed kinds (one image file per hash). */
const FLAT_KINDS: readonly MediaResourceKind[] = ['photoWall', 'qzone'];
/** The month-bucketed kinds (Ori + Thumb split). */
const MONTH_KINDS: readonly MediaResourceKind[] = ['pic', 'video'];

/** One file in a flat hash cache (图片墙 / QQ空间). */
export interface FlatMediaEntry {
  /** Path relative to the tree root (`<bucket>/<name>`), unique + used as media rel. */
  rel: string;
  /** Bare file name (the hash, usually no extension). */
  name: string;
  /** Hash bucket (first two hex chars). */
  bucket: string;
  size: number;
  mtimeMs: number;
}

/** One merged item in a month cache (图片 / 视频): its Ori + Thumb files. */
export interface MonthMediaEntry {
  /** Shared hash (the `Ori` basename without extension; `Thumb` drops its `_<n>`). */
  hash: string;
  /** Month bucket (`YYYY-MM`). */
  month: string;
  /** True when an original file exists under `Ori/`. */
  hasOri: boolean;
  /** True when a preview exists under `Thumb/`. */
  hasThumb: boolean;
  /** Media rel of the original (`<month>/Ori/<name>`), or null when absent. */
  oriRel: string | null;
  /** Media rel of the preview (`<month>/Thumb/<name>`), or null when absent. */
  thumbRel: string | null;
  /** Byte size of the original, or 0 when absent. */
  oriBytes: number;
  /** Byte size of the chosen preview, or 0 when absent. */
  thumbBytes: number;
  /** Lower-case original extension without the dot (`''` when unknown). */
  ext: string;
  /** Newest mtime (ms) across the item's files — drives newest-first ordering. */
  mtimeMs: number;
}

/** A page of flat entries. */
export interface FlatMediaPage {
  entries: FlatMediaEntry[];
  /** Opaque cursor for the next page, or null when exhausted. */
  nextCursor: string | null;
}

/** A page of merged month entries. */
export interface MonthMediaPage {
  entries: MonthMediaEntry[];
  nextCursor: string | null;
}

/** One voice clip in the `Ptt` cache (`<month>/Ori/<hash>.amr`, SILK bytes). */
export interface VoiceMediaEntry {
  /** Media rel of the clip (`<month>/Ori/<name>`), used to stream + decode it. */
  rel: string;
  /** Bare file name (`<hash>.amr`). */
  name: string;
  /** Hash (file name without extension). */
  hash: string;
  /** Month bucket (`YYYY-MM`). */
  month: string;
  /** Byte size of the SILK file on disk. */
  bytes: number;
  mtimeMs: number;
}

/** A page of voice clips. */
export interface VoiceMediaPage {
  entries: VoiceMediaEntry[];
  nextCursor: string | null;
}

/** Which top-level `nt_data` tree the overall analysis scans. */
export type ResourceTreeKey =
  | 'avatar'
  | 'emoji'
  | 'pic'
  | 'video'
  | 'ptt'
  | 'photoWall'
  | 'qzone'
  | 'file';

/** `nt_data` sub-directory backing each analysis tree. */
const RESOURCE_TREE_DIRS: Record<ResourceTreeKey, string> = {
  avatar: 'avatar',
  emoji: 'Emoji',
  pic: 'Pic',
  video: 'Video',
  ptt: 'Ptt',
  photoWall: 'PhotoWall',
  qzone: 'Qzone',
  file: 'File',
};

/** A count + byte total (one bucket in {@link ResourceStat}). */
export interface ResourceBucket {
  files: number;
  bytes: number;
}

/** Aggregate stats for one scanned resource tree. */
export interface ResourceStat {
  key: ResourceTreeKey;
  /** False when the tree's directory doesn't exist for this account. */
  present: boolean;
  files: number;
  bytes: number;
  /** Files/bytes bucketed by mtime month (`YYYY-MM`). */
  byMonth: Record<string, ResourceBucket>;
  /** Original files (path under an `Ori`/`OriTemp` dir). */
  ori: ResourceBucket;
  /** Thumbnail/preview files (path under a `Thumb` dir). */
  thumb: ResourceBucket;
  /** Everything else (flat caches, avatars, etc.). */
  other: ResourceBucket;
}

const DEFAULT_PAGE = 120;
const MAX_PAGE = 500;

/**
 * Accumulator while merging one month's `Ori`/`Thumb` files by hash. Carries the
 * bare file names (rel paths are built once the month is known) plus `thumbRank`
 * so a lower-numbered thumb (`_0` over `_720`) can replace an earlier pick.
 */
interface MonthAcc {
  hasOri: boolean;
  hasThumb: boolean;
  oriName: string;
  thumbName: string;
  thumbRank: number;
  oriBytes: number;
  thumbBytes: number;
  ext: string;
  mtimeMs: number;
}

export class MediaResourceService {
  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
  ) {}

  /** Absolute root dir for a media kind, or null when the account has none. */
  private rootFor(kind: MediaResourceKind): string | null {
    const uin = this.session.context.uin;
    switch (kind) {
      case 'pic':
        return this.platform.picDir(uin);
      case 'video':
        return this.platform.videoDir(uin);
      case 'ptt':
        return this.platform.pttDir(uin);
      case 'photoWall': {
        const data = this.platform.ntDataDir(uin);
        return data ? join(data, 'PhotoWall') : null;
      }
      case 'qzone': {
        const data = this.platform.ntDataDir(uin);
        return data ? join(data, 'Qzone') : null;
      }
      default:
        return null;
    }
  }

  // ── 图片墙 / QQ空间 (flat hex buckets) ───────────────────────────────────────

  /**
   * One page of flat entries for a hex-bucketed kind. Buckets are walked in name
   * order; the cursor is `"<bucketIndex>:<fileIndex>"` so paging is stable and
   * resumable without holding the whole tree in memory.
   */
  async listFlat(
    kind: MediaResourceKind,
    opts: { limit?: number; cursor?: string | null } = {},
  ): Promise<FlatMediaPage> {
    if (!FLAT_KINDS.includes(kind)) return { entries: [], nextCursor: null };
    const root = this.rootFor(kind);
    if (!root) return { entries: [], nextCursor: null };
    const buckets = await this.readSubdirs(root);
    if (buckets === null) return { entries: [], nextCursor: null };

    const cap = clampInt(opts.limit ?? DEFAULT_PAGE, 1, MAX_PAGE);
    const start = parseCursor(opts.cursor ?? null);

    const entries: FlatMediaEntry[] = [];
    let bucketIndex = start.a;
    let fileIndex = start.b;

    while (bucketIndex < buckets.length && entries.length < cap) {
      const bucket = buckets[bucketIndex]!;
      const files = await this.readFiles(join(root, bucket));
      // Stable within a bucket: sort by name so a cursor points at the same file
      // across calls (readdir order is not guaranteed stable).
      files.sort((x, y) => x.name.localeCompare(y.name));

      for (; fileIndex < files.length && entries.length < cap; fileIndex += 1) {
        const f = files[fileIndex]!;
        entries.push({
          rel: `${bucket}/${f.name}`,
          name: f.name,
          bucket,
          size: f.size,
          mtimeMs: f.mtimeMs,
        });
      }

      if (fileIndex < files.length) {
        return { entries, nextCursor: `${bucketIndex}:${fileIndex}` };
      }
      bucketIndex += 1;
      fileIndex = 0;
    }

    const done = bucketIndex >= buckets.length;
    return { entries, nextCursor: done ? null : `${bucketIndex}:${fileIndex}` };
  }

  // ── 图片 / 视频 (month buckets, Ori + Thumb) ─────────────────────────────────

  /**
   * One page of MERGED month entries for `pic` / `video`. Months are walked
   * newest-first (`2026-07` before `2025-01`); within a month, items are ordered
   * newest mtime first (hash tie-break) for a stable, resumable cursor
   * `"<monthIndex>:<entryIndex>"`.
   */
  async listMonth(
    kind: MediaResourceKind,
    opts: { limit?: number; cursor?: string | null } = {},
  ): Promise<MonthMediaPage> {
    if (!MONTH_KINDS.includes(kind)) return { entries: [], nextCursor: null };
    const root = this.rootFor(kind);
    if (!root) return { entries: [], nextCursor: null };
    const months = await this.readMonths(root);
    if (months === null) return { entries: [], nextCursor: null };

    const cap = clampInt(opts.limit ?? DEFAULT_PAGE, 1, MAX_PAGE);
    const start = parseCursor(opts.cursor ?? null);

    const entries: MonthMediaEntry[] = [];
    let monthIndex = start.a;
    let entryIndex = start.b;

    while (monthIndex < months.length && entries.length < cap) {
      const month = months[monthIndex]!;
      // Newest first within a month, hash as a stable tie-break.
      const sorted = (await this.mergeMonth(root, month)).sort(
        (x, y) => y.mtimeMs - x.mtimeMs || x.hash.localeCompare(y.hash),
      );

      for (; entryIndex < sorted.length && entries.length < cap; entryIndex += 1) {
        entries.push(sorted[entryIndex]!);
      }

      if (entryIndex < sorted.length) {
        return { entries, nextCursor: `${monthIndex}:${entryIndex}` };
      }
      monthIndex += 1;
      entryIndex = 0;
    }

    const done = monthIndex >= months.length;
    return { entries, nextCursor: done ? null : `${monthIndex}:${entryIndex}` };
  }

  // ── 语音 (Ptt: month buckets, Ori only) ──────────────────────────────────────

  /**
   * One page of voice clips from the `Ptt` cache. Unlike Pic/Video, Ptt has no
   * `Thumb` split — each item is a single SILK file under `<month>/Ori/`. Months
   * walk newest-first; within a month, clips are newest mtime first, so the
   * cursor `"<monthIndex>:<fileIndex>"` stays stable and resumable.
   */
  async listVoice(opts: { limit?: number; cursor?: string | null } = {}): Promise<VoiceMediaPage> {
    const root = this.rootFor('ptt');
    if (!root) return { entries: [], nextCursor: null };
    const months = await this.readMonths(root);
    if (months === null) return { entries: [], nextCursor: null };

    const cap = clampInt(opts.limit ?? DEFAULT_PAGE, 1, MAX_PAGE);
    const start = parseCursor(opts.cursor ?? null);

    const entries: VoiceMediaEntry[] = [];
    let monthIndex = start.a;
    let fileIndex = start.b;

    while (monthIndex < months.length && entries.length < cap) {
      const month = months[monthIndex]!;
      const files = (await this.readFiles(join(root, month, 'Ori'))).sort(
        (x, y) => y.mtimeMs - x.mtimeMs || x.name.localeCompare(y.name),
      );

      for (; fileIndex < files.length && entries.length < cap; fileIndex += 1) {
        const f = files[fileIndex]!;
        const ext = extname(f.name);
        entries.push({
          rel: `${month}/Ori/${f.name}`,
          name: f.name,
          hash: ext ? f.name.slice(0, -ext.length) : f.name,
          month,
          bytes: f.size,
          mtimeMs: f.mtimeMs,
        });
      }

      if (fileIndex < files.length) {
        return { entries, nextCursor: `${monthIndex}:${fileIndex}` };
      }
      monthIndex += 1;
      fileIndex = 0;
    }

    const done = monthIndex >= months.length;
    return { entries, nextCursor: done ? null : `${monthIndex}:${fileIndex}` };
  }

  // ── 整体分析 (recursive tree scan) ────────────────────────────────────────────

  /**
   * Recursively walk one top-level `nt_data` resource tree and aggregate its
   * files: total count/bytes, a per-month (by mtime) breakdown, and an
   * original-vs-thumbnail split (a path segment named `Thumb` → preview, `Ori`/
   * `OriTemp` → original, else `other`). This is the slow part of the overall
   * analysis — every file is `stat`-ed for size — so the UI scans one tree per
   * call and shows progress. Returns `present: false` when the tree is absent.
   */
  async analyzeTree(key: ResourceTreeKey): Promise<ResourceStat> {
    const agg: ResourceStat = {
      key,
      present: false,
      files: 0,
      bytes: 0,
      byMonth: {},
      ori: { files: 0, bytes: 0 },
      thumb: { files: 0, bytes: 0 },
      other: { files: 0, bytes: 0 },
    };

    const dataDir = this.platform.ntDataDir(this.session.context.uin);
    if (!dataDir) return agg;
    const root = join(dataDir, RESOURCE_TREE_DIRS[key]);
    const base = resolve(root);

    // Iterative DFS over a stack of dirs — bounds concurrency to one dir's
    // fan-out (Promise.all over its files) instead of the whole tree at once.
    const stack: string[] = [base];
    let sawDir = false;
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let dirents: import('node:fs').Dirent[];
      try {
        dirents = await readdir(dir, { withFileTypes: true });
        sawDir = true;
      } catch {
        continue; // vanished / unreadable
      }
      const files: string[] = [];
      for (const ent of dirents) {
        if (ent.isDirectory()) stack.push(join(dir, ent.name));
        else if (ent.isFile()) files.push(join(dir, ent.name));
      }
      await Promise.all(
        files.map(async (abs) => {
          let st: import('node:fs').Stats;
          try {
            st = await stat(abs);
          } catch {
            return; // vanished between readdir and stat
          }
          agg.files += 1;
          agg.bytes += st.size;

          const bucket = variantBucket(abs.slice(base.length));
          const target = agg[bucket];
          target.files += 1;
          target.bytes += st.size;

          const month = monthKey(st.mtimeMs);
          let m = agg.byMonth[month];
          if (!m) {
            m = { files: 0, bytes: 0 };
            agg.byMonth[month] = m;
          }
          m.files += 1;
          m.bytes += st.size;
        }),
      );
    }
    agg.present = sawDir;
    return agg;
  }

  // ── media protocol resolution ────────────────────────────────────────────────

  /**
   * Resolve the absolute path of one media file from its `rel` (relative to the
   * kind's root), or null if it isn't on disk. The resolved path is re-checked to
   * sit inside the root, so a crafted `rel` (`..`) can't escape the media tree.
   */
  async resolveFile(kind: string, rel: string): Promise<string | null> {
    if (!isKind(kind) || !rel) return null;
    const root = this.rootFor(kind);
    if (!root) return null;
    const base = resolve(root);
    const abs = resolve(join(root, rel));
    if (abs !== base && !abs.startsWith(base + sep)) return null;
    try {
      const st = await stat(abs);
      if (st.isFile()) return abs;
    } catch {
      /* not on disk */
    }
    return null;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Immediate sub-directory names (sorted), or null when the dir is absent. */
  private async readSubdirs(dir: string): Promise<string[] | null> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  }

  /** `YYYY-MM` sub-dirs of a month tree, NEWEST first, or null when absent. */
  private async readMonths(root: string): Promise<string[] | null> {
    const subs = await this.readSubdirs(root);
    if (subs === null) return null;
    return subs
      .filter((n) => /^\d{4}-\d{2}$/.test(n))
      .sort((a, b) => b.localeCompare(a));
  }

  /** File entries (name + size + mtime) directly under a dir. */
  private async readFiles(
    dir: string,
  ): Promise<Array<{ name: string; size: number; mtimeMs: number }>> {
    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: Array<{ name: string; size: number; mtimeMs: number }> = [];
    await Promise.all(
      dirents.map(async (ent) => {
        if (!ent.isFile()) return;
        try {
          const st = await stat(join(dir, ent.name));
          out.push({ name: ent.name, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          /* vanished between readdir and stat */
        }
      }),
    );
    return out;
  }

  /** Merge one month's `Ori/` + `Thumb/` files into merged entries (rel built here). */
  private async mergeMonth(root: string, month: string): Promise<MonthMediaEntry[]> {
    const out = new Map<string, MonthAcc>();
    const get = (hash: string): MonthAcc => {
      let acc = out.get(hash);
      if (!acc) {
        acc = {
          hasOri: false,
          hasThumb: false,
          oriName: '',
          thumbName: '',
          thumbRank: Number.POSITIVE_INFINITY,
          oriBytes: 0,
          thumbBytes: 0,
          ext: '',
          mtimeMs: 0,
        };
        out.set(hash, acc);
      }
      return acc;
    };

    // Originals: `<hash>.<ext>` → hash is the basename without extension.
    for (const f of await this.readFiles(join(root, month, 'Ori'))) {
      const ext = extname(f.name).toLowerCase().replace(/^\./, '');
      const hash = ext ? f.name.slice(0, -(ext.length + 1)) : f.name;
      if (!hash) continue;
      const acc = get(hash);
      acc.hasOri = true;
      acc.oriName = f.name;
      acc.oriBytes = f.size;
      acc.ext = ext;
      if (f.mtimeMs > acc.mtimeMs) acc.mtimeMs = f.mtimeMs;
    }

    // Previews: `<hash>_<n>.<ext>` → keep the lowest-numbered thumb (`_0` = base).
    for (const f of await this.readFiles(join(root, month, 'Thumb'))) {
      const base = f.name.replace(/\.[^.]+$/, '');
      const m = /^(.*)_(\d+)$/.exec(base);
      const hash = m ? m[1]! : base;
      const rank = m ? Number(m[2]) : 0;
      if (!hash) continue;
      const acc = get(hash);
      acc.hasThumb = true;
      if (rank < acc.thumbRank) {
        acc.thumbRank = rank;
        acc.thumbName = f.name;
        acc.thumbBytes = f.size;
      }
      if (f.mtimeMs > acc.mtimeMs) acc.mtimeMs = f.mtimeMs;
    }

    // Materialise into MonthMediaEntry, building each variant's media rel now
    // that the month is known.
    const result: MonthMediaEntry[] = [];
    for (const [hash, acc] of out) {
      result.push({
        hash,
        month,
        hasOri: acc.hasOri,
        hasThumb: acc.hasThumb,
        oriRel: acc.hasOri ? `${month}/Ori/${acc.oriName}` : null,
        thumbRel: acc.hasThumb ? `${month}/Thumb/${acc.thumbName}` : null,
        oriBytes: acc.oriBytes,
        thumbBytes: acc.thumbBytes,
        ext: acc.ext,
        mtimeMs: acc.mtimeMs,
      });
    }
    return result;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function isKind(k: string): k is MediaResourceKind {
  return k === 'photoWall' || k === 'qzone' || k === 'pic' || k === 'video' || k === 'ptt';
}

/** Classify a file by its path into the ori / thumb / other analysis bucket. */
function variantBucket(relPath: string): 'ori' | 'thumb' | 'other' {
  const segs = relPath.split(/[/\\]/);
  if (segs.includes('Thumb')) return 'thumb';
  if (segs.includes('Ori') || segs.includes('OriTemp')) return 'ori';
  return 'other';
}

/** `YYYY-MM` month key from an mtime (ms). */
function monthKey(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function parseCursor(cursor: string | null): { a: number; b: number } {
  if (!cursor) return { a: 0, b: 0 };
  const [a, b] = cursor.split(':');
  return { a: Math.max(0, Number(a) || 0), b: Math.max(0, Number(b) || 0) };
}

function clampInt(n: number, lo: number, hi: number): number {
  const x = Math.floor(Number.isFinite(n) ? n : lo);
  return Math.min(hi, Math.max(lo, x));
}
