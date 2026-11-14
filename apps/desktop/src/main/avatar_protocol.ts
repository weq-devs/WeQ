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
import { imageProcessor } from './image_processor';
import { imagePreview } from './image_preview';
import { avatarResponse } from './avatar_response';
import { networkScope } from '@weq/service/network-scope';
import { hostDataSaver } from './data_saver';

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
  const cache = ctx.bootstrap.avatarCache;
  const restricted = url.searchParams.get('ds') === '1' || (await hostDataSaver());
  const get = (ttl?: number) =>
    networkScope.run(
      {
        restricted,
        intent: url.searchParams.get('intent') === 'interactive' ? 'interactive' : 'prefetch',
        resource: 'avatar',
      },
      () => cache.get(src, 'avatar', ttl),
    );

  try {
    if (url.searchParams.get('preview') === '1') {
      const preview = await get();
      if (preview.data.length === 0) return new Response('avatar empty', { status: 502 });
      try {
        const data = await imagePreview(async () => preview.data);
        return avatarResponse({ data, contentType: 'image/webp' }, request);
      } catch (error) {
        // 只有原生缩放整体不可用（Linux/Electron 的 sharp 崩溃）时才退回原图；
        // 单张坏图仍按原行为 502，避免把超大/损坏内容塞给渲染端。
        if (!imageProcessor.isUnavailable()) throw error;
        return avatarResponse(preview, request);
      }
    }
    const blob = await get(url.searchParams.get('_weq_avatar_remote') === '1' ? 0 : undefined);
    if (blob.data.length === 0) {
      return new Response('avatar empty', { status: 502 });
    }
    return avatarResponse(blob, request);
  } catch {
    return new Response('avatar fetch failed', { status: 502 });
  }
}
