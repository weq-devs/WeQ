/**
 * Local file resource browser for the current QQ account.
 *
 * Two data sources feed the 本地资源 → 文件 页面, both surfaced by this one
 * service:
 *
 *   1. **File 目录** — a recursive walk of `nt_data/File/Ori`, QQ NT's on-disk
 *      store for files that were *sent/received in chat*. The tree keeps the
 *      original file names (with extensions), sometimes nested one level under a
 *      per-conversation sub-dir. We scan it ONCE into an in-memory snapshot and
 *      then filter / sort / page over that snapshot, so a big folder never
 *      re-hits the disk on every keystroke (the walk itself is fully async — it
 *      runs in the main process and never blocks the renderer).
 *
 *   2. **下载文件** — the entries recorded in `file_assistant.db` (文件助手). Each
 *      row carries an absolute `localPath` (often prefixed `::NTOSFull::`). QQ
 *      may have downloaded the file to the user's own download directory, so the
 *      path can point *outside* `nt_data`; we probe each one's existence so the
 *      UI can tell "还在" from "已删除". The db read is cached the same way.
 *
 * File cards are classified the same way the chat renders them (icon by
 * extension), with the extension table deliberately RICHER than the chat's — see
 * {@link classifyFile} — e.g. `.html` / `.json` / `.go` now land in 代码 instead
 * of 其它.
 *
 * This service only enumerates + validates paths. Image previews stream to the
 * renderer via `weq-media://localfile` (which re-validates against
 * {@link FileResourceService.resolveLocalFile}); reveal / open in the OS file
 * manager happen in the router (electron `shell`). Nothing here decrypts.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import type { FileAssistantRow } from '@weq/db';

/** Coarse bucket a file falls into, driving the category tabs + default icon. */
export type FileCategory =
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'archive'
  | 'code'
  | 'program'
  | 'other';

export const FILE_CATEGORIES: readonly FileCategory[] = [
  'image',
  'video',
  'audio',
  'document',
  'archive',
  'code',
  'program',
  'other',
];

/** How to order a same-category listing. */
export type FileSortKey = 'time' | 'name' | 'size';
export type FileSortOrder = 'asc' | 'desc';

/** One file under `File/Ori`. */
export interface FileResourceEntry {
  /** Basename (with extension). */
  name: string;
  /** Path relative to the `Ori` root (posix separators), unique per file. */
  relPath: string;
  /** Absolute path (used by the renderer to reveal / preview via round-trip). */
  absPath: string;
  /** Lower-case extension without the dot (`''` when the file has none). */
  ext: string;
  category: FileCategory;
  /** File-icon basename under `resources/fileIcon` (e.g. `code.png`). */
  icon: string;
  size: number;
  mtimeMs: number;
}

/** Presence + per-category counts for the `File 目录` category tabs. */
export interface FileDirSummary {
  present: boolean;
  /** Absolute `Ori` root, or null when the account has no File dir. */
  root: string | null;
  total: number;
  byCategory: Record<FileCategory, number>;
  /** True when the walk hit its hard file cap and the snapshot is partial. */
  truncated: boolean;
}

/** A page (filtered + sorted slice) of File-dir entries. */
export interface FileDirPage {
  entries: FileResourceEntry[];
  /** Total entries matching the active filter (category + search). */
  total: number;
}

/** One row from `file_assistant.db`, resolved + existence-probed. */
export interface DownloadFileEntry {
  fileName: string;
  ext: string;
  category: FileCategory;
  icon: string;
  fileSize: number;
  /** Send/record time in ms. */
  timestamp: number;
  /** Cleaned absolute path (`::NTOSFull::` prefix stripped), or '' if unknown. */
  localPath: string;
  /** True when `localPath` still exists on disk. */
  exists: boolean;
  msgId: string;
  sourceTable: 'file_assistant' | 'file_assistant_v2';
}

/** A page (filtered + sorted slice) of download-file entries. */
export interface DownloadFilePage {
  entries: DownloadFileEntry[];
  total: number;
}

/** Options shared by both listings. */
export interface FileListOptions {
  category?: FileCategory | 'all';
  search?: string;
  sort?: FileSortKey;
  order?: FileSortOrder;
  offset?: number;
  limit?: number;
}

