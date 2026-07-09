/**
 * Local market-face resource browser for the current QQ account.
 *
 * QQ NT downloads store stickers (商城表情) under
 * `nt_data/Emoji/marketface/<itemId>/<hash>`, where each file is XOR-encrypted
 * with the pattern: every 50-byte chunk, the first 20 bytes are XORed with 0xFF.
 *
 * This service enumerates all itemId directories, then all files (hashes) within
 * each pack, and probes their type (GIF vs PNG) by decrypting the first few bytes
 * and checking the magic signature. The renderer streams decrypted bytes through
 * `weq-media://mface?pack=<itemId>&hash=<hash>` (handled by the existing
 * `media_protocol` logic, which delegates to `EmojiService.getMarketFace`).
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';

/** One market-face sticker (may have multiple formats: gif + png). */
export interface MarketFaceEntry {
  /** The emoji pack ID (directory name under marketface/). */
  itemId: string;
  /** The hash filename (no extension). */
  hash: string;
  /** Has encrypted GIF format. */
  hasGif: boolean;
  /** Has plaintext PNG format. */
  hasPng: boolean;
  /** GIF file size in bytes (0 if absent). */
  gifSize: number;
  /** PNG file size in bytes (0 if absent). */
  pngSize: number;
}

/** A page of market-face stickers. */
export interface MarketFacePage {
  entries: MarketFaceEntry[];
  /** Opaque cursor for the next page, or null when exhausted. */
  nextCursor: string | null;
  /** Total sticker files in the set (handy for a header count). */
  total: number;
}

const DEFAULT_PAGE = 120;
const MAX_PAGE = 500;

export class MarketEmojiResourceService {
  /** Cached, sorted list of all sticker entries (heavy, so we compute once). */
  private allEntries: MarketFaceEntry[] | null = null;

  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
  ) {}

  private root(): string | null {
    return this.platform.marketFaceDir(this.session.context.uin);
  }

  /** All market-face sticker entries, sorted by itemId then hash. */
  private async listAll(): Promise<MarketFaceEntry[]> {
    if (this.allEntries) return this.allEntries;
    const root = this.root();
    if (!root) return [];

    let itemDirs: string[];
    try {
      const entries = await readdir(root, { withFileTypes: true });
      itemDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }

    // Enumerate every itemId dir + stat every file CONCURRENTLY — a pack cache
    // can hold thousands of files, so a sequential readdir/stat walk would block
    // for a long time. We gather flat `{itemId, file, size}` records in parallel,
    // then fold them into the by-hash map (cheap, CPU-only) afterwards.
    const perItem = await Promise.all(
      itemDirs.map(async (itemId) => {
        const itemPath = join(root, itemId);
        let names: string[];
        try {
          const fEntries = await readdir(itemPath, { withFileTypes: true });
          names = fEntries.filter((e) => e.isFile()).map((e) => e.name);
        } catch {
          return [];
        }
        return Promise.all(
          names.map(async (file) => {
            try {
              const st = await stat(join(itemPath, file));
              return { itemId, file, size: st.size };
            } catch {
              return null;
            }
          }),
        );
      }),
    );

    // One hash may have both a GIF (encrypted) and a PNG (plaintext).
    const byHash = new Map<string, { itemId: string; hash: string; gifSize: number; pngSize: number }>();
    for (const records of perItem) {
      for (const rec of records) {
        if (!rec) continue;
        const { itemId, file, size: sizeBytes } = rec;

        // A sticker is stored as either the raw encrypted GIF (`<hash>`, no
        // extension) or a plaintext PNG whose name is the hash plus a suffix —
        // `<hash>_aio.png` (full size), `<hash>_thu.png` (thumbnail) or a bare
        // `<hash>.png`. Strip whatever PNG suffix is present so both formats of
        // one sticker merge under the same base hash (and `_thu.png` is no
        // longer mistaken for an encrypted GIF).
        const isPng = file.toLowerCase().endsWith('.png');
        const hash = isPng ? stripPngSuffix(file) : file;

        const key = `${itemId}/${hash}`;
        const existing = byHash.get(key);
        if (existing) {
          if (isPng) existing.pngSize = sizeBytes;
          else existing.gifSize = sizeBytes;
        } else {
          byHash.set(key, {
            itemId,
            hash,
            gifSize: isPng ? 0 : sizeBytes,
            pngSize: isPng ? sizeBytes : 0,
          });
        }
      }
    }

    const all: MarketFaceEntry[] = Array.from(byHash.values()).map((e) => ({
      itemId: e.itemId,
      hash: e.hash,
      hasGif: e.gifSize > 0,
      hasPng: e.pngSize > 0,
      gifSize: e.gifSize,
      pngSize: e.pngSize,
    }));

    // Sort by itemId, then by hash (both lexicographic).
    all.sort((a, b) => {
      if (a.itemId !== b.itemId) return a.itemId.localeCompare(b.itemId);
      return a.hash.localeCompare(b.hash);
    });

    this.allEntries = all;
    return all;
  }

  /**
   * One page of market faces. The cursor is the next index to read, so paging
   * is stable and resumable (as long as the cache hasn't changed).
   */
  async listEntries(
    opts: { limit?: number; cursor?: string | null } = {},
  ): Promise<MarketFacePage> {
    const entries = await this.listAll();
    const total = entries.length;

    const cap = clampInt(opts.limit ?? DEFAULT_PAGE, 1, MAX_PAGE);
    const start = Math.max(0, Number(opts.cursor ?? 0) || 0);
    const slice = entries.slice(start, start + cap);

    const nextIndex = start + slice.length;
    return {
      entries: slice,
      nextCursor: nextIndex < total ? String(nextIndex) : null,
      total,
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Strip a market-face PNG suffix to recover the base hash. QQ names plaintext
 * PNGs as `<hash>_aio.png` (full) / `<hash>_thu.png` (thumbnail), and
 * occasionally a bare `<hash>.png`; the encrypted GIF beside them is just
 * `<hash>` with no extension.
 */
function stripPngSuffix(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith('_aio.png') || lower.endsWith('_thu.png')) return file.slice(0, -8);
  return file.slice(0, -4); // trailing ".png"
}

function clampInt(n: number, lo: number, hi: number): number {
  const x = Math.floor(Number.isFinite(n) ? n : lo);
  return Math.min(hi, Math.max(lo, x));
}
