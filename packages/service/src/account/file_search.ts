/**
 * FileSearchService — locates QQ NT's media files (pic, video, ptt, file)
 * using timestamps and filenames.
 */

import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, extname } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';

export type FileType = 'pic' | 'video' | 'ptt' | 'file' | 'emoji';

export interface SearchResult {
  /** Absolute path to the located media, or null if not on disk. */
  source: string | null;
  /**
   * Absolute path to a thumbnail/cover (pic/video), or — for file — a
   * `<ext>.png` icon basename under `resources/fileicon`. Never null for file
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
  private readonly directories = new Map<
    string,
    {
      signature: string;
      entries: Dirent[];
      exact: Map<string, string>;
      variants: Map<string, string>;
    }
  >();
  private readonly reading = new Map<string, Promise<Dirent[]>>();
  private readonly searches = new Map<string, Promise<SearchResult>>();
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
    md5?: string,
  ): Promise<SearchResult> {
    const key = JSON.stringify([timestamp, filename, type, md5]);
    const pending = this.searches.get(key);
    if (pending) return pending;
    const task = this.search(timestamp, filename, type, md5);
    // 只合并在途查找，不缓存最终缺图结果；新下载由目录元数据立即失效。
    if (this.searches.size < 256) this.searches.set(key, task);
    try {
      return await task;
    } finally {
      if (this.searches.get(key) === task) this.searches.delete(key);
    }
  }

  private async search(
    timestamp: number,
    filename: string,
    type: FileType,
    md5?: string,
  ): Promise<SearchResult> {
    // 旧消息可能只有 16 字节 MD5、没有文件名。空字符串绝不能当作子串匹配条件。
    const identity =
      (type === 'pic' || type === 'emoji') && md5 && /^[a-f0-9]{32}$/i.test(md5)
        ? md5.toLowerCase()
        : filename;
    if (!identity || identity === '.' || identity === '..' || /[\\/]/.test(identity)) {
      return { source: null, thumb: type === 'file' ? this.getIconForExtension('') : null };
    }
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
      const result = await this.searchInMonthDir(uin, type, m, identity);
      if (result.source || result.thumb) return result;
    }

    // Animated emoji are content-hashed and reused, so the file often lives in a
    // different month than the message's send time (and a bad timestamp would
    // miss entirely). Fall back to scanning every month folder.
    if (type === 'emoji') {
      const baseDir = this.getTypeDir(uin, type);
      if (baseDir) {
        for (const m of await this.listMonths(baseDir)) {
          if (monthsToTry.includes(m)) continue;
          const result = await this.searchInMonthDir(uin, type, m, identity);
          if (result.thumb || result.source) return result;
        }
      }
    }

    return { source: null, thumb: null };
  }

  /** Sub-directory names under a media base dir (the `<YYYY-MM>` buckets), newest first. */
  private async listMonths(baseDir: string): Promise<string[]> {
    return (await this.readDirectory(baseDir))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));
  }

  private async searchInMonthDir(
    uin: string,
    type: Exclude<FileType, 'file'>,
    month: string,
    filename: string,
  ): Promise<SearchResult> {
    const baseDir = this.getTypeDir(uin, type);
    if (!baseDir) return { source: null, thumb: null };

    const monthDir = join(baseDir, month);

    const oriDir = join(monthDir, 'Ori');
    const thumbDir = join(monthDir, 'Thumb');

    // pic/video share a stem: the cover is often `<stem>_0.jpg` while the source
    // is `<stem>.<ext>`, so we match by stem (no extension). ptt has no separate
    // thumbnail, so we match the full filename and skip the Thumb dir.
    if (type === 'ptt') {
      return { source: await this.findFirstMatch(oriDir, filename, false), thumb: null };
    }

    const stem = stripExt(filename);

    // Animated emoji (pic subType 1) has no "original" — the displayable image
    // lives in Ori (preferred) or Thumb. Return it as `thumb`, source = null.
    if (type === 'emoji') {
      const display =
        (await this.findFirstMatch(oriDir, stem)) ?? (await this.findFirstMatch(thumbDir, stem));
      return { source: null, thumb: display };
    }

    const [source, thumb] = await Promise.all([
      this.findFirstMatch(oriDir, stem),
      this.findFirstMatch(thumbDir, stem),
    ]);
    return { source, thumb };
  }

  private async searchFile(uin: string, filename: string): Promise<SearchResult> {
    // Files have no separate thumbnail — the icon is derived from the extension
    // and is ALWAYS returned, even when the source isn't on disk (the user's QQ
    // download dir, not Ori, is the real location; resolving it is future work).
    const ext = extname(filename).toLowerCase().slice(1);
    const thumb = this.getIconForExtension(ext);

    const baseDir = this.platform.fileDir(uin);
    if (!baseDir) return { source: null, thumb };

    // Files keep their full name (with extension) on disk.
    const oriDir = join(baseDir, 'Ori');
    const source = await this.findRecursiveMatch(oriDir, filename);
    return { source, thumb };
  }

  private async findFirstMatch(
    dir: string,
    needle: string,
    variants = true,
  ): Promise<string | null> {
    if (!needle) return null;
    const entries = await this.readDirectory(dir);
    const cached = this.directories.get(dir);
    if (cached?.entries === entries) {
      const name =
        cached.exact.get(needle.toLowerCase()) ??
        (variants ? cached.variants.get(needle.toLowerCase()) : undefined);
      return name ? join(dir, name) : null;
    }
    // 超大目录不常驻缓存，仍保留完全匹配优先于数字变体的规则。
    let fallback: string | null = null;
    const key = needle.toLowerCase();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name.toLowerCase(),
        stem = stripExt(name);
      if (name === key || stem === key) return join(dir, entry.name);
      if (!fallback && variants && stem.startsWith(key) && /^_\d+$/.test(stem.slice(key.length)))
        fallback = join(dir, entry.name);
    }
    return fallback;
  }

  private async readDirectory(dir: string): Promise<Dirent[]> {
    const pending = this.reading.get(dir);
    if (pending) return pending;
    const task = (async () => {
      try {
        const info = await stat(dir, { bigint: true });
        const signature = `${info.ino}:${info.mtimeNs}:${info.ctimeNs}`;
        const cached = this.directories.get(dir);
        if (cached?.signature === signature) return cached.entries;
        this.directories.delete(dir);
        const entries = await readdir(dir, { withFileTypes: true });
        if (entries.length <= 8000) {
          const exact = new Map<string, string>(),
            variants = new Map<string, string>();
          for (const entry of entries) {
            if (!entry.isFile()) continue;
            const name = entry.name.toLowerCase(),
              stem = stripExt(name);
            if (!exact.has(name)) exact.set(name, entry.name);
            if (!exact.has(stem)) exact.set(stem, entry.name);
            const variant = /^(.*)_\d+$/.exec(stem)?.[1];
            if (variant && !variants.has(variant)) variants.set(variant, entry.name);
          }
          this.directories.set(dir, { signature, entries, exact, variants });
          // 文件数和目录数双重限额，避免长时间切会话累积媒体目录。
          let count = 0;
          for (const value of this.directories.values()) count += value.entries.length;
          while (this.directories.size > 128 || count > 32000) {
            const key = this.directories.keys().next().value!;
            count -= this.directories.get(key)!.entries.length;
            this.directories.delete(key);
          }
        }
        return entries;
      } catch {
        this.directories.delete(dir);
        return [];
      }
    })();
    this.reading.set(dir, task);
    try {
      return await task;
    } finally {
      this.reading.delete(dir);
    }
  }

  private async findRecursiveMatch(dir: string, filename: string): Promise<string | null> {
    const lcFilename = filename.toLowerCase();
    try {
      const entries = await this.readDirectory(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = await this.findRecursiveMatch(fullPath, filename);
          if (found) return found;
        } else if (entry.isFile() && entry.name.toLowerCase().includes(lcFilename)) {
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
      case 'pic':
        return this.platform.picDir(uin);
      case 'ptt':
        return this.platform.pttDir(uin);
      case 'video':
        return this.platform.videoDir(uin);
      case 'emoji':
        return this.platform.emojiRecvDir(uin);
    }
  }

  private getRelativeMonth(baseDate: Date, delta: number): string {
    const d = new Date(baseDate);
    d.setDate(1);
    d.setMonth(d.getMonth() + delta);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  private getIconForExtension(ext: string): string {
    const iconMap: Record<string, string> = {
      ai: 'ai.png',
      apk: 'apk.png',
      mp3: 'audio.png',
      wav: 'audio.png',
      flac: 'audio.png',
      m4a: 'audio.png',
      bak: 'bak.png',
      ts: 'code.png',
      js: 'code.png',
      c: 'code.png',
      cpp: 'code.png',
      py: 'code.png',
      java: 'code.png',
      dmg: 'dmg.png',
      doc: 'doc.png',
      docx: 'doc.png',
      exe: 'exe.png',
      ttf: 'font.png',
      otf: 'font.png',
      jpg: 'image.png',
      jpeg: 'image.png',
      png: 'image.png',
      gif: 'image.png',
      webp: 'image.png',
      ipa: 'ipa.png',
      key: 'keynote.png',
      url: 'link.png',
      pdf: 'pdf.png',
      pkg: 'pkg.png',
      ppt: 'ppt.png',
      pptx: 'ppt.png',
      psd: 'ps.png',
      rar: 'rar.png',
      txt: 'txt.png',
      md: 'txt.png',
      mp4: 'video.png',
      mkv: 'video.png',
      avi: 'video.png',
      mov: 'video.png',
      xls: 'xls.png',
      xlsx: 'xls.png',
      zip: 'zip.png',
      '7z': 'zip.png',
      tar: 'zip.png',
      gz: 'zip.png',
    };

    const icon = iconMap[ext] || 'unknown.png';
    // Path relative to weq's asset protocol or absolute path
    // Assuming the consumer knows how to resolve from /resources/fileicon
    return icon;
  }
}
