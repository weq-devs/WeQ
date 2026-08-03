/**
 * QQ 机器人 markdown 的方言处理。
 *
 * 机器人卡片的 markdownContent 不是标准 markdown，掺了三样 QQ 私货：
 *
 *   `[](%7B%22version%22%3A2%7D)`              —— 版本标记，URL 编码的 {"version":2}
 *   `[@LU](mqqapi://markdown/mention?...)`     —— @ 提及，链到 QQ 私有协议
 *   `![img#900px #383px](https://…)`           —— 图片，尺寸写在 alt 里
 *
 * 前两样交给 streamdown 会被它内置的 rehype-harden 判定为不安全 URL，渲染成
 * 「[blocked]」字样；第三样的尺寸提示不处理的话，18px 的行内小头像会按原图
 * 尺寸铺满整行。所以在喂给 streamdown 之前先把方言翻成标准 markdown。
 */

/** `[](...)` 空文案链接 —— 版本标记之类的元数据，整条丢掉。 */
const EMPTY_LINK = /\[\]\([^)\n]*\)/g;

/** `[文案](mqqapi://...)` —— QQ 私有协议，只保留文案。 */
const QQ_PROTO_LINK = /\[([^\]\n]*)\]\((?:mqqapi|qqapi|mqqopensdkapi):\/\/[^)\n]*\)/g;

/** `![img#900px #383px](url)` 里的尺寸提示。 */
const IMG_SIZE_HINT = /#(\d+)px(?:\s+#(\d+)px)?/;

/** 把 QQ 方言翻成标准 markdown。非机器人消息传进来也是安全的（无匹配即原样返回）。 */
export function normalizeBotMarkdown(text: string): string {
  return text
    .replace(EMPTY_LINK, '')
    .replace(QQ_PROTO_LINK, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 从图片 alt 里读出 QQ 写的渲染尺寸。
 *
 * QQ 用它区分「卡片大图」和「行内小图标」——同一条消息里 900×383 的是封面，
 * 18×18 的是 @ 提及前面那个头像。没有提示时返回 null，按普通图片渲染。
 */
export function imageSizeHint(alt: string | undefined): { width: number; height?: number } | null {
  if (!alt) return null;
  const m = IMG_SIZE_HINT.exec(alt);
  if (!m) return null;
  const width = Number(m[1]);
  const height = m[2] ? Number(m[2]) : undefined;
  return Number.isFinite(width) && width > 0 ? { width, height } : null;
}
