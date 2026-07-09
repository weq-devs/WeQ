/**
 * Local avatar resource browser for the current QQ account.
 *
 * QQ NT caches every avatar it has shown under `nt_data/avatar/<scope>`, where
 * scope is `user` (friends / strangers), `group`, or `cover` (profile covers).
 * Each scope is bucketed by the first two hex chars of the image hash, plus a
 * `temp/` staging dir, e.g.
 *
 *   nt_data/avatar/user/2b/b_2b0f…c1   ← "big" 640×640 avatar (JPEG, no ext)
 *   nt_data/avatar/user/2b/s_2b0f…c1   ← "small" thumbnail of the same hash
 *   nt_data/avatar/group/temp/8029…    ← occasional un-prefixed staging file
 *
 * The `b_` (big) and `s_` (small) files for one hash are the SAME avatar at two
 * resolutions, so we MERGE them into a single {@link AvatarEntry} carrying which
 * variants exist and each one's byte size. This is what lets the UI prefer the
 * big image while still labelling the source (大图 / 缩略图 / 大图+缩略图) and,
 * later, drive a "keep only thumbnails" cleanup.
 *
 * This service only enumerates + resolves paths (all inside the account's
 * `nt_data/avatar` tree); the bytes themselves are streamed to the renderer by
 * the `weq-media://avatar` protocol. Nothing here decrypts.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';

/** Which avatar tree to browse. */
export type AvatarScope = 'user' | 'group' | 'cover';

/** Which resolution of one avatar hash. */
export type AvatarVariant = 'big' | 'small';

export const AVATAR_SCOPES: readonly AvatarScope[] = ['user', 'group', 'cover'];

/** Per-scope summary for the sub-tab row (label + how many merged entries). */
export interface AvatarScopeInfo {
  scope: AvatarScope;
  /** Merged entries (unique hashes) across all buckets, or null if not scanned. */
  count: number;
  /** True when the scope directory exists on disk. */
  present: boolean;
}

/** One avatar, merging the big + small files that share a hash. */
export interface AvatarEntry {
  /** The 32-hex image hash (the shared part of `b_<hash>` / `s_<hash>`). */
  hash: string;
  /** Hash bucket (first two hex chars) or `temp` for the staging dir. */
  bucket: string;
  /** True when a `b_<hash>` (big / original) file exists. */
  hasBig: boolean;
  /** True when a `s_<hash>` (small / thumbnail) file exists. */
  hasSmall: boolean;
  /** Byte size of the big file, or 0 when absent. */
  bigBytes: number;
  /** Byte size of the small file, or 0 when absent. */
  smallBytes: number;
  /** Newest mtime (ms) across the entry's files — for sort / display. */
  mtimeMs: number;
}

/** A page of merged avatar entries. */
export interface AvatarPage {
  entries: AvatarEntry[];
  /** Opaque cursor for the next page, or null when exhausted. */
  nextCursor: string | null;
}

const DEFAULT_PAGE = 120;
const MAX_PAGE = 500;

/** Accumulator while merging a bucket's `b_`/`s_`/un-prefixed files by hash. */
interface Acc {
  hasBig: boolean;
  hasSmall: boolean;
  bigBytes: number;
  smallBytes: number;
  mtimeMs: number;
}

