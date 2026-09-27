/**
 * `emoji` —— QQ NT 内置表情库（emoji.db）访问。
 *
 * 解析 base_sys_emoji_table（系统表情元数据）、market_emoticon_package_table
 * （已添加商城表情包清单）、market_emoticon_table（包内逐张明细）、
 * emoji_com_used_table（最近使用）、fav_emoji_info_storage_table（收藏）、
 * related_emoji_emoji_table（关联 GIF）。每个表一个文件、走同样的 QqDb 模式。
 */

export { BaseSysEmojiDb } from './base_sys_emoji';
export type { SysEmoji } from './base_sys_emoji';
export { MarketEmoticonPackageDb } from './market_emoticon_package';
export type { MarketEmoticonPackage } from './market_emoticon_package';
export { MarketEmoticonDb } from './market_emoticon';
export type { MarketEmoticon } from './market_emoticon';
export { EmojiComUsedDb } from './emoji_com_used';
export type { RecentEmojiEntry, RecentEmojiInput, RecentEmojiState } from './emoji_com_used';
export { FavEmojiDb } from './fav_emoji';
export type { FavEmoji } from './fav_emoji';
export { RelatedEmojiDb } from './related_emoji';
export type { RelatedEmoji } from './related_emoji';
