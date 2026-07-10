/**
 * Local custom-emoji resource browser for the current QQ account.
 *
 * QQ NT keeps two flavours of custom (自定义) emoji under `nt_data/Emoji`:
 *
 *   emoji-recv/<YYYY-MM>/Ori/<hash>.<ext>        ← received emoji, bucketed by month
 *   emoji-recv/<YYYY-MM>/Thumb/<hash>[_<n>].<ext> ← its still preview
 *   personal_emoji/Ori/<hash>.<ext>              ← the user's own / favourited emoji
 *   personal_emoji/Thumb/<hash>.<ext>            ← its still preview
 *
 * (`emoji-recv` also carries `OriTemp` / `ThumbTemp` staging dirs — ignored.)
 *
 * File naming is NOT uniform across QQ versions / months:
 *   - Older months: `Ori/<hash>.png` + `Thumb/<hash>.png` (same stem, both PNG).
 *   - Newer months: `Ori/<hash>.jpg` + `Thumb/<hash>_720.jpg` — the thumb gains a
 *     `_<size>` suffix and the extension varies wildly (.jpg/.png/.gif/.suf/…).
 * So we can't reconstruct a file name from the hash alone. We derive a canonical
 * key (the leading 32-hex, stripping any `_<digits>` suffix) to MERGE the Ori +
 * Thumb of one emoji into a single {@link CustomEmojiEntry}, and we keep each
 * variant's ACTUAL file name so the renderer can address the exact byte stream.
 *
 * Two scopes:
 *   - `recv`     — `emoji-recv`, bucketed by month dir (newest month first).
 *   - `personal` — `personal_emoji`, a single flat bucket (Ori/Thumb at the root).
 *
 * This service only enumerates + resolves paths (all inside the account's
 * `nt_data/Emoji` tree); the bytes themselves stream to the renderer via the
 * `weq-media://cemoji` protocol. Nothing here decrypts.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';

/** Which custom-emoji tree to browse. */
export type CustomEmojiScope = 'recv' | 'personal';

/** Which file of one emoji hash. */
export type CustomEmojiVariant = 'ori' | 'thumb';

export const CUSTOM_EMOJI_SCOPES: readonly CustomEmojiScope[] = ['recv', 'personal'];

/** Per-scope summary for the sub-tab row (label + merged entry count). */
export interface CustomEmojiScopeInfo {
  scope: CustomEmojiScope;
  /** Merged entries (unique hashes) across all buckets. */
  count: number;
  /** True when the scope directory exists on disk. */
  present: boolean;
}

/** One custom emoji, merging the ori + thumb files that share a hash. */
export interface CustomEmojiEntry {
  /** The canonical image hash (leading 32-hex, `_<size>` suffix stripped). */
  hash: string;
  /** Month dir for `recv` (`2026-07`), or `''` for the flat `personal` scope. */
  bucket: string;
  /** True when an `Ori/…` (original) file exists. */
  hasOri: boolean;
  /** True when a `Thumb/…` (still preview) file exists. */
  hasThumb: boolean;
  /** Actual `Ori` file name (e.g. `<hash>.jpg`), or null when absent. */
  oriFile: string | null;
  /** Actual `Thumb` file name (e.g. `<hash>_720.jpg`), or null when absent. */
  thumbFile: string | null;
  /** Extension of the original file (e.g. `.gif`), or `''` when absent/none. */
  oriExt: string;
  /** Byte size of the original file, or 0 when absent. */
  oriBytes: number;
  /** Byte size of the thumbnail file, or 0 when absent. */
  thumbBytes: number;
  /** Newest mtime (ms) across the entry's files — for sort / display. */
  mtimeMs: number;
}

/** A page of merged custom-emoji entries. */
export interface CustomEmojiPage {
  entries: CustomEmojiEntry[];
  /** Opaque cursor for the next page, or null when exhausted. */
  nextCursor: string | null;
}

const DEFAULT_PAGE = 120;
const MAX_PAGE = 500;

/** Accumulator while merging a bucket's `Ori`/`Thumb` files by hash. */
interface Acc {
  hasOri: boolean;
  hasThumb: boolean;
  oriFile: string | null;
  thumbFile: string | null;
  oriExt: string;
  oriBytes: number;
  thumbBytes: number;
  mtimeMs: number;
}