const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 400;
/** Hard cap on the File/Ori walk so a pathological tree can't exhaust memory. */
const MAX_SCAN_FILES = 200_000;
/** Directory recursion depth cap (Ori is normally ≤2 deep). */
const MAX_SCAN_DEPTH = 8;
/** Upper bound when snapshotting file_assistant.db in one read. */
const DOWNLOAD_SNAPSHOT_CAP = 100_000;

export class FileResourceService {
  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
  ) {}

  // ── File 目录 (nt_data/File/Ori) ────────────────────────────────────────────

  /** Cached snapshot of the `Ori` walk (null until first scan). */
  private fileCache: FileResourceEntry[] | null = null;
  private fileCacheTruncated = false;
  /** In-flight scan promise, so concurrent callers share one walk. */
  private fileScan: Promise<FileResourceEntry[]> | null = null;

  /** Absolute `nt_data/File/Ori` dir for the open account, or null. */
  private oriRoot(): string | null {
    const fileDir = this.platform.fileDir(this.session.context.uin);
    return fileDir ? join(fileDir, 'Ori') : null;
  }

  /**
   * Ensure the `Ori` snapshot is built (idempotent; `force` rescans). The walk
   * is async and coalesced — concurrent callers await the same promise.
   */
  private async ensureFileCache(force = false): Promise<FileResourceEntry[]> {
    if (!force && this.fileCache) return this.fileCache;
    if (this.fileScan) return this.fileScan;
    this.fileScan = this.scanOri()
      .then((entries) => {
        this.fileCache = entries;
        return entries;
      })
      .finally(() => {
        this.fileScan = null;
      });
    return this.fileScan;
  }

  /** Recursively walk `Ori` into a flat entry list (bounded by cap + depth). */
  private async scanOri(): Promise<FileResourceEntry[]> {
    this.fileCacheTruncated = false;
    const root = this.oriRoot();
    if (!root) return [];

    const out: FileResourceEntry[] = [];
    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (out.length >= MAX_SCAN_FILES || depth > MAX_SCAN_DEPTH) return;
      let dirents: import('node:fs').Dirent[];
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable dir — skip
      }
      for (const ent of dirents) {
        if (out.length >= MAX_SCAN_FILES) {
          this.fileCacheTruncated = true;
          return;
        }
        const abs = join(dir, ent.name);
        const relPath = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          await walk(abs, relPath, depth + 1);
          continue;
        }
        if (!ent.isFile()) continue;
        let size = 0;
        let mtimeMs = 0;
        try {
          const st = await stat(abs);
          size = st.size;
          mtimeMs = st.mtimeMs;
        } catch {
          continue; // vanished between readdir and stat
        }
        const { category, icon, ext } = classifyFile(ent.name);
        out.push({
          name: ent.name,
          relPath,
          absPath: abs,
          ext,
          category,
          icon,
          size,
          mtimeMs,
        });
      }
    };
    await walk(root, '', 0);
    return out;
  }

  /** Presence + per-category counts. Triggers (or reuses) the walk. */
  async getFileDirSummary(force = false): Promise<FileDirSummary> {
    const root = this.oriRoot();
    if (!root) {
      return { present: false, root: null, total: 0, byCategory: emptyCounts(), truncated: false };
    }
    const entries = await this.ensureFileCache(force);
    const byCategory = emptyCounts();
    for (const e of entries) byCategory[e.category] += 1;
    return {
      present: true,
      root,
      total: entries.length,
      byCategory,
      truncated: this.fileCacheTruncated,
    };
  }

  /** A filtered + sorted + paged slice of the `Ori` snapshot. */
  async listFileDir(opts: FileListOptions = {}): Promise<FileDirPage> {
    const entries = await this.ensureFileCache(false);
    const filtered = filterEntries(entries, opts, (e) => e.name);
    sortInPlace(filtered, opts.sort ?? 'time', opts.order ?? 'desc');
    return slicePage(filtered, opts);
  }

  /**
   * Validate + resolve an absolute path that MUST live under `File/Ori`, for the
   * image-preview media protocol. Returns the path only when it's inside the
   * tree AND is a real file — a crafted `path` can't escape to read other files.
   */
  async resolveLocalFile(absPath: string): Promise<string | null> {
    const root = this.oriRoot();
    if (!root || !absPath) return null;
    const abs = resolve(absPath);
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

  /** True when `absPath` sits inside `File/Ori` (used to gate reveal/open). */
  isUnderFileDir(absPath: string): boolean {
    const root = this.oriRoot();
    if (!root || !absPath) return false;
    const abs = resolve(absPath);
    const base = resolve(root);
    return abs === base || abs.startsWith(base + sep);
  }

  // ── 下载文件 (file_assistant.db) ────────────────────────────────────────────

  /** Cached snapshot of all file_assistant rows (null until first read). */
  private downloadCache: DownloadFileEntry[] | null = null;
  private downloadScan: Promise<DownloadFileEntry[]> | null = null;

  private async ensureDownloadCache(force = false): Promise<DownloadFileEntry[]> {
    if (!force && this.downloadCache) return this.downloadCache;
    if (this.downloadScan) return this.downloadScan;
    this.downloadScan = this.readDownloadRows()
      .then((rows) => {
        this.downloadCache = rows;
        return rows;
      })
      .finally(() => {
        this.downloadScan = null;
      });
    return this.downloadScan;
  }

  /** Read the whole file_assistant.db (both tables) into resolved entries. */
  private async readDownloadRows(): Promise<DownloadFileEntry[]> {
    let rows: FileAssistantRow[];
    try {
      rows = await this.session.fileAssistant.listAll(DOWNLOAD_SNAPSHOT_CAP, 0);
    } catch {
      return [];
    }
    return rows.map((r) => {
      const { category, icon, ext } = classifyFile(r.fileName);
      return {
        fileName: r.fileName,
        ext,
        category,
        icon,
        fileSize: Number(r.fileSize),
        timestamp: Number(r.timestamp),
        localPath: cleanLocalPath(r.localPath),
        exists: false, // filled per-page (see listDownloadFiles)
        msgId: r.msgId.toString(),
        sourceTable: r.sourceTable,
      };
    });
  }

  /**
   * A filtered + sorted + paged slice of file_assistant.db. Existence is probed
   * ONLY for the returned page (an fs.stat per row) so a huge db doesn't fan out
   * into tens of thousands of disk hits up front.
   */
  async listDownloadFiles(opts: FileListOptions = {}): Promise<DownloadFilePage> {
    const rows = await this.ensureDownloadCache(false);
    const filtered = filterEntries(rows, opts, (e) => e.fileName);
    sortInPlace(filtered, opts.sort ?? 'time', opts.order ?? 'desc');
    const page = slicePage(filtered, opts);
    // Probe existence for just this page.
    const probed = await Promise.all(
      page.entries.map(async (e) => ({ ...e, exists: await pathExists(e.localPath) })),
    );
    return { entries: probed, total: page.total };
  }

  /** Force both snapshots to rebuild on next read (the 刷新 button). */
  invalidate(): void {
    this.fileCache = null;
    this.downloadCache = null;
  }
}

