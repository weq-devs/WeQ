/**
 * OcrResultCache —— 图片文字识别结果的**内容寻址**缓存。
 *
 * 三个入口（聊天灯箱 `account.ocrChatImage`、导出批量 `export/ocr_export`、
 * MCP `ocr_image_text`）本来各跑一遍识别；这里按「图片内容」存一份，谁先跑出来谁写，
 * 后面所有人直接命中 —— 在线请求、本地推理（秒级）、连筛图那一趟检测都省掉。
 *
 * 键：图片 md5（元素的 45424 / 45406，归一成小写 hex）。灯箱与导出拿的是**同一个**
 * 元素字段，所以两边天然共享；MCP 给本机文件路径时用文件字节的 md5 兜（同一张图
 * 落盘后文件名就是 md5，两边仍然对得上）。实在没有 md5 时退到文件名 stem。
 *
 * 存储：`<root>/<键前两位>/<键>.json`，一个键一个文件。`root` 由 app 侧注入
 * （`userConfig.cacheDir('ocr')`），本模块只用 `node:fs`，保持 `@weq/service` 零原生。
 * 目录刻意**不进**「清理缓存」白名单（见 `docs/develop/ocr-cache-plan-20261016.md`）：
 * 过期图片的结果清掉就再也拿不回来了（CDN 直链只有约 9 天寿命）。
 *
 * 一条记录里按**生产者**分格存多份结果（`oidb` / `local:<modelId>` /
 * 筛图 `filters[<modelId>]`），互不覆盖：离线时本地先跑过、之后在线可用，仍然能拿到
 * 在线那份（精度高一档）；换了识别模型也不会吃到旧模型的结果。
 *
 * 坐标：`blocks` 是「喂进去那张图」的像素坐标，所以每份结果自带 `frame`
 * （宽 / 高 + 是原图还是缩略图）。本地那条腿可能读到的是缩略图，调用方按 `frame`
 * 换算到当前显示的尺寸（`@weq/protocol` 的 `scaleOcrPoints` / `scaleOcrRect`）。
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OcrBlock } from '@weq/protocol';
import { getLogger } from './logger';

/** 记录格式版本（将来换 sqlite 或改结构时用于迁移 / 丢弃旧档）。 */
export const OCR_CACHE_SCHEMA_VERSION = 1;

/** 这张图被识别时用的是哪一份像素。 */
export type OcrCacheFrameVariant = 'original' | 'thumb' | 'downloaded' | 'unknown';

/** 结果自带的坐标系（被识别那张图的像素尺寸）。 */
export interface OcrCacheFrame {
  width: number;
  height: number;
  variant?: OcrCacheFrameVariant;
}

/** 生产者：在线接口 / 某个本地识别模型 / 某个筛图模型。 */
export type OcrCacheProducer = string;

/** 命中一份识别结果（文字 + 坐标框）。 */
export interface OcrCacheTextHit {
  text: string;
  blocks?: OcrBlock[];
  /** 结果太长（超长截图）时框被丢掉，只留文字。 */
  blocksOmitted?: true;
  frame: OcrCacheFrame;
  /** 哪条腿出的结果。 */
  source: 'oidb' | 'local';
  /** 本地那条腿的模型 id。 */
  modelId?: string;
  /** 在线那条腿识别出的源语种。 */
  lang?: string;
  elapsedMs?: number;
  /** 原始生产者 id（`oidb` / `local:<modelId>`）。 */
  producer: string;
  /** 落盘时间（epoch ms）。 */
  at: number;
}

/** 命中一份筛图结论。 */
export interface OcrCacheFilterHit {
  hasText: boolean;
  boxes?: number;
  at: number;
}

/** 写识别结果时的入参。 */
export interface OcrCacheTextInput {
  text: string;
  blocks?: OcrBlock[];
  frame: OcrCacheFrame;
  modelId?: string;
  lang?: string;
  elapsedMs?: number;
  /** 便于人查 / 兜底寻址的可选身份信息（不参与键）。 */
  ids?: OcrCacheIds;
}

export interface OcrCacheIds {
  elementMd5?: string;
  bytesMd5?: string;
  fileName?: string;
}

