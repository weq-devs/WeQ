/**
 * Local related-emoji (关联表情) resource browser for the current QQ account.
 *
 * QQ NT keeps a keyword → emoji association set under
 * `nt_data/Emoji/emoji-related/emoji`:
 *
 *   words.json            ← { version, words: string[] } — the keyword list
 *   <md5(keyword)>/        ← one dir per keyword, named md5(keyword) in UTF-8
 *     <gifhash>.gif        ← plaintext gifs (NO decryption needed), several per word
 *   __MACOSX/              ← junk dir that may sit beside the hash dirs (ignored)
 *
 * The `md5(keyword)` naming is verified: hashing each `words.json` entry as UTF-8
 * reproduces the on-disk hash dir names. A given keyword may have no dir (the
 * word list is a superset), so we only surface keywords whose dir exists.
 *
 * Cost note: `words.json` holds ~17k keywords (with duplicates). We do ONE
 * `readdir` of the root to learn which hash dirs exist, then hash the deduped
 * keywords in memory and keep the ones that hit — yielding to the event loop in
 * chunks so a big list never blocks. Per-keyword gif listings are read lazily,
 * a page at a time. This service only enumerates + resolves paths; the gif bytes
 * stream to the renderer via the `weq-media://relemoji` protocol (no decryption).
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';

/** One keyword that has an on-disk emoji dir. */
export interface RelatedEmojiKeyword {
  /** The keyword text (e.g. `哈哈哈`). */
  keyword: string;
  /** `md5(keyword)` (UTF-8) — the dir name holding this keyword's gifs. */
  hash: string;
  /** First gif's file name (cover), or null if the dir turned out empty. */
  cover: string | null;
  /** How many gif files the keyword's dir holds. */
  gifCount: number;
}

/** A page of related-emoji keywords. */
export interface RelatedEmojiPage {
  entries: RelatedEmojiKeyword[];
  /** Opaque cursor for the next page, or null when exhausted. */
  nextCursor: string | null;
  /** Total keywords with an on-disk dir (handy for a header count). */
  total: number;
}

const DEFAULT_PAGE = 120;
const MAX_PAGE = 500;
/** Yield to the event loop every N keywords while hashing the word list. */
const HASH_CHUNK = 2000;

