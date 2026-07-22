/**
 * 商城表情目录（离线内存索引）。
 *
 * 用户爬取的 25000+ 套商城表情元数据存在 `resources/emoji/market.csv`
 * （表头 `id,name,mark,feetype`）。首次访问时把整张表解析进模块级数组并缓存，
 * 之后所有搜索/筛选/分页都在内存里跑 —— 纯离线，不碰网络也不经账号会话。
 *
 * 用于「导出中心 · 商城表情下载」：用户搜关键词挑表情包，勾选后交给
 * ExportTaskManager 并发解密下载（下载才走 CDN + QQTEA，见 EmojiService）。
 *
 * CSV 是 RFC4180：多数行字段裸写，但 `mark` 含 ASCII 逗号 / 引号 / 换行的行会被
 * 双引号包裹、内部引号写成 `""`。全角中文逗号「，」不触发引号。所以必须用真正的
 * RFC4180 解析器，不能 `split(',')`。
 */

import { readFileSync } from 'node:fs';
import { marketFeeTypeLabel, type MarketPackFeeType } from '@weq/service';
import { resolveResource } from './resource';

/** 目录里的一套表情包（投影给前端的字段）。 */
export interface MarketCatalogEntry {
  /** 表情包 ID（packId）。 */
  id: string;
  /** 名称。 */
  name: string;
  /** 介绍文案（`mark` 列）。 */
  mark: string;
  /** 来源标签（免费/付费/VIP/SVIP —— 由 feetype 映射，见 service）。 */
  feeType: MarketPackFeeType;
}

/** 一页搜索结果。 */
export interface MarketCatalogPage {
  entries: MarketCatalogEntry[];
  /** 命中的总条数（供表头计数）。 */
  total: number;
  /** 下一页游标（数值下标的字符串），耗尽为 null。 */
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;

/** 模块级缓存：解析一次，常驻。null = 尚未加载。 */
let catalog: MarketCatalogEntry[] | null = null;

/**
 * 解析一段 RFC4180 CSV 文本为字段矩阵。处理：字段内逗号、`"` 包裹、`""` 转义引号、
 * 引号字段内的 `\r\n` / `\n` 换行。行尾兼容 `\r\n` 与 `\n`。
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      endField();
      i += 1;
      continue;
    }
    if (c === '\r') {
      // 吞掉 \r\n 的 \r；单独 \r 也当行结束。
      if (text[i + 1] === '\n') i += 1;
      endRow();
      i += 1;
      continue;
    }
    if (c === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  // 收尾：最后一行没有换行结尾时补上（忽略纯空尾行）。
  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}

/** 懒加载 + 解析 CSV，缓存到模块级 `catalog`。找不到文件/解析失败返回空表。 */
function loadCatalog(): MarketCatalogEntry[] {
  if (catalog) return catalog;
  const path = resolveResource('emoji', 'market.csv');
  if (!path) {
    catalog = [];
    return catalog;
  }
  try {
    const text = readFileSync(path, 'utf-8');
    const rows = parseCsv(text);
    const out: MarketCatalogEntry[] = [];
    // 首行是表头 `id,name,mark,feetype`，跳过。
    for (let r = 1; r < rows.length; r++) {
      const cols = rows[r]!;
      const id = (cols[0] ?? '').trim();
      if (!/^\d+$/.test(id)) continue; // 跳过空行 / 脏行
      const feeTypeRaw = Number((cols[3] ?? '').trim()) || 0;
      out.push({
        id,
        name: (cols[1] ?? '').trim(),
        mark: cols[2] ?? '',
        feeType: marketFeeTypeLabel(feeTypeRaw),
      });
    }
    catalog = out;
  } catch {
    catalog = [];
  }
  return catalog;
}

/**
 * 搜索商城表情目录（离线）。
 *   - `keyword`：对 `name + mark` 做小写子串匹配（空 = 不过滤）。
 *   - `feeTypes`：来源标签白名单（空 = 全部）。
 *   - `cursor`：数值下标字符串，稳定可续；`limit` 每页条数（默认 60，上限 200）。
 */
export function searchCatalog(opts: {
  keyword?: string;
  feeTypes?: MarketPackFeeType[];
  limit?: number;
  cursor?: string | null;
}): MarketCatalogPage {
  const all = loadCatalog();
  const kw = (opts.keyword ?? '').trim().toLowerCase();
  const feeSet =
    opts.feeTypes && opts.feeTypes.length > 0 ? new Set(opts.feeTypes) : null;

  const matched =
    !kw && !feeSet
      ? all
      : all.filter((e) => {
          if (feeSet && !feeSet.has(e.feeType)) return false;
          if (kw && !`${e.name}\n${e.mark}`.toLowerCase().includes(kw)) return false;
          return true;
        });

  const total = matched.length;
  const cap = clampInt(opts.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const start = Math.max(0, Number(opts.cursor ?? 0) || 0);
  const slice = matched.slice(start, start + cap);
  const nextIndex = start + slice.length;

  return {
    entries: slice,
    total,
    nextCursor: nextIndex < total ? String(nextIndex) : null,
  };
}

function clampInt(n: number, lo: number, hi: number): number {
  const x = Math.floor(Number.isFinite(n) ? n : lo);
  return Math.min(hi, Math.max(lo, x));
}
