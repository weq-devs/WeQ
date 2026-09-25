/**
 * `base_sys_emoji_table` —— emoji.db 里的内置表情元数据。
 *
 * 列含义（QQ 用纯数字列名）：
 *   81211  id          表情 ID
 *   81212  desc        外显文字（如 "[微笑]"，部分行直接是 emoji 字符）
 *   81214  unicodeId   Unicode 字符表情的 face_id（如 😊 = 128522）；0 / 空表示非此类
 *   81215  straw?      实测与「有没有 81216/81217」完全等价（见下），语义未判定
 *   81216  packId     超级/动态表情所属表情包 id（= QFaceExtra.packId）；0 / 空 = 无
 *   81217  stickerId  超级/动态表情在该包内的贴纸 id（= QFaceExtra.stickerId）；0 / 空 = 无
 *   81221  special     特殊类表情标识（0 正常，1 特殊）
 *   81226  emojiType   1 系统表情 / 2 emoji 表情 / 3 动态可变表情（如掷骰子）
 *   81266  category    分类名（如「小黄脸表情」「QQ黄脸」「emoji 表情」），可空
 *   81229  staticUrl   静态图片下载地址
 *   81230  apngUrl     APNG 图片下载地址（emoji 表情无此链接）
 *
 * 81218 是 81229/81230 下载链接的 protobuf 包，无解析价值，跳过。
 *
 * 关键点：81216/81217 是**发超级表情**（commonElem serviceType 37 的 QFaceExtra）
 * 唯一缺的那两块 —— 拿不到就别走 svc 37，服务端会把 faceId 静默换一张脸。实测
 * 这两列同进同出（155 行都有 / 216 行都没有），所以 sticker 布尔量按它们判定即可。
 *
 * 顺带观测（**未定语义，别据此改判定**）：81215 与「有没有 81216/81217」在 371 行
 * 上完全等价 —— 小黄脸 81215=0、字符表情 81215=4、其余（有贴纸 id 的）∈ {1,2,3}。
 * 取 1/2/3 是三种不同形态这一点还没查清，所以本类不读它、也不暴露它。
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
  /**
   * 超级/动态表情的表情包 id（81216）—— 原样对应 `QFaceExtra.packId`。
   * 没有则空串（这类表情不能走 commonElem serviceType 37 发送）。
   */
  packId: string;
  /**
   * 超级/动态表情在该包内的贴纸 id（81217）—— 原样对应 `QFaceExtra.stickerId`。
   *
   * ⚠️ `(packId, stickerId)` **不唯一**：实测 `(6,8)` / `(5,8)` 各命中 3 个 faceId、
   * `(1,56)` 命中 2 个。拼 QFaceExtra 时必须把 81211(faceId) 一起当 `qsid` 传，
   * 否则服务端可能换一张脸。唯一键是 faceId。
   */
  stickerId: string;
  /**
   * 是否带超级/动态表情目录信息（81216 与 81217 都非空）。
   *
   * 这是「能不能按贴纸发」的**权威判据** —— 比 `category`（81266）文案稳：
   * 分类名会随版本改（实测已有「开学季限时表情8.27-9.14」这种带日期的），
   * 而这两个 id 只在真贴纸上出现。
   */
  sticker: boolean;
  special: number;
  emojiType: number;
  /** 分类名（81266，如「小黄脸表情」「QQ黄脸」「emoji 表情」）；可空。 */
  category: string;
  staticUrl: string;
  apngUrl: string;
}

const SELECT_COLUMNS = `"81211","81212","81214","81216","81217","81221","81226","81266","81229","81230"`;

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
  const packId = String(row[3] ?? '').trim();
  const stickerId = String(row[4] ?? '').trim();
  return {
    id: String(row[0] ?? ''),
    desc: String(row[1] ?? ''),
    unicodeId: Number(row[2] ?? 0),
    packId,
    stickerId,
    sticker: packId !== '' && stickerId !== '' && packId !== '0' && stickerId !== '0',
    special: Number(row[5] ?? 0),
    emojiType: Number(row[6] ?? 0),
    category: String(row[7] ?? ''),
    staticUrl: String(row[8] ?? ''),
    apngUrl: String(row[9] ?? ''),
  };
}