/** 一条记录（一个键一个文件）。 */
export interface OcrCacheRecord {
  schemaVersion: number;
  key: string;
  ids?: OcrCacheIds;
  firstSeenAt: number;
  lastUsedAt: number;
  /** 生产者 id → 识别结果。 */
  texts?: Record<string, StoredTextVariant>;
  /** 筛图模型 id → 结论。 */
  filters?: Record<string, StoredFilterVariant>;
}

interface StoredTextVariant extends OcrCacheTextHit {
  hits: number;
}

interface StoredFilterVariant extends OcrCacheFilterHit {
  hits: number;
}

/** 读缓存时的偏好：`auto` = 在线优先、其次本地。 */
export type OcrCachePrefer = 'auto' | 'oidb' | 'local';

/**
 * 把一个原始身份（元素 md5 / 图片文件名 / 文件名 stem）归一成缓存键，认不出返回 null。
 *
 * md5 是主形态（32 位 hex）；QQ 自己的图片文件名就是 `<md5>.<ext>`，所以带扩展名的
 * 文件名先砍掉扩展名。**只认 16–64 位 hex**：别的形状（用户自己的 `screenshot.png`、
 * 带路径的字符串…）一律不缓存 —— 键撞了的代价是「拿错一张图的文字」，比不缓存糟得多。
 */
export function ocrCacheKey(raw: string | null | undefined): string | null {
  const stripped = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.[^./\\]*$/, '');
  return /^[0-9a-f]{16,64}$/.test(stripped) ? stripped : null;
}

/** 默认最多在内存里留多少条（一批导出里读过的记录不重复读盘，又不会吃爆内存）。 */
const DEFAULT_MEMO_LIMIT = 256;
/** 单条结果里 blocks 的体积上限（超长截图），超了就只留文字。 */
const DEFAULT_BLOCKS_LIMIT = 256 * 1024;

export interface OcrResultCacheOptions {
  /** 内存里保留的记录条数上限（默认 256）。 */
  memoLimit?: number;
  /** 单条结果允许写盘的 blocks JSON 体积上限（默认 256 KB）。 */
  blocksLimitBytes?: number;
}

export class OcrResultCache {
  private readonly logger = getLogger().child({ scope: 'ocr-cache' });
  /** 本进程写过的记录（读优先走它，避免同一批里反复读盘）。 */
  private readonly memo = new Map<string, OcrCacheRecord>();
  /** 每个键一条写队列：并发写同一个键时不能丢更新（读-改-写要串起来）。 */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly memoLimit: number;
  private readonly blocksLimitBytes: number;

  constructor(
    /** 缓存根目录（`userConfig.cacheDir('ocr')`）。 */
    readonly root: string,
    options: OcrResultCacheOptions = {},
  ) {
    this.memoLimit = Math.max(1, options.memoLimit ?? DEFAULT_MEMO_LIMIT);
    this.blocksLimitBytes = Math.max(1024, options.blocksLimitBytes ?? DEFAULT_BLOCKS_LIMIT);
  }

  /** 原始身份 → 缓存键（认不出返回 null，调用方照常识别、只是不落缓存）。 */
  keyFor(raw: string | null | undefined): string | null {
    return ocrCacheKey(raw);
  }

  /**
   * 读一份识别结果。`prefer` 决定接受哪条腿的结果：
   *   - `auto`（默认）：有在线就用在线，否则用最新的那份本地结果；
   *   - `oidb` / `local`：只要那条腿的（调用方明确要求「必须走在线 / 必须走本地」时用，
   *     例如 MCP 的 `engine: 'online'` 不该被一份本地缓存顶掉）。
   */
  async getText(key: string, prefer: OcrCachePrefer = 'auto'): Promise<OcrCacheTextHit | null> {
    if (!key) return null;
    const record = await this.read(key);
    const texts = record?.texts;
    if (!record || !texts) return null;
    const pick = pickTextVariant(texts, prefer);
    if (!pick) return null;
    const [producer, variant] = pick;
    this.markUsed(record);
    return {
      text: variant.text,
      ...(variant.blocks ? { blocks: variant.blocks } : {}),
      ...(variant.blocksOmitted ? { blocksOmitted: true as const } : {}),
      frame: variant.frame,
      source: producer === 'oidb' ? 'oidb' : 'local',
      ...(variant.modelId ? { modelId: variant.modelId } : {}),
      ...(variant.lang ? { lang: variant.lang } : {}),
      ...(variant.elapsedMs !== undefined ? { elapsedMs: variant.elapsedMs } : {}),
      producer,
      at: variant.at,
    };
  }

