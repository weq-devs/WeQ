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
 *
 * Faces we downloaded ourselves (QQ's directory missing — see
 * `SysEmojiDownloadService`) live in a mirror root with the identical layout, so
 * this browser simply walks both roots and merges them by name.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import { pageByIndex } from './resource_paging';

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

export class SysEmojiResourceService {
  /** Cached, sorted list of face directory names (the set changes rarely). */
  private names: string[] | null = null;

  /**
   * @param extraRoot Mirror root for faces WeQ downloaded itself. Resolved
   *   lazily because the download service creates it on demand.
   */
  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
    private readonly extraRoot?: () => string | null,
  ) {}

  /** Every root to walk, QQ's own first. */
  private roots(): string[] {
    const out: string[] = [];
    const qq = this.platform.emojiResourceDir(this.session.context.uin);
    if (qq) out.push(qq);
    const extra = this.extraRoot?.();
    if (extra) out.push(extra);
    return out;
  }

  /** All face directory names across every root, deduped and sorted. */
  private async faceNames(): Promise<string[]> {
    if (this.names) return this.names;
    const seen = new Set<string>();
    for (const root of this.roots()) {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory()) seen.add(e.name);
      }
    }
    const names = [...seen];
    names.sort(compareFaceNames);
    this.names = names;
    return names;
  }

  /**
   * One page of faces. Names are walked in sorted order; the cursor is the next
   * index to read, so paging is stable and resumable. Each entry probes its own
   * png/apng/lottie sub-dirs (in parallel) for the present formats.
   */
  async listEntries(opts: { limit?: number; cursor?: string | null } = {}): Promise<SysEmojiPage> {
    const roots = this.roots();
    if (roots.length === 0) return { entries: [], nextCursor: null, total: 0 };
    const names = await this.faceNames();
    const { entries: slice, nextCursor, total } = pageByIndex(names, opts);
    const entries = await Promise.all(slice.map((name) => this.probe(roots, name)));
    return { entries, nextCursor, total };
  }

  /** Forget the cached directory listing (after a bulk download adds faces). */
  invalidate(): void {
    this.names = null;
  }

  /**
   * Probe one face for which formats it carries + the primary file, taking the
   * first root that has each format (QQ's own copy wins, matching the order the
   * `weq-asset://emoji` handler resolves in).
   */
  private async probe(roots: string[], name: string): Promise<SysEmojiEntry> {
    const [png, apng, lottie] = await Promise.all([
      pickFileAcross(roots, name, 'png', '.png'),
      pickFileAcross(roots, name, 'apng', '.png'),
      pickFileAcross(roots, name, 'lottie', '.json'),
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

/** {@link pickFile} across every root, returning the first hit. */
async function pickFileAcross(
  roots: string[],
  name: string,
  fmt: SysEmojiFormat,
  ext: string,
): Promise<string | null> {
  for (const root of roots) {
    const hit = await pickFile(join(root, name, fmt), name, ext);
    if (hit) return hit;
  }
  return null;
}

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
