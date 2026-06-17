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