  /** 写一份识别结果（合并进已有记录，不覆盖别的生产者）。 */
  async putText(key: string, producer: OcrCacheProducer, input: OcrCacheTextInput): Promise<void> {
    if (!key || !producer) return;
    const stored = this.toStoredText(producer, input);
    await this.mutate(key, input.ids, (record) => {
      record.texts ??= {};
      const previous = record.texts[producer];
      record.texts[producer] = { ...stored, hits: previous?.hits ?? 0 };
    });
  }

  /** 读一份筛图结论（只认同一个筛图模型的结果）。 */
  async getFilter(key: string, modelId: string): Promise<OcrCacheFilterHit | null> {
    if (!key || !modelId) return null;
    const record = await this.read(key);
    const variant = record?.filters?.[modelId];
    if (!record || !variant) return null;
    this.markUsed(record);
    return {
      hasText: variant.hasText,
      ...(variant.boxes !== undefined ? { boxes: variant.boxes } : {}),
      at: variant.at,
    };
  }

  /** 写一份筛图结论。 */
  async putFilter(
    key: string,
    modelId: string,
    verdict: { hasText: boolean; boxes?: number; elapsedMs?: number },
    ids?: OcrCacheIds,
  ): Promise<void> {
    if (!key || !modelId) return;
    const at = Date.now();
    await this.mutate(key, ids, (record) => {
      record.filters ??= {};
      const previous = record.filters[modelId];
      record.filters[modelId] = {
        hasText: verdict.hasText,
        ...(verdict.boxes !== undefined ? { boxes: verdict.boxes } : {}),
        at,
        hits: previous?.hits ?? 0,
      };
    });
  }

