/**
 * Renders a `markdown` element that carries `flashTransferInfo` as a QQ 闪传
 * (flash transfer) file card, faithfully porting the "Flash Transfer Render"
 * demo. The whole card is reconstructed from the element's `markdownContent`,
 * which for these messages is a single markdown link:
 *
 *   [闪传](mqqapi://markdown/node?nodeType=richui&json=<url-encoded JSON>)
 *
 * The engine: pull the `json` query param out of that mqqapi URL, JSON.parse it,
 * then recursively flatten the rich-ui attribute tree into a `viewId → node`
 * dictionary so we can read `title` / `image` / `desc` / `tailIcon` / `tailText`
 * regardless of how deeply they're nested.
 *
 * 点击卡片不再换 sharelink 开 webview，而是直接打开文件浏览弹窗
 * （FlashTransferViewer，匿名 HTTP2RPC 拉列表）。「分享」按钮在浏览弹窗里。
 *
 * 另一条降级路径见 {@link QqFlashTransferLink}：Linux / 鸿蒙端收到的闪传没有卡片
 * 元素、没有 filesetId，只有一条带分享短码的纯文本，不走浏览弹窗。
 */

// ---- parsing (ported from the demo) --------------------------------------

/** Pull the `json` param out of the `[闪传](mqqapi://markdown/node?...)` link. */
function parseMqqUrlJson(rawStr: string): Record<string, unknown> | null {
  try {
    const urlMatch = rawStr.match(/mqqapi:\/\/markdown\/node\?([^)]+)/);
    if (!urlMatch?.[1]) return null;
    const params = new URLSearchParams(urlMatch[1]);
    const json = params.get('json');
    if (!json) return null;
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 万能打平：递归把嵌套的 rich-ui 属性树压成 viewId → node 强索引字典。 */
function flattenAttributes(
  attrArray: unknown,
  dict: Record<string, Record<string, unknown>> = {},
): Record<string, Record<string, unknown>> {
  if (!Array.isArray(attrArray)) return dict;
  for (const item of attrArray as Array<Record<string, unknown>>) {
    if (item && typeof item.viewId === 'string') dict[item.viewId] = item;
    if (item?.attributes) flattenAttributes(item.attributes, dict);
  }
  return dict;
}

/** The bits the card actually shows, lifted out of the rich-ui tree. */
export interface FlashTransferView {
  title: string;
  coverImg: string;
  failedSrc: string;
  tailIcon: string;
  tailText: string;
  /** desc straight from the JSON (often an empty string — caller may default). */
  descText: string;
  /** Internal click route (mqqrouter://…) — 可从中兜底解析 fileset_id。 */
  schema: string;
}

/** Decode + flatten a flash-transfer markdownContent into its render materials. */
export function parseFlashTransfer(markdownContent: string): FlashTransferView | null {
  const rawJson = parseMqqUrlJson(markdownContent);
  const attrs = rawJson?.attributes as Record<string, unknown> | undefined;
  if (!attrs) return null;

  const top = attrs.attributes;
  const ui = flattenAttributes(top);
  const fileRoute = Array.isArray(top)
    ? (top as Array<Record<string, unknown>>).find((i) => i?.viewId === 'file')
    : undefined;

  const str = (node: Record<string, unknown> | undefined, key: string): string =>
    node && typeof node[key] === 'string' ? (node[key] as string) : '';

  return {
    title: str(ui.title, 'text') || '未知文件',
    coverImg: str(ui.image, 'src'),
    failedSrc: str(ui.image, 'failedSrc'),
    tailIcon: str(ui.tailIcon, 'src'),
    tailText: str(ui.tailText, 'text') || 'QQ闪传',
    descText: str(ui.desc, 'text'),
    schema: typeof fileRoute?.schema === 'string' ? (fileRoute.schema as string) : '',
  };
}

/** Short title for the conversation-list preview (null if not a flash card). */
export function flashTransferTitle(markdownContent: string): string | null {
  return parseFlashTransfer(markdownContent)?.title ?? null;
}
