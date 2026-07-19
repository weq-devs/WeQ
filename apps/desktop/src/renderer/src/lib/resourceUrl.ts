/**
 * URL builders for the `weq-asset://` protocol (served by the main process
 * from the shared `resources/` tree — see src/main/resource_protocol.ts).
 */

const SCHEME = 'weq-asset';

/** `weq-asset://<segments joined by '/'>` */
export function resourceUrl(...segments: string[]): string {
  const path = segments
    .flatMap((segment) => segment.split('/'))
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  return `${SCHEME}://${path}`;
}

/** Shorthand for assets under `resources/emoji/…`. */
export function emojiUrl(...segments: string[]): string {
  return resourceUrl('emoji', ...segments);
}

/** Shorthand for a file-type icon under `resources/fileIcon/…`. */
export function fileIconUrl(iconBasename: string): string {
  return resourceUrl('fileIcon', iconBasename);
}

const MEDIA_SCHEME = 'weq-media';

/**
 * `weq-media://<kind>?<query>` — streams a chat message's on-disk media (served
 * by src/main/media_protocol.ts). `kind` is pic/video/ptt/mface.
 */
export function mediaUrl(kind: string, params: Record<string, string | number>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.set(k, String(v));
  return `${MEDIA_SCHEME}://${kind}?${q.toString()}`;
}

/** Proxy a remote QQ album image through the main process so Qzone referer is attached. */
export function albumMediaUrl(src: string): string {
  return mediaUrl('album', { src });
}

/**
 * Proxy a QQ 收藏 (collection) collector-CDN image (`http://shp.qpic.cn/collector/…`)
 * through the disk-cached avatar bridge. The collector CDN is public (no referer),
 * so the generic fetch+cache bridge is enough; on failure `<img onError>` falls back.
 */
export function collectionImageUrl(src: string): string {
  return `weq-avatar://fetch?src=${encodeURIComponent(src)}`;
}

/** Preview a local file under `nt_data/File/Ori` by absolute path (image thumbnails). */
export function localFileUrl(absPath: string): string {
  return mediaUrl('localfile', { path: absPath });
}

/**
 * Stream a local media-cache file (PhotoWall / Qzone / Pic / Video). `rel` is the
 * path relative to that kind's root (`<bucket>/<name>` or `<month>/Ori|Thumb/<name>`);
 * the main process re-validates it before streaming.
 */
export function localMediaUrl(kind: string, rel: string): string {
  return mediaUrl('localmedia', { kind, rel });
}

/**
 * Stream a voice clip from the local `Ptt` cache, decoded to WAV. `rel` is the
 * path relative to the Ptt root (`<month>/Ori/<name>`); the main process
 * re-validates it and decodes the SILK bytes before streaming playable audio.
 */
export function localVoiceUrl(rel: string): string {
  return mediaUrl('localvoice', { rel });
}
