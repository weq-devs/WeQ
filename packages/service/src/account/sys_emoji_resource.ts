/**
 * Local system-emoji resource browser for the current QQ account.
 *
 * QQ NT ships its built-in animated emoji ("小黄脸" faces) under
 * `nt_data/Emoji/BaseEmojiSyastems/EmojiSystermResource/<name>/…`, where each
 * `<name>` sub-directory (a numeric id like `358`, or a unicode glyph like `🍺`)
 * holds the same face in up to three formats:
 *
 *   <name>/png/<name>.png       ← static thumbnail (may also carry <name>_N.png frames)
 *   <name>/apng/<name>.png      ← APNG animation (extension is .png but it animates)
 *   <name>/lottie/<name>.json   ← Lottie animation (vector; may sit beside a .DS_Store)
 *
 * "有几个渲染几个" — a face may have any subset of those. This service just
 * enumerates each sub-directory and reports which formats are present (plus the
 * primary file name per format); the renderer streams the bytes through the
 * existing `weq-asset://emoji/<name>/<fmt>/<file>` protocol and renders APNG via
 * `<img>` and Lottie via lottie-web, mirroring the chat FaceEmoji component.
 *
 * The sibling `emoji.db` and any `*_emojiids.json` index files are intentionally
 * ignored — we render the folders as-is.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';

/** Which render formats a face directory exposes. */
export type SysEmojiFormat = 'png' | 'apng' | 'lottie';

/** One system-emoji face, merging whatever formats its directory carries. */
export interface SysEmojiEntry {
  /** The sub-directory name — a numeric id (`358`) or a unicode glyph (`🍺`). */
  name: string;
  /** True when `png/<name>.png` exists (static thumbnail). */
  hasPng: boolean;
  /** True when `apng/<name>.png` exists (APNG animation). */
  hasApng: boolean;
  /** True when `lottie/<name>.json` exists (Lottie animation). */
  hasLottie: boolean;
  /** Primary file name inside each present format dir (for URL building). */
  pngFile: string | null;
  apngFile: string | null;
  lottieFile: string | null;
}

/** A page of system-emoji faces. */
export interface SysEmojiPage {
  entries: SysEmojiEntry[];
  /** Opaque cursor for the next page, or null when exhausted. */
  nextCursor: string | null;
  /** Total face directories in the set (handy for a header count). */
  total: number;
}

const DEFAULT_PAGE = 120;
const MAX_PAGE = 500;

export class SysEmojiResourceService {
  /** Cached, sorted list of face directory names (the set changes rarely). */
  private names: string[] | null = null;

  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
  ) {}

  private root(): string | null {
    return this.platform.emojiResourceDir(this.session.context.uin);
  }

  /** All face directory names, sorted (numeric ids first, then glyphs). */
  private async faceNames(): Promise<string[]> {
    if (this.names) return this.names;
    const root = this.root();
    if (!root) return [];
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    names.sort(compareFaceNames);
    this.names = names;
    return names;
  }

  /**
   * One page of faces. Names are walked in sorted order; the cursor is the next
   * index to read, so paging is stable and resumable. Each entry probes its own
   * png/apng/lottie sub-dirs (in parallel) for the present formats.
   */
  async listEntries(
    opts: { limit?: number; cursor?: string | null } = {},
  ): Promise<SysEmojiPage> {
    const root = this.root();
    if (!root) return { entries: [], nextCursor: null, total: 0 };
    const names = await this.faceNames();
    const total = names.length;

    const cap = clampInt(opts.limit ?? DEFAULT_PAGE, 1, MAX_PAGE);
    const start = Math.max(0, Number(opts.cursor ?? 0) || 0);
    const slice = names.slice(start, start + cap);

    const entries = await Promise.all(slice.map((name) => this.probe(root, name)));
    const nextIndex = start + slice.length;
    return {
      entries,
      nextCursor: nextIndex < total ? String(nextIndex) : null,
      total,
    };
  }

  /** Probe one face directory for which formats it carries + the primary file. */
  private async probe(root: string, name: string): Promise<SysEmojiEntry> {
    const [png, apng, lottie] = await Promise.all([
      pickFile(join(root, name, 'png'), name, '.png'),
      pickFile(join(root, name, 'apng'), name, '.png'),
      pickFile(join(root, name, 'lottie'), name, '.json'),
    ]);
    return {
      name,
      hasPng: png !== null,
      hasApng: apng !== null,
      hasLottie: lottie !== null,
      pngFile: png,
      apngFile: apng,
      lottieFile: lottie,
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Choose the primary file in a format dir: prefer `<name><ext>` when present,
 * else the first file with the right extension (ignoring `.DS_Store` etc.).
 * Returns just the file name, or null when the dir is absent / has no match.
 */
async function pickFile(dir: string, name: string, ext: string): Promise<string | null> {
  let files: import('node:fs').Dirent[];
  try {
    files = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = files
    .filter((f) => f.isFile() && f.name.toLowerCase().endsWith(ext))
    .map((f) => f.name);
  if (candidates.length === 0) return null;
  const exact = `${name}${ext}`;
  if (candidates.includes(exact)) return exact;
  candidates.sort();
  return candidates[0]!;
}

/** Numeric ids ascend numerically and sort before non-numeric (glyph) names. */
function compareFaceNames(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na) return -1;
  if (nb) return 1;
  return a.localeCompare(b);
}

function clampInt(n: number, lo: number, hi: number): number {
  const x = Math.floor(Number.isFinite(n) ? n : lo);
  return Math.min(hi, Math.max(lo, x));
}
