/**
 * `market_emoticon_table` —— emoji.db 里「已添加商城表情包的逐张明细」。
 *
 * 每行 = 一张商城表情（主键 = hash + 包 id）。本地后端的元数据，图片字节仍按
 * mface 的 CDN 规则取（`weq-media://mface?pack=&hash=&enc=tea`）。
 *
 * 列含义：
 *   80920  hash      表情图片 hash（也是 CDN 资源路径里的 hash）
 *   80943  packId    所属表情包 ID（↔ market_emoticon_package_table.80943）
 *   80921  name      表情名（如「在做了」）
 *   80930  keywords  关键词 JSON 字符串（如 `[ "在做了", "在做了" ]`），可空
 */

import type { SqlRow } from '@weq/native';
import { QqDb } from '../qq_db';

const TABLE = 'market_emoticon_table';
const SELECT_COLUMNS = `"80920","80943","80921","80930"`;

export interface MarketEmoticon {
  /** 表情图片 hash。 */
  hash: string;
  /** 所属表情包 ID。 */
  packId: string;
  /** 表情名。 */
  name: string;
  /** 关键词列表（解析自 80930 的 JSON，失败为空）。 */
  keywords: string[];
}

export class MarketEmoticonDb extends QqDb {
  /** 某个包的全部明细；包不存在返回空表。 */
  async listByPack(packId: string): Promise<MarketEmoticon[]> {
    let rows: SqlRow[];
    try {
      rows = await this.query(`SELECT ${SELECT_COLUMNS} FROM ${TABLE} WHERE "80943" = ?`, [packId]);
    } catch {
      return [];
    }
    return rows.map(rowToEmoticon);
  }
}

function rowToEmoticon(row: SqlRow): MarketEmoticon {
  return {
    hash: String(row[0] ?? ''),
    packId: String(row[1] ?? ''),
    name: String(row[2] ?? ''),
    keywords: parseKeywords(String(row[3] ?? '')),
  };
}

function parseKeywords(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === 'string');
  } catch {
    return [];
  }
}
