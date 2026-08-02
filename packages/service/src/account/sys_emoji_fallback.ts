/**
 * 内置表情资源地址的兜底表 —— 当 `emoji.db` 的 `base_sys_emoji_table` 读不到内容时使用。
 *
 * 这张表**不是**为了替代数据库，而是残缺环境的最后退路。已知的两种残缺:
 *   - emoji.db 整个不存在（只拿到一份解密库的静态账号）；
 *   - **表在但 0 行** —— QQ 尚未同步过内置表情，实测发生在从没登录过桌面端的环境。
 *     此时 QQ 自己的 EmojiSystermResource 目录多半也不存在，两头皆空。
 *
 * 数据来自一份真实的 emoji.db（生成脚本 `packages/db/tools/gen_sys_emoji_fallback.ts`）。
 * 腾讯会更新这张表（新表情、资源改版会换时间戳），所以**数据库永远优先**，这里只在
 * 库读不到时兜底 —— 表情少几个、或某个表情停在旧版本，都好过一个都渲染不出来。
 *
 * URL 完全由 (前缀, id, 时间戳) 决定，且同一 id 的 _base/_adv 共用一组:
 *   <prefix>/<id>_base_<ts>.zip   静态 png
 *   <prefix>/<id>_adv_<ts>.zip    apng + lottie
 * 所以按 (前缀, 时间戳) 分组存 id 列表最省 —— 286 个表情压进 19 组。
 * 只收有 adv 包的表情；Unicode 字符表情（😊 那批）没有资源包，按字符渲染。
 */

/** [前缀, 时间戳, 逗号分隔的 id 列表] */
const GROUPS: ReadonlyArray<readonly [string, string, string]> = [
  [
    'https://wa.qq.com/qgif-web-permanent/sysemoji/v1/singleres',
    '1712825561',
    '0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,41,42,43,46,49,53,56,59,60,63,64,66,67,74,75,76,77,78,79,85,86,89,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,114,116,118,119,120,121,123,124,125,129,137,144,146,147,169,171,172,173,174,175,176,177,178,179,181,182,183,185,187,201,212,262,263,264,265,266,267,268,269,270,271,272,273,277,281,282,283,284,285,286,287,289,293,294,295,297,298,299,300,302,303,305,306,307,311,312,314,317,318,319,320,323,324,325,326,333,334,336,337,338,339,341,342,343,345,346,347,349,350,351,352,353,354,355,356,357,358,359,360,361,362,363,364,365,366,367,368,369,370,371,372,373,374,375,376,377,378,379,380,381,382,383,384,385,386,387,388,389,390,391,392,393,394,395,396,397,398,399,400,401,402,403,404,405,406,407,408,409,410,411,412,413',
  ],
  [
    'https://wa.qq.com/qgif-web-permanent/sysemoji/v1/singleres',
    '1755829391',
    '450,451,452,453,454,455,456,457,458,459,460,461,462',
  ],
  [
    'https://wa.qq.com/qgif-web-permanent/sysemoji/v1/singleres',
    '1725334580',
    '422,425,426,427,428',
  ],
  [
    'https://wa.qq.com/qgif-web-permanent/sysemoji/v1/singleres',
    '1770110858',
    '464,466,468,469,470',
  ],
  [
    'https://wa.qq.com/qgif-web-permanent/sysemoji/v1/singleres',
    '1781494455',
    '475,476,477,478,479',
  ],
  [
    'https://wa.qq.com/qgif-web-permanent/sysemoji/v1/singleres',
    '1782964748',
    '480,481,482,483,484',
  ],
  ['https://wa.qq.com/qgif-web-permanent/sysemoji/v1/singleres', '1717502894', '415,416,417,418'],
  ['https://wa.qq.com/qgif-web-permanent/sysemoji/v1/singleres', '1727061166', '419,420,421,423'],
  ['https://wa.qq.com/qgif-web-permanent/sysemoji/v1/singleres', '1736835691', '429,430,432'],
  ['https://wa.qq.com/qgif-web-permanent/sysemoji/v1/singleres', '1719222678', '55,148'],
  ['https://wa.qq.com/qgif-web-permanent/sysemoji/v1/singleres', '1770110940', '463,467'],
  ['https://wa.qq.com/qgif-web-permanent/sysemoji/v1/singleres', '1766043611', '332'],
  ['https://wa.qq.com/qgif-web-permanent/sysemoji/v1/singleres', '1755499209', '344'],
  ['https://wa.qq.com/qgif-web-permanent/sysemoji/v1/singleres', '1725960670', '424'],
  ['https://wa.qq.com/qgif-web-permanent/sysemoji/v1/singleres', '1736838652', '431'],
  ['https://wa.qq.com/qgif-web-permanent/test/sysemoji/v2/singleres', '1754032265', '443'],
  ['https://wa.qq.com/qgif-web-permanent/sysemoji/v1/singleres', '1770260458', '465'],
  ['https://wa.qq.com/qgif-web-permanent/sysemoji/v1/singleres', '1778739853', '472'],
  ['https://wa.qq.com/qgif-web-permanent/sysemoji/v1/singleres', '1781239647', '474'],
];

/** 一个表情的两个资源包地址。 */
export interface FallbackSysEmojiUrls {
  staticUrl: string;
  apngUrl: string;
}

/** id → 资源包地址。首次调用时展开，之后复用。 */
let cached: Map<string, FallbackSysEmojiUrls> | null = null;

/**
 * 兜底的「id → 资源包地址」表。调用方在数据库读不到内容时用它顶上。
 */
export function fallbackSysEmojiUrls(): Map<string, FallbackSysEmojiUrls> {
  if (cached) return cached;
  const out = new Map<string, FallbackSysEmojiUrls>();
  for (const [prefix, ts, ids] of GROUPS) {
    for (const id of ids.split(',')) {
      out.set(id, {
        staticUrl: `${prefix}/${id}_base_${ts}.zip`,
        apngUrl: `${prefix}/${id}_adv_${ts}.zip`,
      });
    }
  }
  cached = out;
  return out;
}
