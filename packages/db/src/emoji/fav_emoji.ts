/**
 * `fav_emoji_info_storage_table` —— emoji.db 里「我喜欢的自定义表情」（收藏）。
 *
 * 每行 = 一张收藏的自定义表情。列含义（QQ 用纯数字列名，未列出的列无解析价值）：
 *   80002  id         主键，形如 `<batch>_0_0_0_<HASH>_0_0`
 *   80001  order      面板里的排序号（0 起递增，越小越靠前 —— 即 QQ 面板顺序）
 *   1002   batchId    收藏批次（一个 Unix 秒时间戳字符串）
 *   80011  hash       图片 hash（图片缓存用的 key）
 *   80012  oriPath    「原图」的绝对路径（personal_emoji/Ori/<hash>.<ext>）
 *   80014  thumbPath  「缩略图」的绝对路径（可能为空）
 *   80010  remoteUrl  该表情的在线 CDN 地址（可空）
 *
 * 只解析元数据 + 本地路径；字节由渲染层走 `weq-media://cemoji` 从磁盘取。
 * 收藏目录固定是 `personal_emoji`（scope=personal），所以路径解析在 service 层做。
 */

import type { SqlRow } from '@weq/native';
import { QqDb } from '../qq_db';

const TABLE = 'fav_emoji_info_storage_table';
const SELECT_COLUMNS = `"80002","80001","1002","80011","80012","80013","80014","80010"`;

export interface FavEmoji {
  /** 主键 id。 */
  id: string;
  /** 面板排序号（越大越靠前）。 */
  order: number;
  /** 收藏批次（Unix 秒时间戳字符串）。 */
  batchId: string;
  /** 图片 hash。 */
  hash: string;
  /** 原图绝对路径。 */
  oriPath: string;
  /** 缩略图绝对路径（可能为空）。 */
  thumbPath: string;
  /** 在线 CDN 地址（可能为空）。 */
  remoteUrl: string;
}

export class FavEmojiDb extends QqDb {
  /**
   * 全部收藏，按排序号正序（`80001` 0 起递增，与 QQ 面板一致；此前误用了倒序）。
   * 缺表返回空表。
   */
  async listAll(): Promise<FavEmoji[]> {
    let rows: SqlRow[];
    try {
      rows = await this.query(
        `SELECT ${SELECT_COLUMNS} FROM ${TABLE} ORDER BY "80001" ASC`,
      );
    } catch {
      return [];
    }
    return rows.map(rowToFav);
  }
}

// SELECT 列顺序：80002,80001,1002,80011,80012,80013,80014,80010 ——
// row[5]（80013）当前恒为空、无解析价值，这里按位置跳过。
function rowToFav(row: SqlRow): FavEmoji {
  return {
    id: String(row[0] ?? ''),
    order: Number(row[1] ?? 0),
    batchId: String(row[2] ?? ''),
    hash: String(row[3] ?? ''),
    oriPath: String(row[4] ?? ''),
    thumbPath: String(row[6] ?? ''),
    remoteUrl: String(row[7] ?? ''),
  };
}