// ── shared list helpers ────────────────────────────────────────────────────────

interface Sortable {
  name?: string;
  fileName?: string;
  size?: number;
  fileSize?: number;
  mtimeMs?: number;
  timestamp?: number;
  category: FileCategory;
}

function emptyCounts(): Record<FileCategory, number> {
  return {
    image: 0,
    video: 0,
    audio: 0,
    document: 0,
    archive: 0,
    code: 0,
    program: 0,
    other: 0,
  };
}

/** Category + case-insensitive substring filter, shared by both listings. */
function filterEntries<T extends Sortable>(
  entries: T[],
  opts: FileListOptions,
  nameOf: (e: T) => string,
): T[] {
  const cat = opts.category && opts.category !== 'all' ? opts.category : null;
  const q = (opts.search ?? '').trim().toLowerCase();
  if (!cat && !q) return entries.slice();
  return entries.filter((e) => {
    if (cat && e.category !== cat) return false;
    if (q && !nameOf(e).toLowerCase().includes(q)) return false;
    return true;
  });
}

/** In-place sort by time / name / size. */
function sortInPlace<T extends Sortable>(entries: T[], key: FileSortKey, order: FileSortOrder): void {
  const dir = order === 'asc' ? 1 : -1;
  entries.sort((a, b) => {
    let cmp: number;
    if (key === 'name') {
      cmp = (a.name ?? a.fileName ?? '').localeCompare(b.name ?? b.fileName ?? '', 'zh-Hans-CN');
    } else if (key === 'size') {
      cmp = (a.size ?? a.fileSize ?? 0) - (b.size ?? b.fileSize ?? 0);
    } else {
      cmp = (a.mtimeMs ?? a.timestamp ?? 0) - (b.mtimeMs ?? b.timestamp ?? 0);
    }
    return cmp * dir;
  });
}