export class CustomEmojiResourceService {
  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
  ) {}

  /** Absolute root dir for a scope (`emoji-recv` / `personal_emoji`), or null. */
  private scopeRoot(scope: CustomEmojiScope): string | null {
    const uin = this.session.context.uin;
    return scope === 'recv'
      ? this.platform.emojiRecvDir(uin)
      : this.platform.personalEmojiDir(uin);
  }

  /**
   * Bucket dir names for a scope. `recv` is bucketed by month (`2024-09`…),
   * returned newest-first so recent emoji page in first; `personal` is flat, so
   * it has a single synthetic bucket `''` (Ori/Thumb sit directly under root).
   * Returns null when the scope dir is absent.
   */
  private async readBuckets(scope: CustomEmojiScope): Promise<string[] | null> {
    const root = this.scopeRoot(scope);
    if (!root) return null;
    if (scope === 'personal') return [''];
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return null;
    }
    // Month dirs like `2026-07`; ignore anything else. Newest month first.
    const months = entries
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a));
    return months;
  }

  /** Absolute `Ori` / `Thumb` dir for one (scope, bucket). */
  private variantDir(
    root: string,
    scope: CustomEmojiScope,
    bucket: string,
    which: 'Ori' | 'Thumb',
  ): string {
    return scope === 'recv' ? join(root, bucket, which) : join(root, which);
  }

  /**
   * Summaries for the two scopes: presence + merged entry count. A full scan
   * (a readdir per bucket's Ori/Thumb) — used to populate the sub-tab badges and
   * hide empty scopes.
   */
  async listScopes(): Promise<CustomEmojiScopeInfo[]> {
    return Promise.all(
      CUSTOM_EMOJI_SCOPES.map(async (scope) => {
        const root = this.scopeRoot(scope);
        if (!root) return { scope, count: 0, present: false };
        const buckets = await this.readBuckets(scope);
        if (buckets === null) return { scope, count: 0, present: false };
        let count = 0;
        for (const bucket of buckets) {
          const merged = await this.mergeBucket(root, scope, bucket);
          count += merged.size;
        }
        return { scope, count, present: true };
      }),
    );
  }

  /**
   * One page of merged custom-emoji entries for a scope. Buckets are walked in
   * order (recv: newest month first; personal: the single flat bucket); the
   * cursor is `"<bucketIndex>:<entryIndex>"` so paging is stable and resumable.
   */
  async listEntries(
    scope: CustomEmojiScope,
    opts: { limit?: number; cursor?: string | null } = {},
  ): Promise<CustomEmojiPage> {
    const root = this.scopeRoot(scope);
    if (!root) return { entries: [], nextCursor: null };
    const buckets = await this.readBuckets(scope);
    if (buckets === null) return { entries: [], nextCursor: null };

    const cap = clampInt(opts.limit ?? DEFAULT_PAGE, 1, MAX_PAGE);
    const start = parseCursor(opts.cursor ?? null);

    const entries: CustomEmojiEntry[] = [];
    let bucketIndex = start.bucketIndex;
    let entryIndex = start.entryIndex;

    while (bucketIndex < buckets.length && entries.length < cap) {
      const bucket = buckets[bucketIndex]!;
      const merged = await this.mergeBucket(root, scope, bucket);
      // Stable within a bucket: sort by hash so a cursor points at the same
      // entry across calls (readdir order is not guaranteed stable).
      const hashes = [...merged.keys()].sort();

      for (; entryIndex < hashes.length && entries.length < cap; entryIndex += 1) {
        const hash = hashes[entryIndex]!;
        const acc = merged.get(hash)!;
        entries.push({
          hash,
          bucket,
          hasOri: acc.hasOri,
          hasThumb: acc.hasThumb,
          oriFile: acc.oriFile,
          thumbFile: acc.thumbFile,
          oriExt: acc.oriExt,
          oriBytes: acc.oriBytes,
          thumbBytes: acc.thumbBytes,
          mtimeMs: acc.mtimeMs,
        });
      }

      if (entryIndex < hashes.length) {
        // Filled the page mid-bucket — resume here next call.
        return { entries, nextCursor: `${bucketIndex}:${entryIndex}` };
      }
      // Bucket exhausted; advance to the next one.
      bucketIndex += 1;
      entryIndex = 0;
    }

    const done = bucketIndex >= buckets.length;
    return { entries, nextCursor: done ? null : `${bucketIndex}:${entryIndex}` };
  }

  /**
   * Resolve the absolute path of one custom-emoji file, or null if it isn't on
   * disk. The renderer passes the ACTUAL file name (from the listing) plus which
   * sub-dir it lives in — the extension / `_size` suffix are unpredictable, so we
   * can't reconstruct the name from a hash. Every input is validated (scope +
   * variant are enums, bucket is a month or empty, the file is a bare basename
   * starting with hex — no separators / `..`) and the resolved path is re-checked
   * to sit inside the scope dir, so a crafted `file` can't escape the emoji tree.
   */
  async resolveFile(
    scope: CustomEmojiScope,
    bucket: string,
    variant: CustomEmojiVariant,
    file: string,
  ): Promise<string | null> {
    if (!CUSTOM_EMOJI_SCOPES.includes(scope)) return null;
    if (variant !== 'ori' && variant !== 'thumb') return null;
    // `recv` needs a month bucket; `personal` must be flat.
    if (scope === 'recv' && !/^\d{4}-\d{2}$/.test(bucket)) return null;
    if (scope === 'personal' && bucket !== '') return null;
    // The file must be a bare basename (no path parts) that starts with a hash.
    if (!file || file.includes('/') || file.includes('\\') || file.includes('..')) return null;
    if (!/^[0-9a-f]{6,}/i.test(file)) return null;

    const root = this.scopeRoot(scope);
    if (!root) return null;

    const dir = this.variantDir(root, scope, bucket, variant === 'ori' ? 'Ori' : 'Thumb');
    const abs = resolve(join(dir, file));
    const base = resolve(root);
    // Guard against path traversal: the file must stay under the scope root.
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

  /** Merge one bucket's `Ori` + `Thumb` files into `hash → Acc` by canonical key. */
  private async mergeBucket(
    root: string,
    scope: CustomEmojiScope,
    bucket: string,
  ): Promise<Map<string, Acc>> {
    const out = new Map<string, Acc>();
    await Promise.all([
      this.absorb(out, this.variantDir(root, scope, bucket, 'Ori'), 'ori'),
      this.absorb(out, this.variantDir(root, scope, bucket, 'Thumb'), 'thumb'),
    ]);
    return out;
  }

  /** Read one `Ori`/`Thumb` dir and fold its files into `out` keyed by hash. */
  private async absorb(
    out: Map<string, Acc>,
    dir: string,
    variant: CustomEmojiVariant,
  ): Promise<void> {
    let files;
    try {
      files = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      files.map(async (entry) => {
        if (!entry.isFile()) return;
        const name = entry.name;
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
        const hash = canonicalHash(stem);
        if (!hash) return;

        let bytes = 0;
        let mtimeMs = 0;
        try {
          const st = await stat(join(dir, name));
          bytes = st.size;
          mtimeMs = st.mtimeMs;
        } catch {
          return;
        }

        const acc = out.get(hash) ?? {
          hasOri: false,
          hasThumb: false,
          oriFile: null,
          thumbFile: null,
          oriExt: '',
          oriBytes: 0,
          thumbBytes: 0,
          mtimeMs: 0,
        };
        if (variant === 'ori') {
          acc.hasOri = true;
          acc.oriFile = name;
          acc.oriExt = ext;
          acc.oriBytes = bytes;
        } else {
          acc.hasThumb = true;
          acc.thumbFile = name;
          acc.thumbBytes = bytes;
        }
        if (mtimeMs > acc.mtimeMs) acc.mtimeMs = mtimeMs;
        out.set(hash, acc);
      }),
    );
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Canonical merge key for an emoji file stem: the leading hex run, with any
 * trailing `_<digits>` size suffix stripped, lower-cased. This makes an original
 * (`<hash>`) and its thumb (`<hash>` or `<hash>_720`) collapse to one key across
 * the old and new QQ naming schemes. Returns `''` for a non-hex stem (skipped).
 */
function canonicalHash(stem: string): string {
  const m = /^([0-9a-f]{6,})(?:_\d+)?$/i.exec(stem);
  if (m) return m[1]!.toLowerCase();
  // Fallback: a leading hex run (defensive — unusual names still group sanely).
  const lead = /^[0-9a-f]{6,}/i.exec(stem);
  return lead ? lead[0].toLowerCase() : '';
}

function parseCursor(cursor: string | null): { bucketIndex: number; entryIndex: number } {
  if (!cursor) return { bucketIndex: 0, entryIndex: 0 };
  const [b, e] = cursor.split(':');
  const bucketIndex = Math.max(0, Number(b) || 0);
  const entryIndex = Math.max(0, Number(e) || 0);
  return { bucketIndex, entryIndex };
}

function clampInt(n: number, lo: number, hi: number): number {
  const x = Math.floor(Number.isFinite(n) ? n : lo);
  return Math.min(hi, Math.max(lo, x));
}
