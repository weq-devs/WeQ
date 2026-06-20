/**
 * `emoji` —— QQ NT 内置表情库（emoji.db）访问。
 *
 * 目前只解析 base_sys_emoji_table；未来若需要 emoji.db 的其它表，在本目录另开
 * 文件、走同样的 QqDb 模式，并在此处导出即可。
 */

export { BaseSysEmojiDb } from './base_sys_emoji';
export type { SysEmoji } from './base_sys_emoji';
