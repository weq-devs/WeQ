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

/**
 * 一个「可指定结果」的动画表情：`<faceId>/lottie/` 里直接放着
 * `<faceId>_<n>.json` 结果片段（骰子点数 / 包剪锤出拳 / 活动随机表情…）。
 *
 * 这是「能带 innerId 发送」的**唯一判据**：本地有哪个结果片段，就发得出哪个
 * innerId。三个经典随机表情（114 篮球 / 358 骰子 / 359 包剪锤）之外，活动限定的
 * 表情（如中秋 / 国庆 / 开学季）也会随 QQ 更新出现在这里，所以**不能硬编码**。
 */
export interface SysInnerFace {
  /** 表情目录名解析出的 faceId（只收纯数字目录）。 */
  faceId: number;
  /** 该表情可用的 innerId（结果编号，升序、去重，如 `['1','2','3','4','5','6']`）。 */
  innerIds: string[];
}

export class SysEmojiResourceService {
  /** Cached, sorted list of face directory names (the set changes rarely). */
  private names: string[] | null = null;

  /** Cached list of faces that carry innerId result clips (骰子等)；见 listInnerFaces。 */
  private innerFaces: SysInnerFace[] | null = null;

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

  /** Forget the cached directory listings (after a bulk download adds faces). */
  invalidate(): void {
    this.names = null;
    this.innerFaces = null;
  }

  /**
   * 列出**支持 innerId（可指定结果）**的内置表情及其可用 innerId 取值。
   *
   * 判据纯粹是磁盘事实：`<faceId>/lottie/<faceId>_<n>.json` 存在。没有结果片段的
   * 表情（普通小黄脸 / 大部分贴纸）不会出现；活动限定的随机表情只要 QQ 下了资源
   * 也会自动进来，所以这是**动态**列表，不要硬编码 faceId。
   *
   * 只扫每个纯数字目录的 `lottie/` 一层，且结果在整个会话内缓存（资源集很少变），
   * 调用方拿到后按名/需求排序即可。
   */
  async listInnerFaces(): Promise<SysInnerFace[]> {
    if (this.innerFaces) return this.innerFaces;
    const roots = this.roots();
    if (roots.length === 0) return [];
    /** faceId → innerId 集合（跨 root 合并）。 */
    const merged = new Map<number, Set<string>>();
    for (const root of roots) {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue;
        const ids = await collectInnerIds(join(root, e.name, 'lottie'), e.name);
        if (ids.length === 0) continue;
        const faceId = Number(e.name);
        const set = merged.get(faceId) ?? new Set<string>();
        for (const id of ids) set.add(id);
        merged.set(faceId, set);
      }
    }
    const out: SysInnerFace[] = [...merged.entries()]
      .map(([faceId, set]) => ({ faceId, innerIds: [...set].sort(compareNumericStrings) }))
      .sort((a, b) => a.faceId - b.faceId);
    this.innerFaces = out;
    return out;
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

/**
 * List `<name>_<n>.json` result clips directly inside `dir` (tolerates a missing
 * dir). Only the numeric `n` suffix counts — files like `surprise/100.json` sit in
 * a sub-directory and are never matched (readdir is non-recursive).
 */
async function collectInnerIds(dir: string, name: string): Promise<string[]> {
  let files: import('node:fs').Dirent[];
  try {
    files = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const pattern = new RegExp(`^${escapeRegExp(name)}_(\\d+)\\.json$`);
  const out = new Set<string>();
  for (const f of files) {
    if (!f.isFile()) continue;
    const m = pattern.exec(f.name);
    if (m) out.add(m[1]!);
  }
  return [...out];
}

/** Escape a literal string for use inside a RegExp (face dir names are numeric, but be safe). */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Numeric strings (`'2' < '10'`) ascend numerically; non-numeric fall back to lexicographic. */
function compareNumericStrings(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
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
