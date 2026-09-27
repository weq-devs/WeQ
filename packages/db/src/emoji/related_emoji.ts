/**
 * `related_emoji_emoji_table` —— emoji.db 里「关联表情 / GIF 表情」。
 *
 * 每行 = 某关键词下的一张关联 gif。列含义：
 *   81054  id        主键，形如 `<gifHash><关键词>`
 *   81030  gifHash   gif 的 hash（也是本地文件名 `<hash>.gif`）
 *   81033  keyword    关键词 / 标签（如「你好」）
 *   81029  remoteUrl  gif 的在线 CDN 地址
 *   81051  localPath  gif 的本地绝对路径（`emoji-related/emoji/<md5(关键词)>/<hash>.gif`）
 *   81045  weight     权重 / 热度（越大越优先）
 *
 * 只解析元数据 + 本地路径；字节由渲染层走 `weq-media://relemoji` 从磁盘取，
 * 目录名即 `md5(关键词)`，在 service 层算。
 */

import type { SqlRow } from '@weq/native';
import { QqDb } from '../qq_db';

const TABLE = 'related_emoji_emoji_table';
const SELECT_COLUMNS = `"81054","81030","81033","81029","81051","81045"`;

export interface RelatedEmoji {
  /** 主键 id（`<gifHash><关键词>`）。 */
  id: string;
  /** gif hash（本地文件名 `<hash>.gif`）。 */
  gifHash: string;
  /** 关键词 / 标签。 */
  keyword: string;
  /** 在线 CDN 地址。 */
  remoteUrl: string;
  /** 本地绝对路径。 */
  localPath: string;
  /** 权重 / 热度。 */
  weight: number;
}

export class RelatedEmojiDb extends QqDb {
  /** 全部关联表情行，按关键词权重倒序。缺表返回空表。 */
  async listAll(): Promise<RelatedEmoji[]> {
    let rows: SqlRow[];
    try {
      rows = await this.query(`SELECT ${SELECT_COLUMNS} FROM ${TABLE} ORDER BY "81045" DESC`);
    } catch {
      return [];
    }
    return rows.map(rowToRelated);
  }
}

function rowToRelated(row: SqlRow): RelatedEmoji {
  return {
    id: String(row[0] ?? ''),
    gifHash: String(row[1] ?? ''),
    keyword: String(row[2] ?? ''),
    remoteUrl: String(row[3] ?? ''),
    localPath: String(row[4] ?? ''),
    weight: Number(row[5] ?? 0),
  };
}
