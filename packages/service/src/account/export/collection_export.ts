/**
 * 收藏导出器 —— 导出 QQ 收藏（`collection.db → collection_list_info_table`）为
 * csv / xlsx / json / txt。
 *
 * 与消息导出流水线无关：数据来自本地收藏库，一次性翻页拉全后写盘。拉取能力由
 * deps 注入（照 contacts / qzone deps 的模式；bigint 与 blob 已在注入侧归一化 ——
 * 传进来的就是**已拍平、可序列化**的行，正好等价于 IPC 的 `CollectionItemWire`）。
 *
 * 收藏是异构内容（文本 / 链接 / 图片 / 语音 / 视频 / 文件 / 位置 / 图文），这里把
 * 每种 kind 收敛到一套统一列：类型 / 时间 / 来源 / 标题 / 正文 / 链接 / 图片 / 文件
 * / 时长 / 位置 / cid。图片只写 collector-CDN 的 URL（不下载）。
 */

import { writeTable, type Col, type TableFormat } from './table_writer';

/** 收藏图片：collector-CDN uri 加固有尺寸。 */
export interface CollectionExportPic {
  uri: string;
  width: number;
  height: number;
}

/**
 * 一条**已拍平、可序列化**的收藏行（bigint→string、blob 丢弃）。
 * 结构等价于 app 侧的 `CollectionItemWire`，最多一个内容字段非空。
 */
export interface CollectionExportRow {
  cid: string;
  /** 'text'|'link'|'gallery'|'audio'|'video'|'file'|'location'|'richMedia'|'unknown' */
  kind: string;
  type: number;
  createTime: number;
  collectTime: number;
  authorName: string;
  authorUin: string;
  groupName: string;
  text: string;
  link: { url: string; title: string; publisher: string; brief: string; pics: CollectionExportPic[] } | null;
  gallery: { pics: CollectionExportPic[] } | null;
  audio: { duration: number; stt: string } | null;
  video: {
    title: string;
    duration: number;
    cover: CollectionExportPic | null;
    fileName: string;
    fileSize: string;
  } | null;
  file: { name: string; size: string; ext: string } | null;
  location: { name: string; address: string; latitude: number; longitude: number } | null;
  richMedia: { title: string; subTitle: string; brief: string; originalUri: string; pics: CollectionExportPic[] } | null;
}

/** 注入的收藏数据拉取能力（返回已拍平的行）。 */
export interface CollectionExportDeps {
  /** 分页拉收藏（新到旧）。 */
  listCollections: (limit: number, offset: number) => Promise<CollectionExportRow[]>;
}

/** 收藏导出格式（表格四种）。 */
export type CollectionFormat = TableFormat;

export interface CollectionExportResult {
  filePath: string;
  /** 写入的收藏条数。 */
  count: number;
}

const PAGE = 200;
/** 翻页安全上限，防跑飞。 */
const MAX_PAGES = 1000;

/** kind → 中文类型名（对齐前端 KIND_FILTERS 标签）。 */
const KIND_LABEL: Record<string, string> = {
  text: '文本',
  link: '链接',
  gallery: '图片',
  audio: '语音',
  video: '视频',
  file: '文件',
  location: '位置',
  richMedia: '图文',
  unknown: '其他',
};

// ---- 小工具 ----

