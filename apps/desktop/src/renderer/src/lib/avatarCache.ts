/**
 * Avatar URL helper — route every remote avatar through the `weq-avatar://`
 * protocol so the main process can disk-cache it (see
 * src/main/avatar_protocol.ts). Wrapping an upstream URL once at the `<img>`
 * site is all the renderer has to do.
 */

const SCHEME = 'weq-avatar';
const MEDIA_SCHEME = 'weq-media';

/**
 * Build the local-first avatar URL: the main process resolves the peer's cached
 * `nt_data/avatar` file (via the uid hash formula) and only hits the CDN — the
 * original `fb` url — on a miss. `v=big` asks for the original; the resolver
 * falls back to the thumbnail when that's all QQ cached.
 */
function localFirst(params: Record<string, string>, fb: string): string {
  const q = new URLSearchParams({ ...params, v: 'big', fb });
  return `${MEDIA_SCHEME}://avatar?${q.toString()}`;
}

/**
 * Wrap an upstream avatar URL so it's served from a disk cache. QQ avatars
 * (user / group) are routed local-first through `weq-media://avatar` — QQ
 * already cached them under `nt_data/avatar`, so we serve those bytes offline
 * and instantly, falling back to the CDN when absent. Other remote avatars go
 * through the `weq-avatar://` URL cache. `null`/local/data URLs are untouched.
 */
export function cachedAvatarUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  // Only remote http(s) avatars go through a cache; leave data:, blob:,
  // weq-asset:, and anything already wrapped alone.
  if (!/^https?:\/\//i.test(src)) return src;

  // User avatar endpoint: …qlogo.cn/g?…&nk=<uin>… (thirdqq / q / q1 / q2).
  const userNk = src.match(/^https?:\/\/[^/]*qlogo\.cn\/[^?]*\?[^#]*\bnk=(\d+)/i);
  if (userNk) return localFirst({ scope: 'user', uin: userNk[1]! }, src);
  // Group avatar endpoint: …p.qlogo.cn/gh/<code>/<code>/<size> (code == uid).
  const groupGh = src.match(/^https?:\/\/[^/]*qlogo\.cn\/gh\/(\d+)\//i);
  if (groupGh) return localFirst({ scope: 'group', uid: groupGh[1]! }, src);

  // Non-QQ remote avatar (e.g. GitHub in demo/agentlab): plain URL disk cache.
  return `${SCHEME}://fetch?src=${encodeURIComponent(src)}`;
}
