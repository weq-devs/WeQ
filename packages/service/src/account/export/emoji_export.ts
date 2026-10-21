/**
 * 表情包导出流水线 —— 「导出中心 · 导出表情包」的后端。
 *
 * 两条来源的策略完全不同：
 *
 *   own（我自己的表情）—— 以 emoji.db 里「我收藏 / 添加的自定义表情」为准：
 *     1. 本地 `personal_emoji/Ori` 有原图          → 直接复制原图；
 *     2. 没有原图、但数据库登记了在线地址（CDN）   → 下载原图（GIF/JPG/PNG）补全；
 *     3. 下载不到、但本地 `personal_emoji/Thumb` 有 → 复制缩略图兜底；
 *     4. 什么都没有                                → 放弃（记进失败清单）。
 *
 *   received（收到的表情）—— 直接扫描本地 `emoji-recv/<月>/{Ori,Thumb}`：
 *     有原图导原图；只有缩略图的条目用缩略图补一份（thumb → ori 补全），让
 *     导出的目录尽量每张都有图。
 *
 * 产物是 bundle 下的一个来源子目录（`<outDir>/<来源名>/<文件>`），文件名稳定、
 * 同名去重。整个过程分三段回传进度（扫描 / 补全原图 / 写盘），供前端渲染多级
 * 进度条 + 滚动日志；单张失败不打断整批。
 */

