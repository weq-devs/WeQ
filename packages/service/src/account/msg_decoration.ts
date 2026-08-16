/**
 * Per-message decoration resolution with in-memory itemId cache.
 *
 * Column 40801 gives us {bubbleId, fontId, widgetId} per message. This service
 * resolves those raw itemIds into renderable data:
 *
 *  - bubble: full BubbleSkin (via DressService — tries legacy CDN URL
 *    then protocol fallback). Cached permanently in memory by itemId.
 *  - font: same pattern as bubble — auto-installs via DressService
 *    (requires an online instance; see installFont's doc). Cached permanently
 *    in memory by itemId, so the same itemId across many messages only pays
 *    the scupdate round-trip once per session.
 *  - widget: DressService.resolvePendantAnimation() (scupdate bid=4,
 *    other.zip → aio_file.zip frame sequence) first — needs an online
 *    instance and isn't guaranteed to hit; falls back straight to the guessed
 *    CDN URL construction (tianquan.gtimg.cn/faceAddon) when it doesn't —
 *    there's no intermediate "static aio_50.png" tier. Unlike font, no
 *    online instance is not an error here — it's just another reason to
 *    fall back silently.
 *
 * Same itemId → cache hit, never re-fetched for the session lifetime.
 */

import type { DressService } from './dress_service';
import type { BubbleSkin } from './bubble_skin';
import { getLogger, logErrorContext } from '../common/logger';

const WIDGET_BASE = 'https://tianquan.gtimg.cn/faceAddon/item';

/**
 * A resolved widget/pendant overlay. `animated` distinguishes the two possible
 * shapes: real scupdate frame data (render via CSS keyframe animation) vs. a
 * single guessed CDN URL (render as a plain `<img>`).
 */
export type ResolvedWidget =
  | { animated: true; itemId: number; frameCount: number; frameTimeMs: number; repeat: number }
  | { animated: false; itemId: number; url: string };

export interface ResolvedMsgDecoration {
  bubble: BubbleSkin | null;
  fontFile: string | null;
  widget: ResolvedWidget | null;
}

export class MsgDecorationCacheService {
  private readonly logger = getLogger().child({ scope: 'msg-decoration' });
  private readonly bubbleResolved = new Map<number, BubbleSkin | null>();
  private readonly bubblePending = new Map<number, Promise<BubbleSkin | null>>();
  private readonly fontResolved = new Map<number, string | null>();
  private readonly fontPending = new Map<number, Promise<string | null>>();
  private readonly widgetResolved = new Map<number, ResolvedWidget>();
  private readonly widgetPending = new Map<number, Promise<ResolvedWidget>>();

  constructor(private readonly dressInstall: DressService) {}

  async resolve(ids: {
    bubbleId: number;
    fontId: number;
    widgetId: number;
  }): Promise<ResolvedMsgDecoration> {
    const [bubble, fontFile, widget] = await Promise.all([
      ids.bubbleId > 0 ? this.resolveBubble(ids.bubbleId) : Promise.resolve(null),
      ids.fontId > 0 ? this.resolveFont(ids.fontId) : Promise.resolve(null),
      ids.widgetId > 0 ? this.resolveWidget(ids.widgetId) : Promise.resolve(null),
    ]);
    return { bubble, fontFile, widget };
  }

  /** 猜测式回退:纯 item_id 拼接 CDN 预览图 URL,不做探测,成功率不保证。 */
  private legacyWidgetUrl(widgetId: number): string {
    return `${WIDGET_BASE}/${widgetId}/newPreview2.png`;
  }

  /**
   * scupdate 换真实挂件动画帧优先,拿不到(离线 / 服务端无此分包 / 请求失败)时
   * 静默回退到 {@link legacyWidgetUrl} 的猜测拼接 —— 与 resolveBubble/resolveFont
   * 不同,这里没有「失败」这个终态,只有「真动画」和「猜测静态图」两档,所以恒返回
   * 非 null 的 {@link ResolvedWidget}。
   */
  private async resolveWidget(widgetId: number): Promise<ResolvedWidget> {
    if (this.widgetResolved.has(widgetId)) return this.widgetResolved.get(widgetId)!;
    let pending = this.widgetPending.get(widgetId);
    if (!pending) {
      pending = this.dressInstall
        .resolvePendantAnimation(widgetId)
        .then(
          (anim): ResolvedWidget =>
            anim
              ? {
                  animated: true,
                  itemId: widgetId,
                  frameCount: anim.frameCount,
                  frameTimeMs: anim.frameTimeMs,
                  repeat: anim.repeat,
                }
              : { animated: false, itemId: widgetId, url: this.legacyWidgetUrl(widgetId) },
        )
        .catch((): ResolvedWidget => ({ animated: false, itemId: widgetId, url: this.legacyWidgetUrl(widgetId) }))
        .then((final) => {
          this.widgetResolved.set(widgetId, final);
          this.widgetPending.delete(widgetId);
          return final;
        });
      this.widgetPending.set(widgetId, pending);
    }
    return pending;
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
