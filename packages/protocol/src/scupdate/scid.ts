// scid(资源标识)的拼装与解析。
//
// scid 是 SC 快更新体系里对一个「资源文件」的命名,客户端本地拼、服务端按名索引。
// 拼法取自 QQ 8.8.17 apk:气泡见 `BubbleManager.i(int)` / `a(int,String[],String)`,
// 字体见 `com.etrump.mixlayout.FontManager`。
//
// 注意 scid 只定位「哪个文件」,不含下载地址 —— 地址里的 UUID 由服务端生成,必须走
// GetUrl 换取(见 ./get-url.ts)。

import { VasBid } from './schemas';

/**
 * 气泡的分包。一款气泡拆成配置 + 静态图 + 动效三个文件,不一定都存在
 * (只有 config.json 是必然有的)。
 *
 * apk 里还出现过 `all.zip`(聚合下载路径 `downloadGatherItem` 用),但服务端对它
 * 一律回 -20002,故不纳入。
 */
export const BUBBLE_PARTS = ['config.json', 'static.zip', 'other.zip'] as const;
export type BubblePart = (typeof BUBBLE_PARTS)[number];

/** 字体族。普通字体走 main,方正字体走 fzfont(对应 `FontManager` 里 type===3 的分支)。 */
export const FONT_FAMILIES = ['main', 'fzfont'] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];

/**
 * 头像挂件的分包。拼法取自 `AvatarPendantUtil.a(long,int)`:
 * type=1 → aio_50.png(合成到头像上的挂件图,渲染必需)、type=2/默认 → other.zip
 * (动效资源包,不是每款都有)、type=4 → xydata.js(动画/配置数据)。
 * 跟气泡不同,挂件 scid 里没有 `android` 段。
 */
export const PENDANT_PARTS = ['aio_50.png', 'xydata.js', 'other.zip'] as const;
export type PendantPart = (typeof PENDANT_PARTS)[number];

/** 拼气泡 scid:`bubble.android.<id>.<part>`。 */
export function bubbleScid(itemId: number | string, part: BubblePart = 'config.json'): string {
  return `bubble.android.${itemId}.${part}`;
}

/** 拼字体 scid:`font.<family>.android.<id>`(字体不分包,一个 zip 内含一个 ttf)。 */
export function fontScid(itemId: number | string, family: FontFamily = 'main'): string {
  return `font.${family}.android.${itemId}`;
}

/** 拼挂件 scid:`pendant.<id>.<part>`。 */
export function pendantScid(itemId: number | string, part: PendantPart = 'aio_50.png'): string {
  return `pendant.${itemId}.${part}`;
}

/** 一款气泡的全部分包 scid。 */
export function bubbleScids(itemId: number | string): string[] {
  return BUBBLE_PARTS.map((p) => bubbleScid(itemId, p));
}

/** 一款挂件的全部分包 scid。 */
export function pendantScids(itemId: number | string): string[] {
  return PENDANT_PARTS.map((p) => pendantScid(itemId, p));
}

/**
 * 按 scid 前缀推 bid。用于处理 SyncVCR 拉回的清单 —— 那里只有 scid 文本,
 * 而 GetUrl 要求同时给出 bid。无法识别时返回 undefined。
 */
export function bidFromScid(scid: string): VasBid | undefined {
  if (scid.startsWith('bubble.')) return VasBid.Bubble;
  if (scid.startsWith('font.')) return VasBid.Font;
  if (scid.startsWith('theme.')) return VasBid.Theme;
  if (scid.startsWith('pendant.')) return VasBid.Pendant;
  return undefined;
}

/**
 * 从裸响应字节里扫出所有 scid。
 *
 * 刻意不解 SyncVCR 版本表的嵌套 PB —— scid 是可打印 ASCII,按「标识符 + 点 + 后缀」
 * 直接扫更简单,也不会因为服务端调整嵌套层级而失效。代价是可能混入个别非 scid 的
 * 点分字符串,调用方按前缀过滤即可。
 */
export function scanScids(buf: Uint8Array): string[] {
  const printable = Array.from(buf, (b) =>
    b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ' ',
  ).join('');
  const found = new Set<string>();
  for (const m of printable.matchAll(/[A-Za-z][A-Za-z0-9]*\.[A-Za-z0-9._]{3,}/g)) {
    found.add(m[0]);
  }
  return [...found].sort();
}
