/**
 * Avatar URL helper — route every remote avatar through the `weq-avatar://`
 * protocol so the main process can disk-cache it (see
 * src/main/avatar_protocol.ts). Wrapping an upstream URL once at the `<img>`
 * site is all the renderer has to do.
 */

const SCHEME = 'weq-avatar';

/**
 * Wrap an upstream avatar URL so it's served from the disk cache. Returns
 * `null`/local/already-wrapped/data URLs untouched (nothing to cache).
 */
export function cachedAvatarUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  // Only remote http(s) avatars go through the cache; leave data:, blob:,
  // weq-asset:, and anything already wrapped alone.
  if (!/^https?:\/\//i.test(src)) return src;
  return `${SCHEME}://fetch?src=${encodeURIComponent(src)}`;
}
