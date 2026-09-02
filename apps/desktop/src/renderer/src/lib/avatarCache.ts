/**
 * Avatar URL helper — route every remote avatar through the `weq-avatar://`
 * protocol so the main process can disk-cache it (see
 * src/main/avatar_protocol.ts). Wrapping an upstream URL once at the `<img>`
 * site is all the renderer has to do.
 */

import { avatarFetchUrl, mediaUrl } from './resourceUrl';
import { preferCdnEnabled } from './cdn';

/**
 * Build the local-first avatar URL: the main process resolves the peer's cached
 * `nt_data/avatar` file (via the uid hash formula) and only hits the CDN — the
 * original `fb` url — on a miss. `v=big` asks for the original; the resolver
 * falls back to the thumbnail when that's all QQ cached.
 */
function localFirst(params: Record<string, string>, fb: string): string {
  return mediaUrl('avatar', { ...params, v: 'big', fb });
}

/**
 * Wrap an upstream avatar URL so it's served from a disk cache. QQ avatars
 * (user / group) are routed local-first through `weq-media://avatar` — QQ
 * already cached them under `nt_data/avatar`, so we serve those bytes offline
 * and instantly, falling back to the CDN when absent. Other remote avatars go
 * through the `weq-avatar://` URL cache. `null`/local/data URLs are untouched.
 *
 * 「优先使用 CDN」(AppSettings.preferCdn) 只作用于那两个 QQ 头像端点：它们是公开的，
 * 不看 Referer、也给 CORS 头，浏览器能直连。其余远程图（ARK 预览、静态地图、闪传封面、
 * 收藏图）必须继续走代理。
 */
export function cachedAvatarUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  // Only remote http(s) avatars go through a cache; leave data:, blob:,
  // weq-asset:, and anything already wrapped alone.
  if (!/^https?:\/\//i.test(src)) return src;

  // User avatar endpoint: …qlogo.cn/g?…&nk=<uin>… (thirdqq / q / q1 / q2).
  const userNk = src.match(/^https?:\/\/[^/]*qlogo\.cn\/[^?]*\?[^#]*\bnk=(\d+)/i);
  if (userNk) return preferCdnEnabled() ? src : localFirst({ scope: 'user', uin: userNk[1]! }, src);
  // Group avatar endpoint: …p.qlogo.cn/gh/<code>/<code>/<size> (code == uid).
  const groupGh = src.match(/^https?:\/\/[^/]*qlogo\.cn\/gh\/(\d+)\//i);
  if (groupGh)
    return preferCdnEnabled() ? src : localFirst({ scope: 'group', uid: groupGh[1]! }, src);

  // Non-QQ remote avatar (e.g. GitHub in demo/agentlab): plain URL disk cache.
  // 「优先使用 CDN」刻意不放行这一支 —— 走到这里的是 ARK 卡片预览图、静态地图、闪传
  // 封面、收藏图那些站外资源，它们本来就靠主进程代取（带 Referer、绕开 CORS）才拿得到，
  // 直连只会 403 / 被浏览器拦。该开关只管上面两个 QQ 头像端点。
  return avatarFetchUrl(src);
}
