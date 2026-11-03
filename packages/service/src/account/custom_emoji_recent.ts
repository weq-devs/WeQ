/**
 * 「自定义表情 → 最近上传」记录。
 *
 * 用户在表情面板上传过的图片，按账号落一份索引（`accounts/<id>/custom_emoji_recent.json`），
 * 下次打开面板可以直接点选重发，不用再翻文件。
 *
 * **只存索引，不存图片字节**：原图可能几十 MB，复制进账号目录既浪费空间又与
 * 「用户数据不入库」的约定相冲突。因此——
 *   - 记 md5 + 尺寸 + 文件名，用于预览与去重；
 *   - 缩略图由渲染层按 md5 从**媒体缓存**里取（发过一次后 `weq-media://` 就有缓存）；
 *   - 缓存被清掉后条目仍在，但预览会退化成占位图；重发需要重新选文件。
 *
 * 条目上限与有效期都故意保守：这是「最近用过」的快捷入口，不是图库。
 */

import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomicSync } from '../common/atomic_write';

/** 最多保留多少条。 */
export const CUSTOM_EMOJI_RECENT_MAX = 40;
/** 条目有效期（天）—— 超过就不再显示。 */
export const CUSTOM_EMOJI_RECENT_TTL_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CustomEmojiRecentEntry {
  /** 小写 32 位 hex。 */
  md5: string;
  /** 收端显示的文件名（上传时用的那个）。 */
  fileName: string;
  /** 字节数。 */
  fileSize: number;
  width: number;
  height: number;
  /** NTV2 picFormat（1000 jpg / 1001 png / 2000 gif …）。 */
  picFormat: number;
  /** 最近一次发送的时间戳（毫秒）。 */
  usedAt: number;
}

export interface CustomEmojiRecentOptions {
  /** 索引文件路径；空 / 缺省时只做内存记录。 */
  storePath?: string | null;
  /** 有效期（天）。 */
  ttlDays?: number;
  now?: () => number;
}

/**
 * 「最近上传」的读写。
 *
 * 写入是**同步**的：面板点选后要立刻反映在列表里，异步落盘会让下一次打开读到旧数据。
 * 文件很小（最多 40 条），同步写不会造成可感知的卡顿。
 */
export class CustomEmojiRecentService {
  private entries: CustomEmojiRecentEntry[] = [];

  constructor(private readonly opts: CustomEmojiRecentOptions = {}) {
    this.load();
  }

  /** 按最近使用倒序返回有效条目（已剔除过期）。 */
  list(): CustomEmojiRecentEntry[] {
    const cutoff = this.now() - this.ttlMs();
    return this.entries
      .filter((entry) => entry.usedAt >= cutoff)
      .sort((a, b) => b.usedAt - a.usedAt);
  }

  /**
   * 记一次上传/发送。
   *
   * 同一个 md5 只保留一条（更新时间戳并移到最前），这样重复发同一张图不会刷屏。
   * 超过上限时丢最旧的。
   */
  record(entry: Omit<CustomEmojiRecentEntry, 'usedAt'>): CustomEmojiRecentEntry {
    const usedAt = this.now();
    const next: CustomEmojiRecentEntry = { ...entry, usedAt };
    this.entries = [next, ...this.entries.filter((item) => item.md5 !== entry.md5)].slice(
      0,
      CUSTOM_EMOJI_RECENT_MAX,
    );
    this.flush();
    return next;
  }

  /** 清空（用户主动清理缓存时调用）。 */
  clear(): void {
    this.entries = [];
    this.flush();
  }

  private ttlMs(): number {
    const days = Math.max(1, Math.round(this.opts.ttlDays ?? CUSTOM_EMOJI_RECENT_TTL_DAYS));
    return days * DAY_MS;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private load(): void {
    const path = this.opts.storePath;
    if (!path) return;
    try {
      if (!existsSync(path)) return;
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as { entries?: unknown };
      const rows = raw?.entries;
      if (!Array.isArray(rows)) return;
      const cutoff = this.now() - this.ttlMs();
      const seen = new Set<string>();
      const parsed: CustomEmojiRecentEntry[] = [];
      for (const value of rows) {
        const entry = parseEntry(value);
        if (!entry) continue;
        if (entry.usedAt < cutoff) continue;
        if (seen.has(entry.md5)) continue;
        seen.add(entry.md5);
        parsed.push(entry);
      }
      this.entries = parsed.sort((a, b) => b.usedAt - a.usedAt).slice(0, CUSTOM_EMOJI_RECENT_MAX);
    } catch {
      // 索引损坏当作空：不影响聊天，下次记录会整份重写。
      this.entries = [];
    }
  }

  private flush(): void {
    const path = this.opts.storePath;
    if (!path) return;
    try {
      writeFileAtomicSync(path, JSON.stringify({ version: 1, entries: this.entries }));
    } catch {
      // 落盘失败不影响本次发送。
    }
  }
}

function parseEntry(value: unknown): CustomEmojiRecentEntry | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<CustomEmojiRecentEntry>;
  if (typeof row.md5 !== 'string' || !/^[0-9a-f]{32}$/.test(row.md5)) return null;
  const usedAt = Number(row.usedAt);
  if (!Number.isFinite(usedAt) || usedAt <= 0) return null;
  return {
    md5: row.md5,
    fileName: typeof row.fileName === 'string' ? row.fileName : `${row.md5}`,
    fileSize: Number.isFinite(row.fileSize) ? Number(row.fileSize) : 0,
    width: Number.isFinite(row.width) ? Number(row.width) : 0,
    height: Number.isFinite(row.height) ? Number(row.height) : 0,
    picFormat: Number.isFinite(row.picFormat) ? Number(row.picFormat) : 1000,
    usedAt,
  };
}