  /** 读一条记录（内存 → 磁盘）。坏档当未命中并顺手删掉。 */
  async read(key: string): Promise<OcrCacheRecord | null> {
    const cached = this.memo.get(key);
    if (cached) return cached;
    const file = this.fileFor(key);
    let raw: string;
    try {
      raw = await readFile(file, 'utf-8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as OcrCacheRecord;
      if (!parsed || typeof parsed !== 'object' || parsed.key !== key) {
        throw new Error('key mismatch');
      }
      if (parsed.schemaVersion !== OCR_CACHE_SCHEMA_VERSION) return null;
      this.remember(key, parsed);
      return parsed;
    } catch (error) {
      this.logger.warn('丢弃无法解析的 OCR 缓存记录', {
        event: 'ocr-cache-corrupt',
        key,
        file,
        error: error instanceof Error ? error.message : String(error),
      });
      await rm(file, { force: true }).catch(() => undefined);
      return null;
    }
  }

  /** 拿到这条记录里存了哪些生产者 / 筛图模型（调试与测试用）。 */
  async producers(key: string): Promise<string[]> {
    const record = await this.read(key);
    return [...Object.keys(record?.texts ?? {}), ...Object.keys(record?.filters ?? {})];
  }

  /** 读-改-写（同一键串行；写盘用 临时文件 + rename，断电也不会留半截 JSON）。 */
  private async mutate(
    key: string,
    ids: OcrCacheIds | undefined,
    edit: (record: OcrCacheRecord) => void,
  ): Promise<void> {
    await this.enqueue(key, async () => {
      const existing = this.memo.get(key) ?? (await this.read(key));
      const now = Date.now();
      const record: OcrCacheRecord = existing ?? {
        schemaVersion: OCR_CACHE_SCHEMA_VERSION,
        key,
        firstSeenAt: now,
        lastUsedAt: now,
      };
      if (ids) record.ids = { ...record.ids, ...dropEmpty(ids) };
      edit(record);
      record.lastUsedAt = now;
      this.remember(key, record);
      await this.write(key, record);
    });
  }

  private async write(key: string, record: OcrCacheRecord): Promise<void> {
    const file = this.fileFor(key);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await mkdir(this.dirFor(key), { recursive: true });
      await writeFile(tmp, JSON.stringify(record), 'utf-8');
      await rename(tmp, file);
    } catch (error) {
      this.logger.warn('写入 OCR 缓存失败', {
        event: 'ocr-cache-write-failed',
        key,
        file,
        error: error instanceof Error ? error.message : String(error),
      });
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  /** 把一条结果整理成落盘形状（blocks 过大就只留文字）。 */
  private toStoredText(producer: string, input: OcrCacheTextInput): StoredTextVariant {
    const at = Date.now();
    const base: StoredTextVariant = {
      text: input.text,
      frame: input.frame,
      source: producer === 'oidb' ? 'oidb' : 'local',
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.lang ? { lang: input.lang } : {}),
      ...(input.elapsedMs !== undefined ? { elapsedMs: input.elapsedMs } : {}),
      producer,
      at,
      hits: 0,
    };
    if (!input.blocks || input.blocks.length === 0) return base;
    const size = JSON.stringify(input.blocks).length;
    if (size > this.blocksLimitBytes) {
      this.logger.debug('OCR 缓存：坐标框过大，只留文字', {
        event: 'ocr-cache-blocks-omitted',
        key: producer,
        size,
      });
      return { ...base, blocksOmitted: true };
    }
    return { ...base, blocks: input.blocks };
  }

  private markUsed(record: OcrCacheRecord): void {
    record.lastUsedAt = Date.now();
  }

  private remember(key: string, record: OcrCacheRecord): void {
    if (this.memo.size >= this.memoLimit && !this.memo.has(key)) {
      const oldest = this.memo.keys().next().value;
      if (oldest !== undefined) this.memo.delete(oldest);
    }
    this.memo.set(key, record);
  }

  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.chains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  private dirFor(key: string): string {
    return join(this.root, key.slice(0, 2));
  }

  private fileFor(key: string): string {
    return join(this.dirFor(key), `${key}.json`);
  }
}

/** 挑一份结果：`auto` = 在线优先、否则最新的本地。 */
function pickTextVariant(
  texts: Record<string, StoredTextVariant>,
  prefer: OcrCachePrefer,
): [string, StoredTextVariant] | null {
  const entries = Object.entries(texts);
  if (entries.length === 0) return null;
  if (prefer === 'oidb') return entries.find(([producer]) => producer === 'oidb') ?? null;
  const locals = entries.filter(([producer]) => producer !== 'oidb');
  if (prefer === 'local') return pickNewest(locals);
  return entries.find(([producer]) => producer === 'oidb') ?? pickNewest(locals);
}

function pickNewest(
  entries: Array<[string, StoredTextVariant]>,
): [string, StoredTextVariant] | null {
  let best: [string, StoredTextVariant] | null = null;
  for (const entry of entries) {
    if (!best || entry[1].at > best[1].at) best = entry;
  }
  return best;
}

function dropEmpty(ids: OcrCacheIds): OcrCacheIds {
  const out: OcrCacheIds = {};
  if (ids.elementMd5) out.elementMd5 = ids.elementMd5;
  if (ids.bytesMd5) out.bytesMd5 = ids.bytesMd5;
  if (ids.fileName) out.fileName = ids.fileName;
  return out;
}

/**
 * 进程内共享的缓存实例（按 root 记忆）。
 *
 * 灯箱 / MCP / 导出三处拿的是同一份目录，共享实例既省内存，也让「刚写进去的结果」
 * 立刻能被同进程的另一次调用读到。root 变了（用户改了缓存路径）就换一个实例。
 */
let shared: { root: string; cache: OcrResultCache } | undefined;

export function ocrCacheFor(root: string): OcrResultCache {
  if (!shared || shared.root !== root) {
    shared = { root, cache: new OcrResultCache(root) };
  }
  return shared.cache;
}