export class RelatedEmojiResourceService {
  /** Cached keyword→hash list (only keywords whose dir exists), built once. */
  private matched: Array<{ keyword: string; hash: string }> | null = null;
  /** In-flight build promise, so concurrent callers share one scan. */
  private building: Promise<Array<{ keyword: string; hash: string }>> | null = null;

  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
  ) {}

  private root(): string | null {
    return this.platform.emojiRelatedDir(this.session.context.uin);
  }

  /**
   * Build (once) the list of keywords that actually have an emoji dir on disk.
   * Reads the root's dir names + `words.json`, then hashes the deduped keywords
   * in memory, chunked so the event loop stays responsive. Order follows
   * `words.json` (dedup keeps first occurrence).
   */
  private async ensureMatched(): Promise<Array<{ keyword: string; hash: string }>> {
    if (this.matched) return this.matched;
    if (this.building) return this.building;
    this.building = this.build().then((m) => {
      this.matched = m;
      this.building = null;
      return m;
    }).catch((e) => {
      this.building = null;
      throw e;
    });
    return this.building;
  }

  private async build(): Promise<Array<{ keyword: string; hash: string }>> {
    const root = this.root();
    if (!root) return [];

    // 1) The hash dirs that exist (single readdir; skip files + junk).
    let dirNames: Set<string>;
    try {
      const entries = await readdir(root, { withFileTypes: true });
      dirNames = new Set(
        entries
          .filter((e) => e.isDirectory() && /^[0-9a-f]{32}$/i.test(e.name))
          .map((e) => e.name.toLowerCase()),
      );
    } catch {
      return [];
    }
    if (dirNames.size === 0) return [];

    // 2) The keyword list.
    let words: string[];
    try {
      const raw = await readFile(join(root, 'words.json'), 'utf8');
      const parsed = JSON.parse(raw) as { words?: unknown };
      words = Array.isArray(parsed.words) ? parsed.words.filter((w): w is string => typeof w === 'string') : [];
    } catch {
      return [];
    }

    // 3) Hash deduped keywords in memory, keep the hits. Chunked to yield.
    const seen = new Set<string>();
    const out: Array<{ keyword: string; hash: string }> = [];
    let i = 0;
    for (const word of words) {
      if (!seen.has(word)) {
        seen.add(word);
        const hash = md5Utf8(word);
        if (dirNames.has(hash)) out.push({ keyword: word, hash });
      }
      i += 1;
      if (i % HASH_CHUNK === 0) await yieldToLoop();
    }
    return out;
  }

  /** Total keywords with an on-disk dir. */
  async count(): Promise<number> {
    return (await this.ensureMatched()).length;
  }

  /**
   * One page of keywords. The cursor is the next index into the cached matched
   * list, so paging is stable. Each page reads its keywords' dirs in parallel to
   * pick a cover (first gif) + gif count.
   */
  async listKeywords(
    opts: { limit?: number; cursor?: string | null } = {},
  ): Promise<RelatedEmojiPage> {
    const root = this.root();
    if (!root) return { entries: [], nextCursor: null, total: 0 };
    const matched = await this.ensureMatched();
    const total = matched.length;

    const cap = clampInt(opts.limit ?? DEFAULT_PAGE, 1, MAX_PAGE);
    const start = Math.max(0, Number(opts.cursor ?? 0) || 0);
    const slice = matched.slice(start, start + cap);

    const entries = await Promise.all(
      slice.map(async ({ keyword, hash }) => {
        const gifs = await this.readGifs(root, hash);
        return { keyword, hash, cover: gifs[0] ?? null, gifCount: gifs.length };
      }),
    );

    const nextIndex = start + slice.length;
    return { entries, nextCursor: nextIndex < total ? String(nextIndex) : null, total };
  }

  /** All gif file names in one keyword's hash dir (sorted). Empty if absent. */
  async listGifs(hash: string): Promise<string[]> {
    const root = this.root();
    if (!root) return [];
    if (!/^[0-9a-f]{32}$/i.test(hash)) return [];
    return this.readGifs(root, hash);
  }

  /**
   * Resolve the absolute path of one gif, or null if it isn't on disk. The hash
   * must be a 32-hex dir name and `file` a bare `.gif` basename (no separators /
   * `..`); the resolved path is re-checked to sit inside the related-emoji tree.
   */
  async resolveFile(hash: string, file: string): Promise<string | null> {
    const root = this.root();
    if (!root) return null;
    if (!/^[0-9a-f]{32}$/i.test(hash)) return null;
    if (!file || file.includes('/') || file.includes('\\') || file.includes('..')) return null;
    if (!/^[\w.-]+\.gif$/i.test(file)) return null;

    const abs = resolve(join(root, hash, file));
    const base = resolve(root);
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

  /** Read + sort the `.gif` file names in `<root>/<hash>`. */
  private async readGifs(root: string, hash: string): Promise<string[]> {
    let files: import('node:fs').Dirent[];
    try {
      files = await readdir(join(root, hash), { withFileTypes: true });
    } catch {
      return [];
    }
    const gifs = files
      .filter((f) => f.isFile() && f.name.toLowerCase().endsWith('.gif'))
      .map((f) => f.name);
    gifs.sort();
    return gifs;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** md5 of a string hashed as UTF-8 (matches QQ's dir naming). */
function md5Utf8(s: string): string {
  return createHash('md5').update(s, 'utf8').digest('hex');
}

/** Hand control back to the event loop between chunks of CPU work. */
function yieldToLoop(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function clampInt(n: number, lo: number, hi: number): number {
  const x = Math.floor(Number.isFinite(n) ? n : lo);
  return Math.min(hi, Math.max(lo, x));
}
