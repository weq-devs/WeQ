/**
 * ARK feed helpers — extract & filter ARK elements for 服务号 (118) / 公众号 (103).
 *
 * Both conversation types are ARK-only in practice; this layer strips any
 * non-ARK elements and best-effort extracts a human-readable `prompt` from
 * the ARK JSON payload for preview display.
 */

import type { Element } from '@weq/codec';
import type { RenderElement } from './msg_view';

/**
 * Extract the `.prompt` field from an ARK element's JSON payload, if present.
 * Returns `null` if the element isn't ARK / the JSON is malformed / prompt absent.
 */
export function extractArkPrompt(el: RenderElement | Element): string | null {
  const arkData =
    'kind' in el && el.kind === 'ark'
      ? el.arkData
      : 'type' in el && el.type === 'ark'
        ? el.data?.arkData
        : null;
  if (!arkData || typeof arkData !== 'string') return null;
  try {
    const parsed = JSON.parse(arkData);
    return typeof parsed.prompt === 'string' ? parsed.prompt : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort card extraction from an ARK payload. Returns structured fields
 * (title, text, imageUrl, jumpUrl) for "居中显示" rendering. Not every ARK
 * `view` is handled — just enough for common service/official account cards.
 */
export interface ArkCard {
  title: string;
  text?: string;
  imageUrl?: string;
  jumpUrl?: string;
}

export function extractArkCard(arkData: string): ArkCard | null {
  try {
    const payload = JSON.parse(arkData);
    // Common pattern: payload.meta is an object with a single key (usually "detail_1"
    // or similar), and that child holds { title, desc, url, preview, ... }
    const meta = payload.meta;
    if (!meta || typeof meta !== 'object') return null;

    const firstKey = Object.keys(meta)[0];
    if (!firstKey) return null;

    const detail = meta[firstKey];
    if (!detail || typeof detail !== 'object') return null;

    return {
      title: detail.title ?? detail.plainText ?? detail.message ?? payload.prompt ?? '',
      text: detail.desc ?? detail.contentText ?? detail.message ?? undefined,
      imageUrl: detail.preview ?? detail.coverUrl ?? undefined,
      jumpUrl: detail.url ?? detail.jumpUrl ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Filter a message array to ARK-only, attaching the extracted prompt to each
 * kept message. Messages with zero ARK elements (or all-failed prompt extraction)
 * are dropped.
 */
export function filterArkOnly<T extends { elements: RenderElement[] }>(
  msgs: T[],
): Array<T & { arkPrompt: string }> {
  const out: Array<T & { arkPrompt: string }> = [];
  for (const msg of msgs) {
    const arkEls = msg.elements.filter((el) => el.type === 'ark');
    if (arkEls.length === 0) continue;
    const firstArk = arkEls[0];
    if (!firstArk) continue;
    const prompt = extractArkPrompt(firstArk);
    if (!prompt) continue;
    out.push({ ...msg, arkPrompt: prompt });
  }
  return out;
}
