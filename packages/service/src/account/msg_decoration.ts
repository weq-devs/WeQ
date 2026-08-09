/**
 * Per-message decoration resolution with in-memory itemId cache.
 *
 * Column 40801 gives us {bubbleId, fontId, widgetId} per message. This service
 * resolves those raw itemIds into renderable data:
 *
 *  - bubble: full BubbleSkin (via DressInstallService — tries legacy CDN URL
 *    then protocol fallback). Cached permanently in memory by itemId.
 *  - font: same pattern as bubble — auto-installs via DressInstallService
 *    (requires an online instance; see installFont's doc). Cached permanently
 *    in memory by itemId, so the same itemId across many messages only pays
 *    the scupdate round-trip once per session.
 *  - widget: direct CDN URL construction (tianquan.gtimg.cn/faceAddon).
 *
 * Same itemId → cache hit, never re-fetched for the session lifetime.
 */

import type { DressInstallService } from './dress_install';
import type { BubbleSkin } from './bubble_skin';
import { getLogger, logErrorContext } from '../common/logger';

const WIDGET_BASE = 'https://tianquan.gtimg.cn/faceAddon/item';

export interface ResolvedMsgDecoration {
  bubble: BubbleSkin | null;
  fontFile: string | null;
  widgetUrl: string | null;
}

export class MsgDecorationCacheService {
  private readonly logger = getLogger().child({ scope: 'msg-decoration' });
  private readonly bubbleResolved = new Map<number, BubbleSkin | null>();
  private readonly bubblePending = new Map<number, Promise<BubbleSkin | null>>();
  private readonly fontResolved = new Map<number, string | null>();
  private readonly fontPending = new Map<number, Promise<string | null>>();

  constructor(private readonly dressInstall: DressInstallService) {}

  async resolve(ids: {
    bubbleId: number;
    fontId: number;
    widgetId: number;
  }): Promise<ResolvedMsgDecoration> {
    const [bubble, fontFile] = await Promise.all([
      ids.bubbleId > 0 ? this.resolveBubble(ids.bubbleId) : Promise.resolve(null),
      ids.fontId > 0 ? this.resolveFont(ids.fontId) : Promise.resolve(null),
    ]);
    return {
      bubble,
      fontFile,
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

  /**
   * Mirrors {@link resolveBubble}: installFont() itself already caches on
   * disk (manifest) and is a no-op if the ttf is already there, so the only
   * thing this in-memory layer adds is de-duping concurrent/repeat lookups
   * for the same itemId within the session — including failed ones (no
   * online instance, item pulled from shelf, …), so we don't re-hit scupdate
   * on every message using that font.
   *
   * Name/previewUrl are left blank — this path never feeds the "my dress"
   * list (that's only populated by explicit user installs), it only needs
   * the ttf file path to hand back.
   */
  private async resolveFont(itemId: number): Promise<string | null> {
    if (this.fontResolved.has(itemId)) return this.fontResolved.get(itemId)!;
    let pending = this.fontPending.get(itemId);
    if (!pending) {
      pending = this.dressInstall
        .installFont(itemId, '')
        .then((entry) => {
          this.fontResolved.set(itemId, entry.file);
          this.fontPending.delete(itemId);
          this.logger.info('resolved msg font', {
            event: 'msg-font-resolved',
            itemId,
            file: entry.file,
          });
          return entry.file;
        })
        .catch((e) => {
          this.fontResolved.set(itemId, null);
          this.fontPending.delete(itemId);
          this.logger.warn('msg font resolve failed', {
            event: 'msg-font-resolve-failed',
            itemId,
            ...logErrorContext(e),
          });
          return null;
        });
      this.fontPending.set(itemId, pending);
    }
    return pending;
  }
}
