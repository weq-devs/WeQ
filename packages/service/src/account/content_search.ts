import { existsSync, readFileSync, statSync } from 'node:fs';
import { writeFileAtomicSync } from '../common/atomic_write';

export const CONTENT_SEARCH_CATEGORIES = [
  'qzonePost',
  'qzoneAlbum',
  'groupAlbum',
  'groupFile',
  'mailMessage',
  'marketEmoji',
  'guildMessage',
] as const;
export type ContentSearchCategory = (typeof CONTENT_SEARCH_CATEGORIES)[number];
export type ContentSearchTarget =
  | { kind: 'qzonePost'; uin: string; tid: string }
  | { kind: 'qzoneAlbum'; uin: string; albumId: string }
  | { kind: 'groupAlbum'; groupCode: string; albumId: string }
  | { kind: 'groupFile'; groupCode: string; folderId: string; fileId: string }
  | { kind: 'mailMessage'; id: string; folderId: number }
  | { kind: 'marketEmoji'; packId: string }
  | { kind: 'guildMessage'; nodeId: string; msgId: string; msgSeq: string };
export interface ContentSearchRecord {
  detail?: boolean;
  target: ContentSearchTarget;
  title: string;
  content: string;
  sourceName: string;
  time: number;
}
export interface ContentSearchHit extends ContentSearchRecord {
  category: ContentSearchCategory;
  id: string;
  observedAt: number;
}
export interface ContentSearchCoverage {
  available?: boolean;
  scope: 'observed-cache' | 'local-database' | 'offline-catalog';
  records: number;
  limited: boolean;
  updatedAt: number | null;
  persistenceFailed?: boolean;
}
export interface ContentSearchPage {
  items: ContentSearchHit[];
  total: number;
  coverage: ContentSearchCoverage;
}

export function contentSearchKey(target: ContentSearchTarget): string {
  switch (target.kind) {
    case 'qzonePost':
      return JSON.stringify([target.kind, target.uin, target.tid]);
    case 'qzoneAlbum':
      return JSON.stringify([target.kind, target.uin, target.albumId]);
    case 'groupAlbum':
      return JSON.stringify([target.kind, target.groupCode, target.albumId]);
    case 'groupFile':
      return JSON.stringify([target.kind, target.groupCode, target.folderId, target.fileId]);
    case 'mailMessage':
      return JSON.stringify([target.kind, target.id]);
    case 'marketEmoji':
      return JSON.stringify([target.kind, target.packId]);
    case 'guildMessage':
      return JSON.stringify([target.kind, target.nodeId, target.msgId]);
  }
}

function targetFrom(value: unknown): ContentSearchTarget | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    qzonePost: ['uin', 'tid'],
    qzoneAlbum: ['uin', 'albumId'],
    groupAlbum: ['groupCode', 'albumId'],
    groupFile: ['groupCode', 'folderId', 'fileId'],
    mailMessage: ['id'],
    marketEmoji: ['packId'],
    guildMessage: ['nodeId', 'msgId', 'msgSeq'],
  };
  if (typeof row.kind !== 'string' || !Object.hasOwn(fields, row.kind)) return null;
  if (
    fields[row.kind]!.some(
      (key) =>
        typeof row[key] !== 'string' ||
        !(row[key] as string).length ||
        (row[key] as string).length > 4096,
    )
  )
    return null;
  for (const key of ['uin', 'groupCode'])
    if (key in row && !/^\d+$/.test(String(row[key]))) return null;
  if (row.kind === 'qzonePost' && !/^[a-zA-Z0-9_-]{1,128}$/.test(String(row.tid))) return null;
  if (
    row.kind === 'mailMessage' &&
    (typeof row.folderId !== 'number' || !Number.isSafeInteger(row.folderId) || row.folderId < 0)
  )
    return null;
  for (const key of ['nodeId', 'msgSeq'])
    if (key in row && !/^-?\d+$/.test(String(row[key]))) return null;
  const clean: Record<string, unknown> = { kind: row.kind };
  for (const key of fields[row.kind]!) clean[key] = row[key];
  if (row.kind === 'mailMessage') clean.folderId = row.folderId;
  return clean as unknown as ContentSearchTarget;
}

export function contentSearchSnippet(content: string, keyword: string): string {
  const at = content.toLocaleLowerCase().indexOf(keyword.trim().toLocaleLowerCase());
  const start = Math.max(0, at - 48);
  const end = Math.max(start + 220, at + keyword.length);
  return `${start ? '…' : ''}${content.slice(start, end)}${content.length > end ? '…' : ''}`;
}

