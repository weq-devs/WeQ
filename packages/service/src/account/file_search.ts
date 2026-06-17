/**
 * FileSearchService — locates QQ NT's media files (pic, video, ptt, file)
 * using timestamps and filenames.
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';

export type FileType = 'pic' | 'video' | 'ptt' | 'file' | 'emoji';

export interface SearchResult {
  /** Absolute path to the located media, or null if not on disk. */
  source: string | null;
  /**
   * Absolute path to a thumbnail/cover (pic/video), or — for file — a
   * `<ext>.png` icon basename under `resources/fileIcon`. Never null for file
   * (icon is derived from the name even when the source isn't found).
   */
  thumb: string | null;
}

/** Drop a trailing extension: `abc.mp4` → `abc`. Leaves extension-less names. */
function stripExt(filename: string): string {
  const ext = extname(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

export class FileSearchService {
  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
  ) {}

  /**
   * Search for a file by timestamp, name, and type.
   */
  async findFile(
    timestamp: number,
    filename: string,
    type: FileType,
  ): Promise<SearchResult> {
    const uin = this.session.context.uin;
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const targetMonth = `${year}-${month}`;

    if (type === 'file') {
      return this.searchFile(uin, filename);
    }

    // Month rollback logic for pic, video, ptt: current, prev, next.
    const monthsToTry = [
      targetMonth,
      this.getRelativeMonth(date, -1),
      this.getRelativeMonth(date, 1),
    ];

    for (const m of monthsToTry) {
      const result = this.searchInMonthDir(uin, type, m, filename);
      if (result.source || result.thumb) return result;
    }

    // Animated emoji are content-hashed and reused, so the file often lives in a
    // different month than the message's send time (and a bad timestamp would
    // miss entirely). Fall back to scanning every month folder.
    if (type === 'emoji') {
      const baseDir = this.getTypeDir(uin, type);
      if (baseDir && existsSync(baseDir)) {
        for (const m of this.listMonths(baseDir)) {
          if (monthsToTry.includes(m)) continue;
          const result = this.searchInMonthDir(uin, type, m, filename);
          if (result.thumb || result.source) return result;
        }
      }
    }

    return { source: null, thumb: null };
  }

  /** Sub-directory names under a media base dir (the `<YYYY-MM>` buckets), newest first. */
  private listMonths(baseDir: string): string[] {
    try {
      return readdirSync(baseDir)
        .filter((e) => {
          try {
            return statSync(join(baseDir, e)).isDirectory();
          } catch {
            return false;
          }
        })
        .sort((a, b) => b.localeCompare(a));
    } catch {
      return [];
    }
  }

  private searchInMonthDir(
    uin: string,
    type: Exclude<FileType, 'file'>,
    month: string,
    filename: string,
  ): SearchResult {
    const baseDir = this.getTypeDir(uin, type);
    if (!baseDir) return { source: null, thumb: null };

    const monthDir = join(baseDir, month);
    if (!existsSync(monthDir)) return { source: null, thumb: null };

    const oriDir = join(monthDir, 'Ori');
    const thumbDir = join(monthDir, 'Thumb');

    // pic/video share a stem: the cover is often `<stem>_0.jpg` while the source
    // is `<stem>.<ext>`, so we match by stem (no extension). ptt has no separate
    // thumbnail, so we match the full filename and skip the Thumb dir.
    if (type === 'ptt') {
      return { source: this.findFirstMatch(oriDir, filename), thumb: null };
    }

    const stem = stripExt(filename);

    // Animated emoji (pic subType 1) has no "original" — the displayable image
    // lives in Ori (preferred) or Thumb. Return it as `thumb`, source = null.
    if (type === 'emoji') {
      const display = this.findFirstMatch(oriDir, stem) ?? this.findFirstMatch(thumbDir, stem);
      return { source: null, thumb: display };
    }

    return {
      source: this.findFirstMatch(oriDir, stem),
      thumb: this.findFirstMatch(thumbDir, stem),
    };
  }

  private searchFile(uin: string, filename: string): SearchResult {
    // Files have no separate thumbnail — the icon is derived from the extension
    // and is ALWAYS returned, even when the source isn't on disk (the user's QQ
    // download dir, not Ori, is the real location; resolving it is future work).
    const ext = extname(filename).toLowerCase().slice(1);
    const thumb = this.getIconForExtension(ext);

    const baseDir = this.platform.fileDir(uin);
    if (!baseDir) return { source: null, thumb };

    // Files keep their full name (with extension) on disk.
    const oriDir = join(baseDir, 'Ori');
    const source = this.findRecursiveMatch(oriDir, filename);
    return { source, thumb };
  }

  private findFirstMatch(dir: string, needle: string): string | null {
    if (!existsSync(dir)) return null;
    // Match case-insensitively — QQ stores hex names that may differ in case
    // between the DB field and the on-disk filename.
    const lcNeedle = needle.toLowerCase();
    try {
      const entries = readdirSync(dir);
      // Prefer the entry whose stem equals the needle exactly (the real source,
      // e.g. `<stem>.mp4`) over a substring hit (e.g. the `<stem>_0.jpg` cover
      // sitting in the same dir) so a stem search returns the right file.
      let fallback: string | null = null;
      for (const entry of entries) {
        const lcEntry = entry.toLowerCase();
        if (stripExt(lcEntry) === lcNeedle) return join(dir, entry);
        if (!fallback && lcEntry.includes(lcNeedle)) fallback = join(dir, entry);
      }
      return fallback;
    } catch {
      // Unreadable dir.
    }
    return null;
  }

  private findRecursiveMatch(dir: string, filename: string): string | null {
    if (!existsSync(dir)) return null;
    const lcFilename = filename.toLowerCase();
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          const found = this.findRecursiveMatch(fullPath, filename);
          if (found) return found;
        } else if (entry.toLowerCase().includes(lcFilename)) {
          return fullPath;
        }
      }
    } catch {
      // Unreadable entry.
    }
    return null;
  }

  private getTypeDir(uin: string, type: Exclude<FileType, 'file'>): string | null {
    switch (type) {
      case 'pic': return this.platform.picDir(uin);
      case 'ptt': return this.platform.pttDir(uin);
      case 'video': return this.platform.videoDir(uin);
      case 'emoji': return this.platform.emojiRecvDir(uin);
    }
  }

  private getRelativeMonth(baseDate: Date, delta: number): string {
    const d = new Date(baseDate);
    d.setMonth(d.getMonth() + delta);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  private getIconForExtension(ext: string): string {
    const iconMap: Record<string, string> = {
      'ai': 'ai.png',
      'apk': 'apk.png',
      'mp3': 'audio.png', 'wav': 'audio.png', 'flac': 'audio.png', 'm4a': 'audio.png',
      'bak': 'bak.png',
      'ts': 'code.png', 'js': 'code.png', 'c': 'code.png', 'cpp': 'code.png', 'py': 'code.png', 'java': 'code.png',
      'dmg': 'dmg.png',
      'doc': 'doc.png', 'docx': 'doc.png',
      'exe': 'exe.png',
      'ttf': 'font.png', 'otf': 'font.png',
      'jpg': 'image.png', 'jpeg': 'image.png', 'png': 'image.png', 'gif': 'image.png', 'webp': 'image.png',
      'ipa': 'ipa.png',
      'key': 'keynote.png',
      'url': 'link.png',
      'pdf': 'pdf.png',
      'pkg': 'pkg.png',
      'ppt': 'ppt.png', 'pptx': 'ppt.png',
      'psd': 'ps.png',
      'rar': 'rar.png',
      'txt': 'txt.png', 'md': 'txt.png',
      'mp4': 'video.png', 'mkv': 'video.png', 'avi': 'video.png', 'mov': 'video.png',
      'xls': 'xls.png', 'xlsx': 'xls.png',
      'zip': 'zip.png', '7z': 'zip.png', 'tar': 'zip.png', 'gz': 'zip.png',
    };

    const icon = iconMap[ext] || 'unknown.png';
    // Path relative to weq's asset protocol or absolute path
    // Assuming the consumer knows how to resolve from /resources/fileIcon
    return icon;
  }
}
