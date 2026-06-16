/**
 * FileSearchService — locates QQ NT's media files (pic, video, ptt, file)
 * using timestamps and filenames.
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';

export type FileType = 'pic' | 'video' | 'ptt' | 'file';

export interface SearchResult {
  source: string | null;
  thumb: string | null;
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

    return { source: null, thumb: null };
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

    const source = this.findFirstMatch(oriDir, filename);
    let thumb: string | null = null;

    if (type === 'pic' || type === 'video') {
      thumb = this.findFirstMatch(thumbDir, filename);
    }

    return { source, thumb };
  }

  private searchFile(uin: string, filename: string): SearchResult {
    const baseDir = this.platform.fileDir(uin);
    if (!baseDir) return { source: null, thumb: null };

    const oriDir = join(baseDir, 'Ori');
    const source = this.findRecursiveMatch(oriDir, filename);

    if (!source) {
      return { source: null, thumb: null };
    }

    // Map extension to icon for file thumbnails.
    const ext = extname(source).toLowerCase().slice(1);
    const thumb = this.getIconForExtension(ext);

    return { source, thumb };
  }

  private findFirstMatch(dir: string, filename: string): string | null {
    if (!existsSync(dir)) return null;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.includes(filename)) {
          return join(dir, entry);
        }
      }
    } catch {
      // Unreadable dir.
    }
    return null;
  }

  private findRecursiveMatch(dir: string, filename: string): string | null {
    if (!existsSync(dir)) return null;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          const found = this.findRecursiveMatch(fullPath, filename);
          if (found) return found;
        } else if (entry.includes(filename)) {
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