function slicePage<T>(entries: T[], opts: FileListOptions): { entries: T[]; total: number } {
  const total = entries.length;
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = clampInt(opts.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  return { entries: entries.slice(offset, offset + limit), total };
}

async function pathExists(p: string): Promise<boolean> {
  if (!p) return false;
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** QQ NT stores localPath prefixed with `::NTOSFull::` — strip it. */
function cleanLocalPath(p: string): string {
  if (!p) return '';
  return p.startsWith('::NTOSFull::') ? p.slice('::NTOSFull::'.length) : p;
}

function clampInt(n: number, lo: number, hi: number): number {
  const x = Math.floor(Number.isFinite(n) ? n : lo);
  return Math.min(hi, Math.max(lo, x));
}

// ── classification (extension → category + icon) ────────────────────────────────

/**
 * One row per extension: its coarse category (tab bucket) and the icon basename
 * under `resources/fileIcon`. Deliberately richer than the chat's table — code
 * gains web/markup/scripting extensions (`.html`, `.css`, `.json`, `.go`, …),
 * images gain `.svg` / `.bmp` / `.heic`, etc. Unknown extensions fall back to
 * `{ other, unknown.png }`.
 */
const EXT_TABLE: Record<string, { category: FileCategory; icon: string }> = {
  // images
  jpg: { category: 'image', icon: 'image.png' },
  jpeg: { category: 'image', icon: 'image.png' },
  png: { category: 'image', icon: 'image.png' },
  gif: { category: 'image', icon: 'image.png' },
  webp: { category: 'image', icon: 'image.png' },
  bmp: { category: 'image', icon: 'image.png' },
  svg: { category: 'image', icon: 'image.png' },
  heic: { category: 'image', icon: 'image.png' },
  heif: { category: 'image', icon: 'image.png' },
  tiff: { category: 'image', icon: 'image.png' },
  tif: { category: 'image', icon: 'image.png' },
  ico: { category: 'image', icon: 'image.png' },
  psd: { category: 'image', icon: 'ps.png' },
  ai: { category: 'image', icon: 'ai.png' },
  sketch: { category: 'image', icon: 'sketch.png' },

  // video
  mp4: { category: 'video', icon: 'video.png' },
  mkv: { category: 'video', icon: 'video.png' },
  avi: { category: 'video', icon: 'video.png' },
  mov: { category: 'video', icon: 'video.png' },
  wmv: { category: 'video', icon: 'video.png' },
  flv: { category: 'video', icon: 'video.png' },
  webm: { category: 'video', icon: 'video.png' },
  m4v: { category: 'video', icon: 'video.png' },
  mpeg: { category: 'video', icon: 'video.png' },
  mpg: { category: 'video', icon: 'video.png' },
  '3gp': { category: 'video', icon: 'video.png' },

  // audio
  mp3: { category: 'audio', icon: 'audio.png' },
  wav: { category: 'audio', icon: 'audio.png' },
  flac: { category: 'audio', icon: 'audio.png' },
  m4a: { category: 'audio', icon: 'audio.png' },
  aac: { category: 'audio', icon: 'audio.png' },
  ogg: { category: 'audio', icon: 'audio.png' },
  wma: { category: 'audio', icon: 'audio.png' },
  aiff: { category: 'audio', icon: 'audio.png' },
  amr: { category: 'audio', icon: 'audio.png' },

  // documents
  doc: { category: 'document', icon: 'doc.png' },
  docx: { category: 'document', icon: 'doc.png' },
  pdf: { category: 'document', icon: 'pdf.png' },
  txt: { category: 'document', icon: 'txt.png' },
  md: { category: 'document', icon: 'txt.png' },
  rtf: { category: 'document', icon: 'txt.png' },
  ppt: { category: 'document', icon: 'ppt.png' },
  pptx: { category: 'document', icon: 'ppt.png' },
  xls: { category: 'document', icon: 'xls.png' },
  xlsx: { category: 'document', icon: 'xls.png' },
  csv: { category: 'document', icon: 'xls.png' },
  pages: { category: 'document', icon: 'pages.png' },
  numbers: { category: 'document', icon: 'numbers.png' },
  key: { category: 'document', icon: 'keynote.png' },
  epub: { category: 'document', icon: 'note.png' },
  mm: { category: 'document', icon: 'mindmap.png' },
  xmind: { category: 'document', icon: 'mindmap.png' },

  // archives
  zip: { category: 'archive', icon: 'zip.png' },
  rar: { category: 'archive', icon: 'rar.png' },
  '7z': { category: 'archive', icon: 'zip.png' },
  tar: { category: 'archive', icon: 'zip.png' },
  gz: { category: 'archive', icon: 'zip.png' },
  bz2: { category: 'archive', icon: 'zip.png' },
  xz: { category: 'archive', icon: 'zip.png' },
  iso: { category: 'archive', icon: 'zip.png' },

  // code / markup / config / scripting
  ts: { category: 'code', icon: 'code.png' },
  tsx: { category: 'code', icon: 'code.png' },
  js: { category: 'code', icon: 'code.png' },
  jsx: { category: 'code', icon: 'code.png' },
  mjs: { category: 'code', icon: 'code.png' },
  cjs: { category: 'code', icon: 'code.png' },
  vue: { category: 'code', icon: 'code.png' },
  c: { category: 'code', icon: 'code.png' },
  h: { category: 'code', icon: 'code.png' },
  cpp: { category: 'code', icon: 'code.png' },
  cc: { category: 'code', icon: 'code.png' },
  hpp: { category: 'code', icon: 'code.png' },
  cs: { category: 'code', icon: 'code.png' },
  py: { category: 'code', icon: 'code.png' },
  java: { category: 'code', icon: 'code.png' },
  kt: { category: 'code', icon: 'code.png' },
  go: { category: 'code', icon: 'code.png' },
  rs: { category: 'code', icon: 'code.png' },
  rb: { category: 'code', icon: 'code.png' },
  php: { category: 'code', icon: 'code.png' },
  swift: { category: 'code', icon: 'code.png' },
  dart: { category: 'code', icon: 'code.png' },
  lua: { category: 'code', icon: 'code.png' },
  sh: { category: 'code', icon: 'code.png' },
  bat: { category: 'code', icon: 'code.png' },
  ps1: { category: 'code', icon: 'code.png' },
  sql: { category: 'code', icon: 'code.png' },
  html: { category: 'code', icon: 'code.png' },
  htm: { category: 'code', icon: 'code.png' },
  css: { category: 'code', icon: 'code.png' },
  scss: { category: 'code', icon: 'code.png' },
  less: { category: 'code', icon: 'code.png' },
  json: { category: 'code', icon: 'code.png' },
  xml: { category: 'code', icon: 'code.png' },
  yml: { category: 'code', icon: 'code.png' },
  yaml: { category: 'code', icon: 'code.png' },
  toml: { category: 'code', icon: 'code.png' },
  ini: { category: 'code', icon: 'code.png' },

  // programs / installers
  exe: { category: 'program', icon: 'exe.png' },
  msi: { category: 'program', icon: 'exe.png' },
  apk: { category: 'program', icon: 'apk.png' },
  dmg: { category: 'program', icon: 'dmg.png' },
  pkg: { category: 'program', icon: 'pkg.png' },
  ipa: { category: 'program', icon: 'ipa.png' },
  deb: { category: 'program', icon: 'pkg.png' },
  rpm: { category: 'program', icon: 'pkg.png' },

  // misc
  ttf: { category: 'other', icon: 'font.png' },
  otf: { category: 'other', icon: 'font.png' },
  url: { category: 'other', icon: 'link.png' },
  bak: { category: 'other', icon: 'bak.png' },
};

/** Classify a file name into { category, icon, ext } for card rendering. */
export function classifyFile(name: string): {
  category: FileCategory;
  icon: string;
  ext: string;
} {
  const ext = extname(name).toLowerCase().replace(/^\./, '');
  const hit = ext ? EXT_TABLE[ext] : undefined;
  if (hit) return { category: hit.category, icon: hit.icon, ext };
  return { category: 'other', icon: 'unknown.png', ext };
}
