/**
 * `market_emoticon_package_table` —— emoji.db 里「我添加到本地的商城表情包」清单。
 *
 * 每行 = 用户收藏/添加的一个商城表情包（package）。纯 SQLite，无 protobuf。
 *
 * 列含义（QQ 用纯数字列名，未列出的列恒为默认值 / 无解析价值）：
 *   80943  packId       表情包 ID（主键，TEXT；等同 mface element 的 emojiPackId）
 *   80947  name         表情包名称（如 "3D萌弹PUPU鹅"）
 *   80948  summary      表情包描述文案
 *   80963  addTime      添加时间（Unix 秒）
 *   80970  sizeInfoJson 尺寸列表 JSON，如 [{"Height":300,"Width":300},…]
 */

import type { SqlRow } from '@weq/native';
import { QqDb } from '../qq_db';

export interface MarketEmoticonPackage {
  /** 表情包 ID（emojiPackId）。 */
  packId: string;
  /** 表情包名称。 */
  name: string;
  /** 表情包描述文案。 */
  summary: string;
  /** 添加时间（Unix 秒；0 表示缺失）。 */
  addTime: number;
  /** 尺寸列表原始 JSON 字符串（如 `[{"Height":300,"Width":300}]`）。 */
  sizeInfoJson: string;
}

const SELECT_COLUMNS = `"80943","80947","80948","80963","80970"`;

export class MarketEmoticonPackageDb extends QqDb {
  /** 列出全部本地商城表情包，按添加时间倒序（最近添加在前）。 */
  async listAll(): Promise<MarketEmoticonPackage[]> {
    const rows = await this.query(
      `SELECT ${SELECT_COLUMNS} FROM market_emoticon_package_table ORDER BY "80963" DESC`,
    );
    return rows.map(rowToPackage);
  }
}

function rowToPackage(row: SqlRow): MarketEmoticonPackage {
  return {
    packId: String(row[0] ?? ''),
    name: String(row[1] ?? ''),
    summary: String(row[2] ?? ''),
    addTime: Number(row[3] ?? 0),
    sizeInfoJson: String(row[4] ?? ''),
  };
}
