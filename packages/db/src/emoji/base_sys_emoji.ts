/**
 * `base_sys_emoji_table` —— emoji.db 里的内置表情元数据。
 *
 * 列含义（QQ 用纯数字列名）：
 *   81211  id          表情 ID
 *   81212  desc        外显文字（如 "[微笑]"，部分行直接是 emoji 字符）
 *   81214  unicodeId   Unicode 字符表情的 face_id（如 😊 = 128522）；0 / 空表示非此类
 *   81221  special     特殊类表情标识（0 正常，1 特殊）
 *   81226  emojiType   1 系统表情 / 2 emoji 表情 / 3 动态可变表情（如掷骰子）
 *   81229  staticUrl   静态图片下载地址
 *   81230  apngUrl     APNG 图片下载地址（emoji 表情无此链接）
 *
 * 81218 是 81229/81230 下载链接的 protobuf 包，无解析价值，跳过。
 *
 * 关键点：81214 有值且非 0 的行是「Unicode 字符表情」（如 😊）。它们会被当成
 * faceElement / 贴表情发送，但没有对应的本地图片资源，前端需要直接按 Unicode
 * 字符渲染——见 listUnicodeEmojis。
 */

import type { SqlRow } from '@weq/native';
import { QqDb } from '../qq_db';

export interface SysEmoji {
  id: string;
  desc: string;
  /** Unicode 字符表情的 face_id；非此类表情为 0。 */
  unicodeId: number;
  special: number;
  emojiType: number;
  staticUrl: string;
  apngUrl: string;
}

const SELECT_COLUMNS = `"81211","81212","81214","81221","81226","81229","81230"`;

export class BaseSysEmojiDb extends QqDb {
  /** 列出 base_sys_emoji_table 的所有行。 */
  async listAll(): Promise<SysEmoji[]> {
    const rows = await this.query(`SELECT ${SELECT_COLUMNS} FROM base_sys_emoji_table`);
    return rows.map(rowToSysEmoji);
  }

  /**
   * 只列出「Unicode 字符表情」——81214 有值且非 0 的行。这类表情没有本地图片
   * 资源，需要按 Unicode 字符直接渲染。
   */
  async listUnicodeEmojis(): Promise<SysEmoji[]> {
    const rows = await this.query(
      `SELECT ${SELECT_COLUMNS} FROM base_sys_emoji_table WHERE "81214" IS NOT NULL AND "81214" != 0`,
    );
    return rows.map(rowToSysEmoji);
  }
}

function rowToSysEmoji(row: SqlRow): SysEmoji {
  return {
    id: String(row[0] ?? ''),
    desc: String(row[1] ?? ''),
    unicodeId: Number(row[2] ?? 0),
    special: Number(row[3] ?? 0),
    emojiType: Number(row[4] ?? 0),
    staticUrl: String(row[5] ?? ''),
    apngUrl: String(row[6] ?? ''),
  };
}
