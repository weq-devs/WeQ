/**
 * chatType（SQL 列 40010）→ 会话种类。严格 allowlist，不做子串匹配 —— 之前
 * `String(chatType).includes('C2C'/'GROUP'/'DATALINE')` 的写法既漏判过
 * （`KCHATTYPETEMPFRIENDVERIFY` 注释写了 c2c，名字里却没有 "C2C"，被漏排除）
 * 也需要靠判断顺序硬撑重叠（`TEMPC2CFROMGROUP` 同时含 C2C 和 GROUP）。
 */

import { ChatType } from './enums';

export type ChatKind = 'direct' | 'group' | 'dataline' | 'service' | 'official';

const DIRECT = new Set<number>([
  ChatType.KCHATTYPEC2C, // 1 好友私聊
  ChatType.KCHATTYPETEMPC2CFROMGROUP, // 100 群聊发起的临时会话
  ChatType.KCHATTYPETEMPC2CFROMUNKNOWN, // 99 临时会话（未知来源）
  ChatType.KCHATTYPETEMPFRIENDVERIFY, // 101 临时会话（好友验证）
]);
const GROUP = new Set<number>([ChatType.KCHATTYPEGROUP]); // 2，仅此一个
const DATALINE = new Set<number>([ChatType.KCHATTYPEDATALINE, ChatType.KCHATTYPEDATALINEMQQ]);
const SERVICE = new Set<number>([ChatType.KCHATTYPESERVICEASSISTANT]); // 118，实现待定
const OFFICIAL = new Set<number>([ChatType.KCHATTYPETEMPPUBLICACCOUNT]); // 103，实现待定

/**
 * wire chatType 有两种形态：db 层对已知值会用 `enumName()` 映射成枚举成员名字符串
 * （如 "KCHATTYPEC2C"），未知值原样传回数字 —— 这里把两种都转回数字判定。
 */
export function toChatTypeNumber(chatType: string | number): number | null {
  if (typeof chatType === 'number') return chatType;
  if (/^-?\d+$/.test(chatType)) return Number(chatType);
  const n = (ChatType as unknown as Record<string, number>)[chatType];
  return typeof n === 'number' ? n : null;
}

/**
 * 不在名单里的一律返回 null —— 含大量未确认类型（如 MATCHFRIEND/NEARBY/
 * TEMPNEARBYPRO，枚举注释写了"c2c"但未经验证），宁可排除不猜。
 */
export function classifyChatType(chatType: string | number): ChatKind | null {
  const n = toChatTypeNumber(chatType);
  if (n === null) return null;
  if (DIRECT.has(n)) return 'direct';
  if (GROUP.has(n)) return 'group';
  if (DATALINE.has(n)) return 'dataline';
  if (SERVICE.has(n)) return 'service';
  if (OFFICIAL.has(n)) return 'official';
  return null;
}
