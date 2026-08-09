/**
 * Per-message decoration resolution with in-memory itemId cache.
 *
 * Column 40801 gives us {bubbleId, fontId, widgetId} per message. This service
 * resolves those raw itemIds into renderable data:
 *
 *  - bubble: full BubbleSkin (via DressInstallService — tries legacy CDN URL
 *    then protocol fallback). Cached permanently in memory by itemId.
 *  - font: file path only if already installed. Fonts require protocol to
 *    download; we never auto-install from messages.
 *  - widget: direct CDN URL construction (tianquan.gtimg.cn/faceAddon).
 *
 * Same itemId → cache hit, never re-fetched for the session lifetime.
 */

import type { DressInstallService } from './dress_install';
import type { BubbleSkin } from './bubble_skin';

const WIDGET_BASE = 'https://tianquan.gtimg.cn/faceAddon/item';

export interface ResolvedMsgDecoration {
  bubble: BubbleSkin | null;
  fontFile: string | null;
  widgetUrl: string | null;
}

export class MsgDecorationCacheService {
  private readonly bubbleResolved = new Map<number, BubbleSkin | null>();
  private readonly bubblePending = new Map<number, Promise<BubbleSkin | null>>();

  constructor(private readonly dressInstall: DressInstallService) {}

  async resolve(ids: {
    bubbleId: number;
    fontId: number;
    widgetId: number;
  }): Promise<ResolvedMsgDecoration> {
    const [bubble] = await Promise.all([
      ids.bubbleId > 0 ? this.resolveBubble(ids.bubbleId) : Promise.resolve(null),
    ]);
    return {
      bubble,
      fontFile: ids.fontId > 0 ? this.dressInstall.fontFile(ids.fontId) : null,
      widgetUrl: ids.widgetId > 0 ? this.widgetUrl(ids.widgetId) : null,
    };
  }

  private widgetUrl(widgetId: number): string {
    return `${WIDGET_BASE}/${widgetId}/newPreview2.png`;
  }

  private async resolveBubble(itemId: number): Promise<BubbleSkin | null> {
    if (this.bubbleResolved.has(itemId)) return this.bubbleResolved.get(itemId)!;
    let pending = this.bubblePending.get(itemId);
    if (!pending) {
      pending = this.dressInstall
        .installBubble(itemId)
        .then((skin) => {
          this.bubbleResolved.set(itemId, skin);
          this.bubblePending.delete(itemId);
          return skin;
        })
        .catch(() => {
          this.bubbleResolved.set(itemId, null);
          this.bubblePending.delete(itemId);
          return null;
        });
      this.bubblePending.set(itemId, pending);
    }
    return pending;
  }
}