/** 毫秒级时间戳 → `YYYY-MM-DD HH:mm`（0/空留空）。 */
function timeText(ms: number): string {
  if (!ms) return '';
  const date = new Date(ms);
  const p = (n: number): string => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** 秒 → `M:SS` / `S"`（0/空留空）。 */
function durationText(sec: number): string {
  if (!sec || sec <= 0) return '';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${r.toString().padStart(2, '0')}` : `${s}"`;
}

/** 字节字符串 → 人类可读（0/空留空）。 */
function sizeText(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

/** 把一组图片拍成用竖线分隔的 URL 串（导出到单元格）。 */
function picUrls(pics: CollectionExportPic[] | undefined): string {
  return (pics ?? []).map((p) => p.uri).filter(Boolean).join(' | ');
}

// ---- 列定义：每种 kind 收敛到统一列 ----

/** 标题：link/video/richMedia 各自的标题。 */
function rowTitle(r: CollectionExportRow): string {
  if (r.link) return r.link.title;
  if (r.video) return r.video.title || r.video.fileName;
  if (r.richMedia) return r.richMedia.title || r.richMedia.subTitle;
  if (r.location) return r.location.name;
  if (r.file) return r.file.name;
  return '';
}

/** 正文：文本 / 链接摘要 / 图文摘要 / 语音转写。 */
function rowBody(r: CollectionExportRow): string {
  if (r.text) return r.text;
  if (r.richMedia?.brief) return r.richMedia.brief;
  if (r.link?.brief) return r.link.brief;
  if (r.audio?.stt) return r.audio.stt;
  return '';
}

/** 链接：link.url / richMedia.originalUri。 */
function rowLink(r: CollectionExportRow): string {
  return r.link?.url || r.richMedia?.originalUri || '';
}

/** 图片 URL：gallery / link / video 封面 / richMedia。 */
function rowPics(r: CollectionExportRow): string {
  if (r.gallery) return picUrls(r.gallery.pics);
  if (r.richMedia) return picUrls(r.richMedia.pics);
  if (r.link) return picUrls(r.link.pics);
  if (r.video?.cover) return r.video.cover.uri;
  return '';
}

/** 文件：名称（大小）。 */
function rowFile(r: CollectionExportRow): string {
  const f = r.file ?? (r.video ? { name: r.video.fileName, size: r.video.fileSize } : null);
  if (!f?.name) return '';
  const sz = sizeText(f.size);
  return sz ? `${f.name}（${sz}）` : f.name;
}

/** 时长：语音 / 视频。 */
function rowDuration(r: CollectionExportRow): string {
  if (r.audio) return durationText(r.audio.duration / 1000);
  if (r.video) return durationText(r.video.duration);
  return '';
}

/** 位置：名称 / 地址 @经纬度。 */
function rowLocation(r: CollectionExportRow): string {
  const loc = r.location;
  if (!loc) return '';
  const head = [loc.name, loc.address].filter(Boolean).join(' · ');
  const coord = loc.latitude || loc.longitude ? `@${loc.latitude},${loc.longitude}` : '';
  return [head, coord].filter(Boolean).join(' ');
}

const COLLECTION_COLS: Array<Col<CollectionExportRow>> = [
  { key: 'type', header: '类型', get: (r) => KIND_LABEL[r.kind] ?? r.kind },
  { key: 'collectTime', header: '收藏时间', get: (r) => timeText(r.collectTime) },
  { key: 'createTime', header: '创建时间', get: (r) => timeText(r.createTime) },
  { key: 'author', header: '来源', get: (r) => r.authorName },
  { key: 'group', header: '来源群', get: (r) => r.groupName },
  { key: 'title', header: '标题', get: rowTitle },
  { key: 'body', header: '正文', get: rowBody },
  { key: 'link', header: '链接', get: rowLink },
  { key: 'pics', header: '图片', get: rowPics },
  { key: 'file', header: '文件', get: rowFile },
  { key: 'duration', header: '时长', get: rowDuration },
  { key: 'location', header: '位置', get: rowLocation },
  { key: 'cid', header: 'cid', get: (r) => r.cid },
];

export interface ExportCollectionsOpts {
  format: CollectionFormat;
  outputPath: string;
  /** 只导出这些 kind（空 / 省略 = 全部）。 */
  kinds?: string[];
  onProgress?: (current: number, total: number, note: string) => void;
  signal?: AbortSignal;
}

/** 翻页拉全收藏。 */
async function fetchAllCollections(
  deps: CollectionExportDeps,
  signal?: AbortSignal,
  onProgress?: (n: number) => void,
): Promise<CollectionExportRow[]> {
  const all: CollectionExportRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    if (signal?.aborted) break;
    const batch = await deps.listCollections(PAGE, page * PAGE);
    all.push(...batch);
    onProgress?.(all.length);
    if (batch.length < PAGE) break;
  }
  return all;
}

/** 导出收藏。 */
export async function exportCollections(
  opts: ExportCollectionsOpts,
  deps: CollectionExportDeps,
): Promise<CollectionExportResult> {
  opts.onProgress?.(0, 0, '拉取收藏…');
  let rows = await fetchAllCollections(deps, opts.signal, (n) =>
    opts.onProgress?.(n, n, `已获取 ${n} 条`),
  );

  if (opts.kinds && opts.kinds.length > 0) {
    const wanted = new Set(opts.kinds);
    rows = rows.filter((r) => wanted.has(r.kind));
  }

  opts.onProgress?.(rows.length, rows.length, `${rows.length} 条收藏`);
  await writeTable(opts.format, COLLECTION_COLS, rows, opts.outputPath, '收藏');
  return { filePath: opts.outputPath, count: rows.length };
}
