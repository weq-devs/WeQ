/**
 * `emoji_com_used_table.48902` — emoji.db 「最近使用」表情 blob。
 *
 * 表里只有一行（key = `emoji_com_used_key`），48902 列存的是「最近使用过的一串表情」。
 * 外层与其它 QQ BLOB 列同构：`{ 48902: <inner> }`。inner 里：
 *
 *   80751            updatedAt  最后一次更新的 Unix 秒
 *   80760 (repeat)   entries    一条 = 一个用过的表情，按时间倒序（最新的在前）
 *     80770          faceId     表情 ID（对应 base_sys_emoji_table.81211；unicode 表情可能是
 *                                码点，如 128557 = 😭）
 *     80772          sourceType 来源/分类枚举（QQ 内部：1/2/3/10~14 等），原样保留
 *     80773          usedAt     使用时间（Unix 毫秒）
 *     80774          unicode    1 = unicode 字符表情（无本地图片，按字符渲染）
 *     80775          extra      附加字节：unicode 表情这里是字符本身（UTF-8），
 *                                图片表情偶尔是 faceId 字符串
 *
 * 结构在真实 blob（30 条）上逐字段验证过：时间戳两档（秒/毫秒）对得上，
 * unicode 条目的 80774=1 + 80775=字符，图片条目 80774=0。
 */

import { ProtoField, ScalarType } from '../../core';

/** 80760 — 一条最近使用记录。 */
const EmojiUsedEntry = {
  /** 80770 — 表情 ID（↔ base_sys_emoji_table.81211）。 */
  faceId: ProtoField(80770, ScalarType.UINT32, { optional: true }),
  /** 80772 — 来源/分类枚举（QQ 内部），原样保留。 */
  sourceType: ProtoField(80772, ScalarType.UINT32, { optional: true }),
  /** 80773 — 使用时间（Unix 毫秒）。 */
  usedAt: ProtoField(80773, ScalarType.UINT64, { optional: true }),
  /** 80774 — 1 = unicode 字符表情。 */
  unicode: ProtoField(80774, ScalarType.UINT32, { optional: true }),
  /** 80775 — 附加字节：unicode 表情存字符本身，图片表情偶尔是 faceId 字符串。 */
  extra: ProtoField(80775, ScalarType.BYTES, { optional: true }),
};

const EmojiComUsedInner = {
  /** 80751 — 最后一次更新（Unix 秒）。 */
  updatedAt: ProtoField(80751, ScalarType.UINT64, { optional: true }),
  /** 80760 — 使用记录（最新在前）。 */
  items: ProtoField(80760, () => EmojiUsedEntry, { optional: true, repeat: true }),
};

export const EmojiComUsed = {
  /** 48902 — 最近使用内容。 */
  info: ProtoField(48902, () => EmojiComUsedInner, { optional: true }),
};
