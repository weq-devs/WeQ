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

import { protocol } from 'electron';
import { getAppContext } from './context/app_context';

export const AVATAR_SCHEME = 'weq-avatar';

export function registerAvatarScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: AVATAR_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
}

export function registerAvatarProtocol(): void {
  protocol.handle(AVATAR_SCHEME, async (request) => {
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
      return new Response(new Uint8Array(blob.data), {
        status: 200,
        headers: {
          'Content-Type': blob.contentType,
          // Let the renderer / Chromium memory-cache it too; the on-disk cache
          // is authoritative, this just avoids re-asking the protocol.
          'Cache-Control': 'public, max-age=86400',
        },
      });
    } catch {
      return new Response('avatar fetch failed', { status: 502 });
    }
  });
}
