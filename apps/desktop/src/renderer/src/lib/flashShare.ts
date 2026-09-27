/**
 * 闪传降级文本 / 分享链接的识别工具。
 *
 * Linux / 鸿蒙端 QQ 收不到闪传卡片：服务端把它降级成一条纯文本，卡片元素、
 * `flashTransferInfo`、mqqrouter schema 全都没有，只剩链接里的分享短码：
 *
 *   [ 对方通过QQ闪传发送文件给你，请打开链接查看：https://qfile.qq.com/q/<code>
 *     更新QQ立享免费极速下载，升级链接：https://im.qq.com/… （Linux、鸿蒙暂不支持）]
 *
 * 短码本身就是**公开分享链接**（`https://qfile.qq.com/q/<code>`），所以：
 *   · 对账：发送侧 0x93cf 回执的 `shareUrl` 就是同一个短码，直接拿来当签名；
 *   · 查看：卡片直接把这一页嵌进 `FlashShareDialog`，不需要 filesetId。
 * 只有「按 filesetId 走匿名 RPC 列目录 / 下载」那条路才要 uuid，而降级消息里根本没有
 * uuid、protocol 也没法从短码反查（0x93d3_1 传短码 = 100002）—— 那条路不碰降级消息。
 */

/** `https://qfile.qq.com/q/<code>` —— 捕获组 1 是分享短码。 */
const SHARE_LINK_RE = /https?:\/\/qfile\.qq\.com\/q\/([A-Za-z0-9_-]+)/;

/** 降级文本里必定出现的字样：用它把用户手打的普通分享链接排除在外。 */
const DEGRADE_HINT = '闪传';

/**
 * 从消息文本里抠出闪传分享短码 —— 只有同时带「闪传」字样和 qfile 分享链接才算
 * 降级文本，否则返回 null（普通链接照旧按纯文本渲染）。
 */
export function parseFlashShareCode(text: string): string | null {
  if (!text.includes(DEGRADE_HINT)) return null;
  return SHARE_LINK_RE.exec(text)?.[1] ?? null;
}

/** 发送回执里的 `shareUrl` → 分享短码（拿不到返回 null）。 */
export function flashShareCodeOfUrl(url: string): string | null {
  return SHARE_LINK_RE.exec(url)?.[1] ?? null;
}

/**
 * 会话列表预览 / 气泡正文摘要用的短标签：降级文本整段换成「[QQ闪传]」（与真卡片
 * markdown 的写法一致），不是降级文本就原样返回。
 */
export function flashPreviewLabel(text: string): string {
  return parseFlashShareCode(text) ? '[QQ闪传]' : text;
}