/** 只保存已观察的正文与定位身份，不保存原始 HTML、下载链接、票据或响应包。 */
export class ContentSearchStore {
  private records = new Map<string, ContentSearchHit>();
  private sizes = new Map<string, number>();
  private bytes = 0;
  private limited = new Set<ContentSearchCategory>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private persistenceFailed = false;
  private writable = true;
  constructor(
    private readonly path: string,
    private readonly maxBytes = 16 * 1024 * 1024,
    private readonly maxRecords = 20_000,
  ) {
    if (!existsSync(path)) return;
    try {
      if (statSync(path).size > maxBytes * 2) {
        this.writable = false;
        this.persistenceFailed = true;
        return;
      }
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!raw || typeof raw !== 'object') {
        this.writable = false;
        this.persistenceFailed = true;
        return;
      }
      const value = raw as { version?: unknown; items?: unknown; limited?: unknown };
      if (value.version !== 1 || !Array.isArray(value.items)) {
        this.writable = false;
        this.persistenceFailed = true;
        return;
      }
      if (Array.isArray(value.limited))
        for (const item of value.limited)
          if (CONTENT_SEARCH_CATEGORIES.includes(item)) this.limited.add(item);
      for (const entry of value.items) {
        if (!entry || typeof entry !== 'object') continue;
        const target = targetFrom(entry.target);
        if (
          !target ||
          typeof entry.title !== 'string' ||
          typeof entry.content !== 'string' ||
          typeof entry.sourceName !== 'string' ||
          !Number.isFinite(entry.time) ||
          !Number.isFinite(entry.observedAt)
        )
          continue;
        this.insert(
          {
            target,
            title: entry.title,
            content: entry.content,
            sourceName: entry.sourceName,
            time: entry.time,
            detail: entry.detail === true,
          },
          entry.observedAt,
        );
      }
    } catch {
      this.persistenceFailed = true;
      this.writable = false;
    }
  }
  private insert(record: ContentSearchRecord, observedAt: number) {
    const id = contentSearchKey(record.target);
    const previous = this.records.get(id);
    const retainDetail = Boolean(previous?.detail && !record.detail);
    this.bytes -= this.sizes.get(id) ?? 0;
    this.records.delete(id);
    const rawContent = retainDetail ? previous!.content : record.content;
    const content = rawContent.slice(0, 1_000_000);
    if (content.length !== rawContent.length) this.limited.add(record.target.kind);
    const hit: ContentSearchHit = {
      target: { ...record.target },
      title: (record.title || previous?.title || record.sourceName).slice(0, 4096),
      content,
      sourceName: record.sourceName.slice(0, 4096),
      time: record.time || previous?.time || 0,
      category: record.target.kind,
      id,
      detail: record.detail || retainDetail,
      observedAt: retainDetail ? previous!.observedAt : observedAt,
    };
    const size = Buffer.byteLength(JSON.stringify(hit));
    this.records.set(id, hit);
    this.sizes.set(id, size);
    this.bytes += size;
    while (this.bytes > this.maxBytes || this.records.size > this.maxRecords) {
      const first = this.records.entries().next().value;
      if (!first) break;
      this.limited.add(first[1].category);
      this.records.delete(first[0]);
      this.bytes -= this.sizes.get(first[0]) ?? 0;
      this.sizes.delete(first[0]);
    }
  }
  remember(records: readonly ContentSearchRecord[]) {
    if (this.closed || !records.length) return;
    for (const record of records) {
      const target = targetFrom(record.target);
      if (
        target &&
        typeof record.title === 'string' &&
        typeof record.content === 'string' &&
        typeof record.sourceName === 'string' &&
        Number.isFinite(record.time)
      )
        this.insert({ ...record, target }, Date.now());
    }
    this.schedule();
  }
  remove(target: ContentSearchTarget) {
    if (this.closed) return;
    const key = contentSearchKey(target);
    this.bytes -= this.sizes.get(key) ?? 0;
    this.sizes.delete(key);
    this.records.delete(key);
    this.schedule();
  }
  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 250);
    this.timer.unref();
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.writable) return;
    try {
      writeFileAtomicSync(
        this.path,
        JSON.stringify({
          version: 1,
          items: [...this.records.values()],
          limited: [...this.limited],
        }),
      );
      this.persistenceFailed = false;
    } catch {
      this.persistenceFailed = true;
    }
  }
  close() {
    this.flush();
    this.closed = true;
  }
  search(
    category: ContentSearchCategory,
    keyword: string,
    limit: number,
    offset = 0,
  ): ContentSearchPage {
    const pool = [...this.records.values()].filter((row) => row.category === category);
    const needle = keyword.trim().toLocaleLowerCase();
    const ranked = needle
      ? pool
          .filter((row) =>
            `${row.title}\n${row.sourceName}\n${row.content}`.toLocaleLowerCase().includes(needle),
          )
          .sort(
            (a, b) => b.time - a.time || b.observedAt - a.observedAt || a.id.localeCompare(b.id),
          )
      : [];
    return {
      items: ranked.slice(offset, offset + limit).map((row) => ({
        ...structuredClone(row),
        content: contentSearchSnippet(row.content, needle),
      })),
      total: ranked.length,
      coverage: {
        scope: 'observed-cache',
        records: pool.length,
        limited: this.limited.has(category),
        updatedAt: pool.reduce<number | null>((at, row) => Math.max(at ?? 0, row.observedAt), null),
        ...(this.persistenceFailed ? { persistenceFailed: true } : {}),
      },
    };
  }
}