import { copyFile, mkdir, open, readFile, readdir, rename, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { sanitizeSegment, uniqueName } from '../../common/path_sanitize';
import type { MediaFailure, StageLog } from './media_export';

/** 导出表情包的来源：自己的 / 收到的。 */
export type EmojiExportScope = 'own' | 'received';

/** 一条待导出的表情（后端内部形状，不进 IPC）。 */
export interface EmojiExportItem {
  /** 稳定去重键（通常是小写 hash）。 */
  key: string;
  /** 本地原图绝对路径（存在时）。 */
  oriPath: string | null;
  /** 本地缩略图绝对路径（存在时）。 */
  thumbPath: string | null;
  /** 在线原图地址（CDN，可空）；有它且缺 ori 时可下载补全。 */
  remoteUrl: string | null;
  /** 预览寻址：可用 `weq-media://cemoji` 渲染（本地存在时）。 */
  preview?: EmojiPreviewAddress;
}

/** 一条表情的 `weq-media://cemoji` 寻址信息（前端预览用）。 */
export interface EmojiPreviewAddress {
  scope: 'personal' | 'recv';
  bucket: string;
  variant: 'ori' | 'thumb';
  file: string;
}

/** 一个来源的预览统计（导出中心面板展示用）。 */
export interface EmojiScopeSummary {
  scope: EmojiExportScope;
  /** 条目总数。 */
  total: number;
  /** 本地已有原图。 */
  withOri: number;
  /** 仅有缩略图（无原图）。 */
  thumbOnly: number;
  /** 本地都没有、但有在线地址，可下载补全。 */
  downloadable: number;
  /** 本地没有、也无在线地址，只能放弃。 */
  missing: number;
  /** 预览条目（最多 `sampleLimit` 条，带 cemoji 寻址，按需截图）。 */
  sample: Array<EmojiPreviewAddress & { key: string }>;
}

/** emoji.db 收藏表里一条自定义表情的原始信息（`导出自定义表情` 用）。 */
export interface FavEmojiRow {
  hash: string;
  oriPath: string;
  thumbPath: string;
  remoteUrl: string;
}

/**
 * 表情包导出的能力注入（由 app 桥接 EmojiService / 平台目录）：
 *   - listOwnItems      读 emoji.db 收藏 + 本地 personal_emoji 目录；
 *   - listReceivedItems 扫描本地 emoji-recv 目录；
 *   - downloadImage     下载一张在线原图到 destPath（返回是否成功）。
 */
export interface EmojiExportDeps {
  listOwnItems(): Promise<EmojiExportItem[]>;
  listReceivedItems(): Promise<EmojiExportItem[]>;
  downloadImage(url: string, destPath: string, signal?: AbortSignal): Promise<boolean>;
}

/** 分阶段进度回调（扫描 / 补全下载 / 写盘各自计数）。 */
export interface EmojiExportHooks {
  onDownload?(done: number, total: number): void;
  onWrite?(done: number, total: number): void;
  onLog?: StageLog;
}

/** 补全原图的结果。 */
export interface EmojiResolveResult {
  items: EmojiExportItem[];
  /** 需要下载补全的条目数（进度分母）。 */
  candidates: number;
  /** 下载成功数。 */
  downloaded: number;
  /** 下载失败、需要退到缩略图 / 放弃的条目数。 */
  failed: number;
}

/** 写盘结果计数。 */
export interface EmojiWriteResult {
  /** 输出目录。 */
  dir: string;
  total: number;
  written: number;
  copiedOri: number;
  fromThumb: number;
  skipped: number;
  failures: MediaFailure[];
}

/** 来源子目录名。 */
export function scopeDirName(scope: EmojiExportScope): string {
  return scope === 'own' ? '我的表情' : '收到的表情';
}

/** 保留原扩展名（图片之外兜底 .png）。 */
function imageExt(path: string): string {
  const ext = extname(path).toLowerCase();
  if (/^\.(png|jpe?g|gif|webp|bmp|apng)$/.test(ext)) return ext === '.jpeg' ? '.jpg' : ext;
  return '.png';
}

/** 图片文件头 → 扩展名（下载后按真实内容定名）。 */
export function sniffImageExt(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return '.png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  if (/^(GIF87a|GIF89a)/.test(bytes.toString('ascii', 0, 6))) return '.gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return '.webp';
  if (bytes.toString('ascii', 0, 2) === 'BM') return '.bmp';
  return null;
}

/** 输出文件名：优先展示名，退到 hash；保留真实扩展名。 */
async function fileNameFor(item: EmojiExportItem): Promise<string> {
  const src = item.oriPath ?? item.thumbPath ?? '';
  const base = src ? basename(src) : '';
  const stem = base ? base.replace(extname(base), '') : item.key.slice(0, 32);
  const clean = sanitizeSegment(stem, item.key.slice(0, 32), { maxLen: 60 });
  let extension = imageExt(src);
  if (src) {
    const input = await open(src, 'r');
    try {
      const head = Buffer.alloc(16);
      const { bytesRead } = await input.read(head, 0, head.length, 0);
      extension = sniffImageExt(head.subarray(0, bytesRead)) ?? extension;
    } finally {
      await input.close();
    }
  }
  return `${clean}${extension}`;
}

/** 文件是否真的存在（且是普通文件）。 */
async function existingFile(path: string): Promise<boolean> {
  if (!path) return false;
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * 磁盘绝对路径 → `weq-media://cemoji` 寻址（`personal_emoji/{Ori,Thumb}` 或
 * `emoji-recv/<月>/{Ori,Thumb}`）。解析不出来返回 undefined。
 */
export function previewFromPath(path: string): EmojiPreviewAddress | undefined {
  if (!path) return undefined;
  const parts = path.split(/[\\/]/);
  const file = parts[parts.length - 1] ?? '';
  if (!file) return undefined;
  const variantIdx = parts.length - 2;
  const variantRaw = parts[variantIdx] ?? '';
  const variant: 'ori' | 'thumb' | null =
    variantRaw === 'Ori' ? 'ori' : variantRaw === 'Thumb' ? 'thumb' : null;
  if (!variant) return undefined;
  const personalIdx = parts.lastIndexOf('personal_emoji');
  if (personalIdx >= 0) return { scope: 'personal', bucket: '', variant, file };
  const recvIdx = parts.lastIndexOf('emoji-recv');
  if (recvIdx >= 0) {
    const bucket = parts[recvIdx + 1] ?? '';
    if (/^\d{4}-\d{2}$/.test(bucket)) return { scope: 'recv', bucket, variant, file };
  }
  return undefined;
}

/**
 * 自己的表情：以 emoji.db 收藏表为骨架（含在线地址），再叠加本地
 * `personal_emoji/{Ori,Thumb}` 目录里数据库没登记的散图。按 hash 归并。
 */
export async function collectOwnItems(
  rows: FavEmojiRow[],
  personalRoot: string | null,
): Promise<EmojiExportItem[]> {
  const merged = new Map<string, EmojiExportItem>();
  for (const row of rows) {
    const key = canonicalHash(row.hash) || row.hash.toLowerCase();
    if (!key) continue;
    const acc =
      merged.get(key) ??
      ({ key, oriPath: null, thumbPath: null, remoteUrl: null } as EmojiExportItem);
    if (!acc.remoteUrl && row.remoteUrl) acc.remoteUrl = row.remoteUrl;
    if (!acc.oriPath && (await existingFile(row.oriPath))) {
      acc.oriPath = row.oriPath;
      acc.preview = previewFromPath(row.oriPath);
    }
    if (!acc.thumbPath && (await existingFile(row.thumbPath))) {
      acc.thumbPath = row.thumbPath;
      if (!acc.preview) acc.preview = previewFromPath(row.thumbPath);
    }
    merged.set(key, acc);
  }

  if (personalRoot) {
    await absorbInto(merged, join(personalRoot, 'Ori'), false);
    await absorbInto(merged, join(personalRoot, 'Thumb'), true);
  }

  return sortItems([...merged.values()]);
}

/** 收到的表情：扫描 `emoji-recv/<月>/{Ori,Thumb}`（新月份在前）。 */
export async function collectReceivedItems(recvRoot: string | null): Promise<EmojiExportItem[]> {
  if (!recvRoot) return [];
  const merged = new Map<string, EmojiExportItem>();
  for (const bucket of await listMonthBuckets(recvRoot)) {
    const base = join(recvRoot, bucket);
    await absorbInto(merged, join(base, 'Ori'), false);
    await absorbInto(merged, join(base, 'Thumb'), true);
  }
  return sortItems([...merged.values()]);
}

/** 稳定排序：有原图的在前，再按 hash。 */
function sortItems(items: EmojiExportItem[]): EmojiExportItem[] {
  return items.sort((a, b) => {
    const ao = a.oriPath ? 0 : 1;
    const bo = b.oriPath ? 0 : 1;
    return ao - bo || a.key.localeCompare(b.key);
  });
}

/** `emoji-recv` 下的月份桶（`YYYY-MM`），新月份在前。 */
async function listMonthBuckets(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

/** 把一个 Ori / Thumb 目录折进已存在（带 remoteUrl）的 item 映射。 */
async function absorbInto(
  out: Map<string, EmojiExportItem>,
  dir: string,
  isThumb: boolean,
): Promise<void> {
  let files: import('node:fs').Dirent[];
  try {
    files = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of files) {
    if (!entry.isFile()) continue;
    const key = canonicalHash(entry.name.replace(/\.[^.]+$/, ''));
    if (!key) continue;
    const full = join(dir, entry.name);
    if (!(await existingFile(full))) continue;
    const acc =
      out.get(key) ?? ({ key, oriPath: null, thumbPath: null, remoteUrl: null } as EmojiExportItem);
    if (isThumb) {
      if (!acc.thumbPath) {
        acc.thumbPath = full;
        if (!acc.preview) acc.preview = previewFromPath(full);
      }
    } else if (!acc.oriPath) {
      acc.oriPath = full;
      acc.preview = previewFromPath(full);
    }
    out.set(key, acc);
  }
}

/**
 * 阶段 2：把「本地没有原图、但有在线地址」的条目下载补全到 `downloadDir`。
 * 成功后按真实文件头改名成正确扩展名并写回 `oriPath`；失败保持 `oriPath = null`
 * （写盘阶段会退到缩略图或放弃）。
 */
export async function resolveOwnOriginals(
  items: EmojiExportItem[],
  downloadDir: string,
  download: (url: string, dest: string, signal?: AbortSignal) => Promise<boolean>,
  hooks: EmojiExportHooks = {},
  signal?: AbortSignal,
  concurrency = 6,
): Promise<EmojiResolveResult> {
  const candidates = items.filter((it) => !it.oriPath && it.remoteUrl);
  const result: EmojiResolveResult = {
    items: items.map((it) => ({ ...it })),
    candidates: candidates.length,
    downloaded: 0,
    failed: 0,
  };
  if (candidates.length === 0) return result;
  await mkdir(downloadDir, { recursive: true });

  let done = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      const idx = next++;
      const item = candidates[idx];
      if (!item) return;
      const raw = join(downloadDir, `${item.key}.part`);
      try {
        const ok = await download(item.remoteUrl!, raw, signal);
        if (ok) {
          const head = (await readFile(raw)).subarray(0, 16);
          const ext = sniffImageExt(head) ?? '.png';
          const named = join(downloadDir, `${item.key}${ext}`);
          await rename(raw, named);
          const target = result.items.find((r) => r.key === item.key);
          if (target) target.oriPath = named;
          result.downloaded += 1;
          hooks.onLog?.(`补全原图 ${item.key.slice(0, 12)}…（${done + 1}/${candidates.length}）`);
        } else {
          result.failed += 1;
          hooks.onLog?.(`原图下载失败 ${item.key.slice(0, 12)}…，改用缩略图`, 'warn');
        }
      } catch (e) {
        result.failed += 1;
        hooks.onLog?.(
          `原图下载异常 ${item.key.slice(0, 12)}…：${e instanceof Error ? e.message : String(e)}`,
          'warn',
        );
      } finally {
        done += 1;
        hooks.onDownload?.(done, candidates.length);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  hooks.onDownload?.(candidates.length, candidates.length);
  return result;
}

/**
 * 阶段 3：把条目写进 `<outDir>/<来源名>/`。原图优先；只有缩略图的（含下载失败
 * 回退的）用缩略图补一份；两者都无 → 放弃并记失败。
 */
export async function writeEmojiBundle(
  scope: EmojiExportScope,
  items: EmojiExportItem[],
  outDir: string,
  hooks: EmojiExportHooks = {},
  signal?: AbortSignal,
  concurrency = 8,
): Promise<EmojiWriteResult> {
  const dir = join(outDir, scopeDirName(scope));
  await mkdir(dir, { recursive: true });
  const result: EmojiWriteResult = {
    dir,
    total: items.length,
    written: 0,
    copiedOri: 0,
    fromThumb: 0,
    skipped: 0,
    failures: [],
  };
  if (items.length === 0) return result;

  const used = new Set<string>();
  const fail = (fileName: string, error: string): void => {
    if (result.failures.length < 200) result.failures.push({ stage: 'emoji', fileName, error });
  };

  let done = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return;
      const idx = next++;
      const item = items[idx];
      if (!item) return;
      try {
        const target = join(dir, uniqueName(await fileNameFor(item), used));
        if (item.oriPath) {
          await copyFile(item.oriPath, target);
          result.copiedOri += 1;
          result.written += 1;
        } else if (item.thumbPath) {
          await copyFile(item.thumbPath, target);
          result.fromThumb += 1;
          result.written += 1;
          hooks.onLog?.(`缩略图补全 ${basename(target)}`, 'warn');
        } else {
          result.skipped += 1;
          fail(basename(target), '没有原图也没有缩略图');
          hooks.onLog?.(`放弃 ${basename(target)}：没有可用文件`, 'warn');
        }
      } catch (e) {
        result.skipped += 1;
        const msg = e instanceof Error ? e.message : String(e);
        fail(item.key, msg);
        hooks.onLog?.(`写盘失败 ${item.key}：${msg}`, 'error');
      } finally {
        done += 1;
        hooks.onWrite?.(done, items.length);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  hooks.onWrite?.(items.length, items.length);
  return result;
}

/** hash 归并键：去掉 `_<size>` 后缀、小写（与自定义表情资源服务一致）。 */
export function canonicalHash(stem: string): string {
  const m = /^([0-9a-f]{6,})(?:_\d+)?$/i.exec(stem);
  if (m) return m[1]!.toLowerCase();
  const lead = /^[0-9a-f]{6,}/i.exec(stem);
  return lead ? lead[0].toLowerCase() : '';
}

/** 导出的来源名（前端展示 / 任务名用）。 */
export function scopeLabel(scope: EmojiExportScope): string {
  return scope === 'own' ? '我的表情' : '收到的表情';
}

export type { StageLog };
