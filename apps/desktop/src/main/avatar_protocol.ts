/**
 * `weq-avatar://` — disk-cached bridge for remote avatars.
 *
 * The renderer must never hit the QQ avatar CDN directly (slow, re-fetched on
 * every render). Instead it points `<img>` at this protocol, passing the real
 * upstream URL as the `src` query param:
 *
 *   weq-avatar://fetch?src=https%3A%2F%2Fthirdqq.qlogo.cn%2Fg%3F...%26nk%3D123
 *
 * The handler funnels the URL through {@link AvatarCacheService}: cache hit →
 * bytes off disk, miss → fetched upstream once, persisted, and returned. On
 * any failure we reply 4xx/5xx so the renderer's `<img onError>` falls back to
 * its default glyph.
 *
 * Like the resource protocol: `registerAvatarScheme()` MUST run before app
 * `ready`; `registerAvatarProtocol()` MUST run after.
 */

import { getAppContext } from './context/app_context';

export const AVATAR_SCHEME = 'weq-avatar';

/**
 * Privileged-scheme descriptor for `weq-avatar://`. Registered alongside the
 * resource scheme in one `registerSchemesAsPrivileged` call (see
 * src/main/index.ts) — Electron only honors a single such call before `ready`.
 */
export const AVATAR_PRIVILEGED_SCHEME = {
  scheme: AVATAR_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
  },
} as const;

/**
 * Serve one `weq-avatar://` request. Pure `Request`→`Response`, so the web app
 * can mount it on a plain HTTP route (see `apps/web`) without Electron.
 */
export async function handleAvatarRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const src = url.searchParams.get('src');
  if (!src) {
    return new Response('missing src', { status: 400 });
  }

  const ctx = getAppContext();
  if (!ctx.bootstrap) {
    return new Response('native unavailable', { status: 503 });
  }

  try {
    const blob = await ctx.bootstrap.avatarCache.get(src);
    if (blob.data.length === 0) {
      return new Response('avatar empty', { status: 502 });
    }
    return new Response(new Uint8Array(blob.data), {
      status: 200,
      headers: {
        'Content-Type': blob.contentType,
        // Let the renderer / Chromium memory-cache it too; the on-disk cache is
        // authoritative (and applies the TTL), so keep this short — a long
        // max-age would outlive the disk entry and pin a stale avatar.
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch {
    return new Response('avatar fetch failed', { status: 502 });
  }
}
