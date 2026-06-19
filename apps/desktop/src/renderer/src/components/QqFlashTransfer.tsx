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
 * Two faithful-but-pragmatic tweaks vs the raw demo:
 *   - Remote images (cover / failedSrc / tail icon) are funnelled through the
 *     `weq-avatar://` disk cache (cachedAvatarUrl) so they clear the renderer
 *     CSP and don't re-hit the CDN.
 *   - The demo's `desc` fallback was a hard-coded "122.21 KB · 1 项 · 14 天后过期"
 *     placeholder; since we now forward the real `flashTransferInfo`, we build it
 *     from the actual file size + create time (the demo's stated intent: "按闪传
 *     文件的标准格式做保底默认显示").
 */

import { useMemo, type ReactElement } from 'react';
import { cachedAvatarUrl } from '../lib/avatarCache';

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
  /** Internal click route (mqqrouter://…) — not openable here, kept for parity. */
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

// ---- desc fallback from the real flashTransferInfo -----------------------

const FLASH_EXPIRE_DAYS = 14;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v.toFixed(0) : v.toFixed(2)} ${units[i]}`;
}

/** "X 天后过期" computed from createTime (seconds); falls back to the 14d default. */
function expiryText(createTimeSec: number): string {
  if (!Number.isFinite(createTimeSec) || createTimeSec <= 0) return `${FLASH_EXPIRE_DAYS} 天后过期`;
  const expireMs = (createTimeSec + FLASH_EXPIRE_DAYS * 86400) * 1000;
  const daysLeft = Math.ceil((expireMs - Date.now()) / 86400000);
  if (daysLeft <= 0) return '已过期';
  return `${daysLeft} 天后过期`;
}

/** Standard 闪传 desc line: "<size> · 1 项 · <expiry>". */
function buildDesc(info: Record<string, unknown> | undefined): string {
  const parts: string[] = [];
  const size = formatBytes(Number(info?.fileBytes));
  if (size) parts.push(size);
  parts.push('1 项');
  parts.push(expiryText(Number(info?.createTime)));
  return parts.join(' · ');
}

// ---- the card ------------------------------------------------------------

export function QqFlashTransfer({
  markdownContent,
  info,
}: {
  markdownContent: string;
  info: unknown;
}): ReactElement | null {
  const view = useMemo(() => parseFlashTransfer(markdownContent), [markdownContent]);
  if (!view) return null;

  const desc = view.descText || buildDesc(info as Record<string, unknown> | undefined);
  const cover = view.coverImg ? cachedAvatarUrl(view.coverImg) ?? view.coverImg : '';
  const fallbackCover = view.failedSrc ? cachedAvatarUrl(view.failedSrc) ?? view.failedSrc : '';
  const tailIcon = view.tailIcon ? cachedAvatarUrl(view.tailIcon) ?? view.tailIcon : '';

  return (
    <div className="weq-flash-card">
      <div className="weq-flash-media-box">
        {cover ? (
          <img
            className="weq-flash-cover"
            src={cover}
            alt=""
            loading="lazy"
            // 加载失败回退到 JSON 里给的 failedSrc 默认封面（dataset 标志位防止死循环）。
            onError={
              fallbackCover
                ? (e) => {
                    const img = e.currentTarget;
                    if (img.dataset.fb !== '1') {
                      img.dataset.fb = '1';
                      img.src = fallbackCover;
                    }
                  }
                : undefined
            }
          />
        ) : null}
      </div>
      <div className="weq-flash-content">
        <div className="weq-flash-title">{view.title}</div>
        <div className="weq-flash-desc">{desc}</div>
        <div className="weq-flash-divider" />
        <div className="weq-flash-footer">
          {tailIcon ? <img className="weq-flash-tail-icon" src={tailIcon} alt="" loading="lazy" /> : null}
          <span>{view.tailText}</span>
        </div>
      </div>
    </div>
  );
}
