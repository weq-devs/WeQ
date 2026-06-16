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