export class AvatarResourceService {
  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
  ) {}

  /** Absolute `nt_data/avatar` dir for the open account, or null if none. */
  private avatarRoot(): string | null {
    const data = this.platform.ntDataDir(this.session.context.uin);
    return data ? join(data, 'avatar') : null;
  }

  private scopeDir(scope: AvatarScope): string | null {
    const root = this.avatarRoot();
    return root ? join(root, scope) : null;
  }

  /**
   * Summaries for the three scopes: presence + merged entry count. The count is
   * a full scan (cheap: a readdir per bucket), used to populate the sub-tab
   * badges and hide empty scopes.
   */
  async listScopes(): Promise<AvatarScopeInfo[]> {
    return Promise.all(
      AVATAR_SCOPES.map(async (scope) => {
        const dir = this.scopeDir(scope);
        if (!dir) return { scope, count: 0, present: false };
        const buckets = await this.readBuckets(dir);
        if (buckets === null) return { scope, count: 0, present: false };
        let count = 0;
        for (const bucket of buckets) {
          const merged = await this.mergeBucket(join(dir, bucket));
          count += merged.size;
        }
        return { scope, count, present: true };
      }),
    );
  }

  /**
   * One page of merged avatar entries for a scope. Buckets are walked in name
   * order (`00`…`ff`, then `temp`); the cursor is `"<bucketIndex>:<entryIndex>"`
   * so paging is stable and resumable without holding all entries in memory at
   * once beyond the current bucket.
   */
  async listEntries(
    scope: AvatarScope,
    opts: { limit?: number; cursor?: string | null } = {},
  ): Promise<AvatarPage> {
    const dir = this.scopeDir(scope);
    if (!dir) return { entries: [], nextCursor: null };
    const buckets = await this.readBuckets(dir);
    if (buckets === null) return { entries: [], nextCursor: null };

    const cap = clampInt(opts.limit ?? DEFAULT_PAGE, 1, MAX_PAGE);
    const start = parseCursor(opts.cursor ?? null);

    const entries: AvatarEntry[] = [];
    let bucketIndex = start.bucketIndex;
    let entryIndex = start.entryIndex;

    while (bucketIndex < buckets.length && entries.length < cap) {
      const bucket = buckets[bucketIndex]!;
      const merged = await this.mergeBucket(join(dir, bucket));
      // Stable within a bucket: sort by hash so a given cursor points at the
      // same entry across calls (readdir order is not guaranteed stable).
      const hashes = [...merged.keys()].sort();

      for (; entryIndex < hashes.length && entries.length < cap; entryIndex += 1) {
        const hash = hashes[entryIndex]!;
        const acc = merged.get(hash)!;
        entries.push({
          hash,
          bucket,
          hasBig: acc.hasBig,
          hasSmall: acc.hasSmall,
          bigBytes: acc.bigBytes,
          smallBytes: acc.smallBytes,
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
   * Resolve the absolute path of one avatar file, or null if it isn't on disk.
   * Every input is validated (scope is an enum, hash is hex, variant is an
   * enum) and the resolved path is re-checked to sit inside the scope dir, so a
   * crafted `hash` can't escape the avatar tree.
   */
  async resolveFile(
    scope: AvatarScope,
    hash: string,
    variant: AvatarVariant,
  ): Promise<string | null> {
    if (!AVATAR_SCOPES.includes(scope)) return null;
    if (!/^[0-9a-f]{1,64}$/i.test(hash)) return null;
    const dir = this.scopeDir(scope);
    if (!dir) return null;

    const prefix = variant === 'big' ? 'b_' : 's_';
    const bucket = hash.slice(0, 2).toLowerCase();
    const candidates = [
      join(dir, bucket, `${prefix}${hash}`),
      // Some hashes live in the staging dir instead of a hex bucket.
      join(dir, 'temp', `${prefix}${hash}`),
      // The rare un-prefixed staging file (both variants map to it).
      join(dir, 'temp', hash),
    ];

    const base = resolve(dir);
    for (const candidate of candidates) {
      const abs = resolve(candidate);
      // Guard against path traversal: the file must stay under the scope dir.
      if (abs !== base && !abs.startsWith(base + sep)) continue;
      try {
        const st = await stat(abs);
        if (st.isFile()) return abs;
      } catch {
        /* not this candidate */
      }
    }
    return null;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Bucket dir names (`00`…`ff`, `temp`, …) under a scope, or null if absent. */
  private async readBuckets(scopeDir: string): Promise<string[] | null> {
    let entries;
    try {
      entries = await readdir(scopeDir, { withFileTypes: true });
    } catch {
      return null;
    }
    const buckets = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    // `00`…`ff` first (natural order), then anything else (e.g. `temp`) last.
    buckets.sort((a, b) => {
      const ha = /^[0-9a-f]{2}$/i.test(a);
      const hb = /^[0-9a-f]{2}$/i.test(b);
      if (ha && hb) return a.localeCompare(b);
      if (ha) return -1;
      if (hb) return 1;
      return a.localeCompare(b);
    });
    return buckets;
  }

  /** Merge one bucket's files into `hash → Acc`, keyed by the shared hash. */
  private async mergeBucket(bucketDir: string): Promise<Map<string, Acc>> {
    const out = new Map<string, Acc>();
    let files;
    try {
      files = await readdir(bucketDir, { withFileTypes: true });
    } catch {
      return out;
    }

    await Promise.all(
      files.map(async (entry) => {
        if (!entry.isFile()) return;
        const name = entry.name;
        // `b_<hash>` / `s_<hash>` / bare `<hash>` (staging). Ignore anything else.
        let variant: AvatarVariant;
        let hash: string;
        if (name.startsWith('b_')) {
          variant = 'big';
          hash = name.slice(2);
        } else if (name.startsWith('s_')) {
          variant = 'small';
          hash = name.slice(2);
        } else if (/^[0-9a-f]{8,}$/i.test(name)) {
          // Un-prefixed staging file — treat as a big original.
          variant = 'big';
          hash = name;
        } else {
          return;
        }
        if (!hash) return;

        let bytes = 0;
        let mtimeMs = 0;
        try {
          const st = await stat(join(bucketDir, name));
          bytes = st.size;
          mtimeMs = st.mtimeMs;
        } catch {
          return;
        }

        const acc = out.get(hash) ?? {
          hasBig: false,
          hasSmall: false,
          bigBytes: 0,
          smallBytes: 0,
          mtimeMs: 0,
        };
        if (variant === 'big') {
          acc.hasBig = true;
          acc.bigBytes = bytes;
        } else {
          acc.hasSmall = true;
          acc.smallBytes = bytes;
        }
        if (mtimeMs > acc.mtimeMs) acc.mtimeMs = mtimeMs;
        out.set(hash, acc);
      }),
    );
    return out;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

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
