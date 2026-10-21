/**
 * `weq-media://` — streams a chat message's on-disk media to the renderer.
 *
 * QQ keeps media under `nt_data/{Pic,Video,Ptt,File}` and store stickers under
 * `nt_data/Emoji/marketface` (encrypted). The renderer can't read those paths,
 * so it points `<img>/<audio>` at this protocol with just the lookup inputs;
 * the main process resolves the real file via the account services and streams
 * it back. Misses reply 404 so the renderer falls back to a placeholder.
 *
 *   weq-media://pic?t=<sendTimeMs>&name=<fileName>            → image bytes
 *   weq-media://pic?t=&name=&v=thumb                          → thumbnail bytes
 *   weq-media://video?t=&name=&v=thumb                        → cover image bytes
 *   weq-media://ptt?t=&name=                                  → decoded WAV bytes
 *   weq-media://mface?pack=<emojiPackId>&hash=<marketEmoticonIdHex> → sticker bytes
 *   weq-media://mface?pack=&hash=&enc=tea&key=<opt> → 商城表情包 CDN 加密流 QQTEA 解密后 GIF（解密失败回退明文 raw GIF/PNG）
 *   weq-media://agentvoice?persona=&id=<hash.ext>             → clone TTS audio bytes
 *   weq-media://avatar?scope=user&hash=<hash>&v=big|small     → local avatar-cache bytes
 *   weq-media://avatar?scope=user&uin=<qq>&fb=<cdnUrl>        → 本地 b_/s_ 取新者，过期则回源 CDN
 *   weq-media://avatar?scope=group&uid=<code>&fb=<cdnUrl>     → group avatar (uin==uid)
 *   weq-media://localfile?path=<absPath>                      → trusted local file bytes (media preview)
 *   weq-media://localfilevoice?path=<absPath>                 → trusted local voice (SILK 解码成 WAV)
 *   weq-media://localmedia?kind=pic&rel=<month/Ori/name>      → PhotoWall/Qzone/Pic/Video cache bytes
 *   weq-media://localvoice?rel=<month/Ori/name>               → decoded WAV for a Ptt cache clip
 *   weq-media://dress?src=<tianquanUrl>                       → 会员装扮资源(挂件/名片/浮屏/背景/气泡切片)
 *   weq-media://qqshow?src=<qqshowUrl>                       → QQ 秀形象图(透明全身像,落盘缓存)
 *   weq-media://dressfont?id=<itemId>                         → 已安装的装扮字体 ttf
 *   weq-media://dressbubble?id=<itemId>                       → 走 protocol 装的气泡九宫格(本地 PNG)
 *   weq-media://dressbubble?id=<itemId>&frame=<n>              → 同上,整泡帧动画的第 n 帧(n 从 1 开始)
 *   weq-media://dresspendant?id=<itemId>&frame=<n>             → 走 protocol 换的头像挂件动画帧(本地 PNG,n 从 1 开始)
 *   weq-media://dressbg?v=<stamp>                             → 用户自选的聊天背景(本地图片 / 视频)
 *   weq-media://linkpreview?id=<hash.ext>                     → 链接卡片封面(已落盘、验过魔数)
 *   weq-media://redbag?id=<skinId>                            → 红包皮肤封面(离线目录 → 在线现查 → aio 兜底，均落盘缓存)
 *
 * Like the other custom schemes: `registerMediaScheme()` runs before app
 * `ready`; `registerMediaProtocol()` runs after.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { fileResponse as streamFile } from './file_response';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  PRIVATE_VIDEO_RKEY_TYPE,
  GROUP_VIDEO_RKEY_TYPE,
  PRIVATE_PTT_RKEY_TYPE,
  GROUP_PTT_RKEY_TYPE,
  downloadUrlToFile,
  resolveChatpicFile,
  type AvatarLocalFile,
  type MediaElement,
} from '@weq/service';
import { getAppContext } from './context/app_context';
import { resolveResource } from './resource';
import { resourceSkinCover } from './redpack_catalog';
import { decodeSilkToWav, isSilkFile } from './voice';

/** rkey types accepted when downloading the video COVER (thumb only; the
 *  original mp4 now goes through OIDB). ptt tries rkey first and falls back
 *  to OIDB when the local Ptt file is missing. */
const VIDEO_RKEY_TYPES = [PRIVATE_VIDEO_RKEY_TYPE, GROUP_VIDEO_RKEY_TYPE];
const PTT_RKEY_TYPES = [PRIVATE_PTT_RKEY_TYPE, GROUP_PTT_RKEY_TYPE];
const mediaBinding = new AsyncLocalStorage<() => void>();

/** Stable cache path for an OIDB-downloaded original by its fileToken. */
function oidbCachePath(cacheDir: string, token: string, ext: string): string {
  const hash = createHash('sha1').update(token).digest('hex');
  return join(cacheDir, `${hash}${ext}`);
}

/**
 * Find the video / file / ptt element a chat media URL refers to by re-reading
 * its raw message. Returns the element plus the conversation kind so callers
 * can branch group vs c2c. Matches by fileToken when a message carries several
 * of the same kind; else the first one of that kind.
 *
 * `fwdMsgId` marks a merged-forward sub-message: its snapshot lives only in the
 * carrying message's 40900 cache (never in our own msg tables), so `msgId` is
 * the CARRIER and `fwdMsgId` the sub-message. Those resolve to `conv: null` —
 * a forwarded medium's original scene is unknowable, so the caller must try
 * both. See MediaUrlService.resolveVideoUrlUnknownScene.
 */
export async function findMediaElement(
  msgId: string,
  kind: 'video' | 'file' | 'ptt',
  token: string,
  fwdMsgId = '',
  fwdKind: 'group' | 'c2c' = 'c2c',
): Promise<{ element: MediaElement; conv: 'group' | 'c2c' | null } | null> {
  mediaBinding.getStore()?.();
  const services = getAppContext().services;
  if (!services || !msgId) return null;
  if (fwdMsgId) {
    try {
      const el = await services.msgs.findForwardedMediaElement(
        fwdKind,
        BigInt(msgId),
        BigInt(fwdMsgId),
        kind,
        token,
      );
      return el ? { element: el as unknown as MediaElement, conv: null } : null;
    } catch {
      return null;
    }
  }
  let raw: Awaited<ReturnType<typeof services.msgs.getRawElements>>;
  try {
    raw = await services.msgs.getRawElements(BigInt(msgId));
  } catch {
    return null;
  }
  if (!raw) {
    // 缺失消息弹窗拉到的漫游消息不在本地 msg 表（getRawElements 查不到），
    // 回退到漫游缓存按 msgId 定位媒体元素。
    return services.gapHistory.findMediaElement(msgId, kind, token);
  }
  const matches = raw.elements.filter(
    (e) => e.kind === kind || (kind === 'video' && e.kind === 'bubbleVideo'),
  );
  const el = matches.find((e) => (e as { fileToken?: string }).fileToken === token) ?? matches[0];
  if (!el) return null;
  return { element: el as unknown as MediaElement, conv: raw.kind };
}

/**
 * 外部安卓 chatpic 目录兜底：设置里导入了完整的 chatpic 备份且开关开启时，
 * 按 picElement 的 md5 在 chatraw/chatimg/chatthumb 里寻址。找不到返回 null，
 * 调用方继续走 rkey / CDN 下载。
 */
function resolveChatpicFallback(md5: string): string | null {
  if (!md5) return null;
  const boot = getAppContext().bootstrap;
  const cfg = boot?.userConfig.getSettings().externalChatpic;
  if (!cfg?.enabled || !cfg.dir) return null;
  return resolveChatpicFile(cfg.dir, md5);
}

export const MEDIA_SCHEME = 'weq-media';

export const MEDIA_PRIVILEGED_SCHEME = {
  scheme: MEDIA_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    // dev 模式下渲染页是 `http://localhost:5173`，`weq-media://` 属于**跨源**：
    // `<img>/<video>` 这类 no-cors 请求照样能过，但字体（CORS-mode 的 fetch）
    // 会被 Chromium 直接拦成 "blocked by CORS policy"。生产走 `file://` 时不触发
    // 跨源检查，所以这个坑只在 dev 里出现 —— 两处都要：这里的特权声明 + 下面的
    // 响应头（缺 ACAO 时即使放行也拿不到字体）。
    corsEnabled: true,
  },
} as const;

function notFound(reason: string): Response {
  return new Response(reason, { status: 404 });
}

/**
 * 给每个响应补 `Access-Control-Allow-Origin`。
 *
 * 只有 dev 下的渲染页（`http://localhost:5173`）会真的走到这里：`weq-media://`
 * 与它不同源，字体走的是 CORS-mode 的 fetch（`new FontFace(url)`），缺这个头
 * 就算特权声明里开了 `corsEnabled` 也会被拒。图片/视频是 no-cors 请求，加不加
 * 都无所谓；统一加上省得以后又冒出「某类资源突然要 CORS」。
 *
 * `*` 而不是回显 Origin：这些响应都不带凭据，且协议本身只服务本机文件。
 * 304 也要带（Chromium 对缓存的字体照样做 CORS 校验），所以这里复制原响应头。
 */
function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * The in-flight request, so {@link fileResponse} can honor `Range` without
 * threading a parameter through all ~24 call sites below.
 */
const currentRequest = new AsyncLocalStorage<Request>();

function fileResponse(path: string): Promise<Response> {
  return streamFile(path, currentRequest.getStore());
}

/**
 * Like {@link fileResponse} but asking the renderer to revalidate (304 on an
 * unchanged mtime). For the local avatar cache: the file NAME is a uid hash, so
 * QQ overwrites it in place when someone changes their picture — caching by
 * max-age would keep showing the old one.
 */
function revalidatingFileResponse(path: string): Promise<Response> {
  return streamFile(path, currentRequest.getStore(), { revalidate: true });
}

/**
 * 在线现查红包皮肤封面（`SsoGetSkinInfo`）—— `weq-media://redbag` 回退链的第 2 档。
 *
 * 只在该皮肤不在离线目录、且**有已打开的账号会话、QQ 在线、且未开完全离线模式**时才
 * 尝试。任何一步不满足、或服务端没给封面，都静默返回 null 让调用方走下一档 ——
 * 这条链是「尽力而为」，取不到封面不该让整张卡片挂掉。
 */
async function onlineRedbagCover(skinId: string): Promise<string | null> {
  const ctx = getAppContext();
  const services = ctx.services;
  if (!services) return null;
  if (ctx.bootstrap?.userConfig.getSettings().autoAttachQq === false) return null;
  const record = services.accountConfig.getRecord();
  if (!record?.qqOnline || !record.qqPid) return null;
  try {
    return await services.redbag.skinCoverUrl(Number(skinId), record.qqPid);
  } catch {
    return null;
  }
}

/**
 * CDN fallback for an avatar the local cache didn't have — or one whose local
 * copy is out of date. Routes through the shared {@link AvatarCacheService}
 * disk cache (so the fetched bytes warm the same cache the rest of the app
 * reads), returning 404 on any failure so the renderer shows its glyph.
 *
 * `refresh` forces an upstream re-fetch (`ttl = 0`). `notOlderThanMs` refreshes
 * only when the cached copy is older than that timestamp — the "local file is
 * newer than the cached CDN copy" case: the avatar changed and our disk cache
 * is holding a previous picture. Either way a failed refresh keeps serving the
 * existing entry rather than dropping the avatar.
 *
 * Short `max-age`: the disk cache is the real cache (and applies its own TTL),
 * so a long browser cache would only delay a changed avatar from showing.
 */
async function avatarFallbackResponse(
  src: string,
  refresh: boolean | { notOlderThanMs: number } = false,
): Promise<Response> {
  if (!/^https?:\/\//i.test(src)) return notFound('avatar fallback needs http url');
  const cache = getAppContext().bootstrap?.avatarCache;
  if (!cache) return notFound('avatar cache unavailable');
  let force = refresh === true;
  if (!force && typeof refresh === 'object') {
    const cachedAt = await cache.cachedAt(src, 'avatar').catch(() => null);
    force = cachedAt !== null && cachedAt < refresh.notOlderThanMs;
  }
  const respond = (blob: { data: Buffer; contentType: string }): Response | null =>
    // Defensive: a broken (empty) cache entry must never become a 200 empty body.
    blob.data.length === 0
      ? null
      : new Response(new Uint8Array(blob.data), {
          status: 200,
          headers: { 'Content-Type': blob.contentType, 'Cache-Control': 'public, max-age=300' },
        });
  try {
    const res = respond(await cache.get(src, 'avatar', force ? 0 : undefined));
    if (res) return res;
    if (!force) return notFound('avatar fallback empty');
  } catch {
    if (!force) return notFound('avatar fallback failed');
    // 强制回源失败（离线）→ 退回磁盘上的上一版，别把头像清空。
  }
  try {
    const res = respond(await cache.get(src, 'avatar', undefined));
    return res ?? notFound('avatar fallback empty');
  } catch {
    return notFound('avatar fallback failed');
  }
}

async function albumRemoteResponse(src: string): Promise<Response> {
  if (!/^https?:\/\//i.test(src)) return notFound('album image needs remote url');
  const target = new URL(src);
  const host = target.hostname.toLowerCase();
  const allowed =
    host === 'imgcache.qq.com' ||
    host === 'p.qpic.cn' ||
    host.endsWith('.qpic.cn') ||
    host === 'photo.store.qq.com' ||
    host.endsWith('.photo.store.qq.com') ||
    // 群相册视频走视频 CDN,和图片不同域。实测直链域是
    // groupvideo.photo.qq.com(属于 *.photo.qq.com),还有 .video.qq.com。
    host.endsWith('.photo.qq.com') ||
    host.endsWith('.video.qq.com') ||
    host.endsWith('.gtimg.com') ||
    host.endsWith('.qzone.qq.com') ||
    // 群精华消息图片（腾讯云 COS）
    host.endsWith('.myqcloud.com') ||
    // 群公告图片
    host === 'gdynamic.qpic.cn';
  if (!allowed) return notFound('album image host not allowed');
  // 视频（含 moov 在文件尾部的非 faststart mp4）要能 seek，必须把 Chromium 发来的
  // Range 转发给上游（否则一律回 200 全量 = 不可 seek 流，demuxer 打不开 moov 在
  // 末尾的文件，报 DEMUXER_ERROR_COULD_NOT_OPEN）。上游 CDN 支持 206。
  const incoming = currentRequest.getStore();
  const headers: Record<string, string> = {
    // Referer 的协议必须跟目标一致：Chromium 禁止 https→http 的 referrer 降级,
    // 撞上就是 ERR_BLOCKED_BY_CLIENT(资料卡精选图片走的 ugc.qpic.cn 只有 http)。
    Referer: `${target.protocol}//user.qzone.qq.com/`,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36',
  };
  const range = incoming?.headers.get('range');
  if (range) headers.Range = range;
  const res = await fetch(src, { headers });
  if (!res.ok) return new Response(`album image http ${res.status}`, { status: res.status });
  const contentType = res.headers.get('content-type') ?? '';
  // 视频原样回传：要保留 range 支持（上游 206 + content-range 直接透传），
  // 且不能把整段 mp4 读进内存。
  if (!contentType.startsWith('image/')) return res;
  // 图片则重新组装：qpic 带 `connection: keep-alive` 这类逐跳头,原样回传会让
  // Chromium 的协议处理器直接 ERR_UNEXPECTED。只挑必要的头。
  const body = await res.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' },
  });
}

/**
 * QQ 会员装扮资源(挂件/名片/浮屏/聊天背景)的落盘缓存代理。
 *
 * 渲染进程不直连 tianquan CDN:一来每次渲染都要重拉,二来那样得为它撕开 CSP。这里主进程
 * 代取 + 落盘,渲染进程只见 `weq-media://dress?src=<upstream>`。
 *
 * 图片(挂件 APNG / 浮屏 PNG / 背景 PNG)走 {@link AvatarCacheService},和头像共用同一套
 * 磁盘缓存;名片视频(mp4,实测 2.4MB)体积大且要支持 range 播放,单独落到 media/dress 下
 * 再按文件流回 —— 走 avatarCache 会把整段读进内存,不划算。
 */
async function dressRemoteResponse(src: string, theme: string | null): Promise<Response> {
  if (!/^https:\/\//i.test(src)) return notFound('dress asset needs https url');
  const url = new URL(src);
  const host = url.hostname.toLowerCase();

  // QQ 会员「没开装扮」时接口回默认款,素材是官方推广图(实测 card/item/0/new1.png)。
  // 那是广告不是这个人的装扮,一律不返回。
  if (url.pathname === '/card/item/0/new1.png') {
    // 渲染层把它当名片预览用,不能裂图 —— 回本地占位图:浅色 im_1.png,深色 im_2.jpg。
    const placeholder = resolveResource('img', theme === 'dark' ? 'im_2.jpg' : 'im_1.png');
    return placeholder ? streamFile(placeholder) : notFound('dress ad blocked');
  }
  if (host !== 'tianquan.gtimg.cn') return notFound('dress host not allowed');

  // 名片视频:按 url 哈希落盘,命中直接文件流(支持 range),未命中先下再流。
  if (/\.mp4($|\?)/i.test(src)) {
    const boot = getAppContext().bootstrap;
    if (!boot) return notFound('dress cache unavailable');
    const dir = join(boot.userConfig.cacheDir('media'), 'dress');
    const path = join(dir, `${createHash('sha1').update(src).digest('hex')}.mp4`);
    if (existsSync(path)) return fileResponse(path);
    const outcome = await downloadUrlToFile(src, path);
    return outcome.ok ? fileResponse(path) : notFound(`dress video failed: ${outcome.reason}`);
  }

  // 图片一律走装扮缓存（独立子目录，30天TTL）。注意聊天背景的 aioImage 没有扩展名、
  // Content-Type 是 application/octet-stream,但内容就是 PNG,浏览器按魔数认,不影响渲染。
  const cache = getAppContext().bootstrap?.avatarCache;
  if (!cache) return notFound('dress cache unavailable');
  try {
    const blob = await cache.get(src, 'dress');
    return new Response(new Uint8Array(blob.data), {
      status: 200,
      headers: { 'Content-Type': blob.contentType, 'Cache-Control': 'public, max-age=86400' },
    });
  } catch {
    return notFound('dress asset fetch failed');
  }
}

/**
 * QQ 秀形象图(images.qqshow.gtimg.com)的落盘缓存代理。
 *
 * 与 dress 同款思路:渲染进程不直连 CDN,主进程代取 + 落盘,只放行 qqshow 域名。
 * 图片走 AvatarCacheService 的 `qqshow` 子目录(30 天 TTL,URL 自带版本号不会旧图)。
 */
async function qqshowRemoteResponse(src: string): Promise<Response> {
  if (!/^https:\/\//i.test(src)) return notFound('qqshow asset needs https url');
  const host = new URL(src).hostname.toLowerCase();
  const allowed =
    host === 'qqshow.gtimg.com' ||
    host === 'images.qqshow.gtimg.com' ||
    host.endsWith('.qqshow.gtimg.com');
  if (!allowed) return notFound('qqshow host not allowed');
  const cache = getAppContext().bootstrap?.avatarCache;
  if (!cache) return notFound('qqshow cache unavailable');
  try {
    const blob = await cache.get(src, 'qqshow');
    return new Response(new Uint8Array(blob.data), {
      status: 200,
      headers: { 'Content-Type': blob.contentType, 'Cache-Control': 'public, max-age=86400' },
    });
  } catch {
    return notFound('qqshow asset fetch failed');
  }
}

/**
 * Serve one `weq-media://` request. Pure `Request`→`Response`, so the web app
 * can mount it on a plain HTTP route (see `apps/web`) without Electron.
 */
export async function handleMediaRequest(request: Request, check?: () => void): Promise<Response> {
  try {
    const serve = () =>
      currentRequest.run(request, async () => withCors(await routeMediaRequest(request)));
    return await (check ? mediaBinding.run(check, serve) : serve());
  } catch (e) {
    // 路由内部已经有 try/catch；这里兜住「连 AppContext 都还没初始化」这类
    // 早期错误 —— 否则响应连跨源头都没有，dev 里会被误报成 CORS 失败。
    console.error('[media] request failed:', e);
    return withCors(new Response('media error', { status: 500 }));
  }
}

async function routeMediaRequest(request: Request): Promise<Response> {
  {
    const url = new URL(request.url);
    const kind = url.hostname;
    const q = url.searchParams;

    // 装扮资源只依赖 bootstrap 的缓存,不需要打开的账号 —— 放在 services 断言之前。
    if (kind === 'dress') {
      try {
        return await dressRemoteResponse(q.get('src') ?? '', q.get('theme'));
      } catch (e) {
        console.error('[media] dress failed:', e);
        return new Response('media error', { status: 500 });
      }
    }

    // QQ 秀形象图:同装扮一样只放行 qqshow CDN,主进程代取 + 落盘缓存。
    if (kind === 'qqshow') {
      try {
        return await qqshowRemoteResponse(q.get('src') ?? '');
      } catch (e) {
        console.error('[media] qqshow failed:', e);
        return new Response('media error', { status: 500 });
      }
    }

    // 链接卡片的封面图：字节是 LinkPreviewService 抓来验过魔数后落的盘,只按 id 取,
    // 不接受 url —— 渲染层无法用它当任意 URL 的代理。同样不需要打开的账号。
    if (kind === 'linkpreview') {
      const svc = getAppContext().bootstrap?.linkPreview;
      const blob = svc ? await svc.readImage(q.get('id') ?? '') : null;
      if (!blob) return notFound('link preview image not found');
      return new Response(new Uint8Array(blob.data), {
        status: 200,
        headers: { 'Content-Type': blob.contentType, 'Cache-Control': 'public, max-age=86400' },
      });
    }

    // 红包皮肤封面：按「更可靠的来源优先」逐档回退，第一个拿到字节的胜出；全部失败才 404
    // （渲染层据此回退默认封面图）。每一档都走 avatarCache 落盘缓存（都是公开 CDN 图）：
    //   1. 离线目录（resources/redpack/skins.json 记的 preview）—— 多数皮肤封面并不在
    //      固定路径下，硬拼 aio.png 会 404；这一步不联网、不依赖在线实例。
    //   2. 在线现查（SsoGetSkinInfo）—— **只在离线目录没记 / 取字节失败时**才发；
    //      要求有账号会话、QQ 在线、且未开完全离线模式。
    //   3. aio 硬拼（redpackSkin/<id>/aio.png）—— 老客户端路径，现查也没结果时的兜底。
    //
    // 惰性很关键：在线那档是按需 `await`，不被命中前面的档时调用 —— 否则每渲染一张
    // 红包卡片都会白发一次服务端请求（离线目录本来就覆盖了绝大多数皮肤）。
    if (kind === 'redbag') {
      const skinId = q.get('id') ?? '';
      if (!/^\d+$/.test(skinId)) return notFound('invalid skin id');
      const cache = getAppContext().bootstrap?.avatarCache;
      if (!cache) return notFound('redbag skin cache unavailable');

      const attempts: Array<() => Promise<string | null>> = [
        async () => resourceSkinCover(skinId),
        () => onlineRedbagCover(skinId),
        async () => `https://moggy-1251316161.file.myqcloud.com/redpackSkin/${skinId}/aio.png`,
      ];
      for (const resolve of attempts) {
        const src = await resolve();
        if (!src) continue;
        try {
          const blob = await cache.get(src);
          // 防御：空字节的缓存条目绝不能当 200 空响应返回（会变成一张破图）。
          if (blob.data.length === 0) continue;
          return new Response(new Uint8Array(blob.data), {
            status: 200,
            headers: { 'Content-Type': blob.contentType, 'Cache-Control': 'public, max-age=86400' },
          });
        } catch {
          /* 这一档没有 → 试下一档 */
        }
      }
      return notFound('redbag skin fetch failed');
    }

    // 走到这里的 kind 都需要账号会话（不需要的那四个已在上面提前返回）。
    // 未知 kind 也走这条断言，随后由下面的 switch default 报「unknown media kind」。
    // 没有账号会话（含 AppContext 尚未初始化）→ 统一 404。别让 getAppContext
    // 的 assert 冒出去：协议层抛异常时 Chromium 只会看到一个没有 CORS 头的失败，
    // 排查时会被误读成跨源问题。
    let services: ReturnType<typeof getAppContext>['services'];
    try {
      mediaBinding.getStore()?.();
      services = getAppContext().services;
    } catch {
      return notFound('no account session');
    }
    if (!services) return notFound('no account session');

    // 装扮字体:清单里记的 ttf 绝对路径。放在这里(而不是 weq-asset)是因为
    // weq-asset 只服务仓库的 resources/ 树,读不了账号缓存目录。
    // `revalidate`：这两个文件是**就地重写**的（升级后字体被重新派生、帧图重导出，
    // 路径/文件名都不变），默认的裸响应会让渲染进程拿着上一版字节。带 `no-cache` +
    // `Last-Modified` 后 Chromium 用 `If-Modified-Since` 重问，文件没变答 304（几乎零成本），
    // 变了就拿到新字节。渲染侧另外给 url 拼了派生版本戳（见 resourceUrl），两者互补：
    // 版本戳解决“同一会话里已注册的 face/已解码的图片 ”这种 http 缓存之外的身份问题。
    if (kind === 'dressfont') {
      const id = Number(q.get('id') ?? '0');
      const path = id ? services.dressInstall.fontFile(id) : null;
      return path ? revalidatingFileResponse(path) : notFound('dress font not installed');
    }

    // 字体的 eimg 炫彩帧(炫彩/场景字体独有,见服务侧 fontFrameFile)。与 dressbubble
    // 同构:一个 `frame` 取一帧,帧序按 sidecar 里的变体分组展开。
    if (kind === 'dressfontfx') {
      const id = Number(q.get('id') ?? '0');
      const frame = Number(q.get('frame') ?? '0');
      const path = id && frame > 0 ? services.dressInstall.fontFrameFile(id, frame) : null;
      return path ? revalidatingFileResponse(path) : notFound('dress font fx frame not available');
    }

    // 走 protocol 兜底装上的气泡:九宫格 PNG 是从 static.zip 解出来的本地文件,
    // 上面的 `dress` 分支只放行 tianquan.gtimg.cn,所以本地这条要单独一支。
    // `frame` 有值时取整泡帧动画的某一帧(other.zip 解出来的,见 bubbleFrameFile)。
    if (kind === 'dressbubble') {
      const id = Number(q.get('id') ?? '0');
      const frame = Number(q.get('frame') ?? '0');
      const path = !id
        ? null
        : frame > 0
          ? services.dressInstall.bubbleFrameFile(id, frame)
          : services.dressInstall.bubbleFile(id);
      return path ? fileResponse(path) : notFound('dress bubble not installed');
    }

    // 走 protocol 换的头像挂件动画帧:other.zip → aio_file.zip 解出的逐帧 PNG,
    // 由服务侧 DressService.resolvePendantAnimation 落盘。没有「不带 frame 取静态
    // 图」这一档 —— 挂件不设中间的静态兜底。
    if (kind === 'dresspendant') {
      const id = Number(q.get('id') ?? '0');
      const frame = Number(q.get('frame') ?? '0');
      const path = id && frame > 0 ? services.dressInstall.pendantFrameFile(id, frame) : null;
      return path ? fileResponse(path) : notFound('dress pendant frame not available');
    }

    // 用户自选的聊天背景:已拷进本账号的装扮目录,路径由清单给 —— 不接受 url 传路径,
    // 免得变成一个能读任意本地文件的口子。
    if (kind === 'dressbg') {
      const path = services.dressInstall.backgroundFile();
      return path ? fileResponse(path) : notFound('custom background not set');
    }

    const name = q.get('name') ?? '';
    const tMs = Number(q.get('t') ?? '0');
    const wantThumb = q.get('v') === 'thumb';
    // CDN fallback token: pic/ptt = fileToken; video thumb = videoToken; video
    // original = fileToken. Supplied by the renderer from the message element.
    const token = q.get('token') ?? '';

    try {
      switch (kind) {
        case 'pic': {
          // pic subType 1 = received animated emoji: lives under Emoji/emoji-recv
          // with no "original"; the displayable image comes back as `thumb`.
          const picType = q.get('recv') === '1' ? 'emoji' : 'pic';
          const { source, thumb } = await services.fileSearch.findFile(tMs, name, picType);
          mediaBinding.getStore()?.();
          const path = wantThumb ? (thumb ?? source) : (source ?? thumb);
          if (path) return fileResponse(path);
          // 本地 miss → 外部安卓 chatpic 备份兜底（按 md5 寻址），再不行才走 CDN。
          const chatpicFile = resolveChatpicFallback(q.get('md5') ?? '');
          if (chatpicFile) return fileResponse(chatpicFile);
          // Missing on disk → CDN: digit token → originalUrl (no rkey); else rkey.
          const dl = await services.mediaDownload.download(token, {
            originalUrl: q.get('orig') ?? '',
          });
          mediaBinding.getStore()?.();
          return dl ? fileResponse(dl) : notFound('pic not found');
        }
        case 'video': {
          // ?v=thumb → cover image (rkey is fine for covers); otherwise →
          // original mp4, completed via OIDB (rkey doesn't work for video
          // originals, so it's intentionally not attempted).
          if (wantThumb) {
            const { thumb } = await services.fileSearch.findFile(tMs, name, 'video');
            mediaBinding.getStore()?.();
            if (thumb) return fileResponse(thumb);
            const dl = await services.mediaDownload.download(token, {
              ext: '.jpg',
              rkeyTypes: VIDEO_RKEY_TYPES,
            });
            mediaBinding.getStore()?.();
            return dl ? fileResponse(dl) : notFound('video cover not found');
          }
          const { source } = await services.fileSearch.findFile(tMs, name, 'video');
          mediaBinding.getStore()?.();
          if (source) return fileResponse(source);

          // Missing on disk → OIDB completion (needs an online QQ). Cache the
          // result by fileToken so a replay doesn't re-download.
          const boot = getAppContext().bootstrap;
          if (!boot || !token) return notFound('video not found');
          const cacheDir = join(boot.userConfig.cacheDir('media'), 'video');
          const cachePath = oidbCachePath(cacheDir, token, '.mp4');
          if (existsSync(cachePath)) return fileResponse(cachePath);

          const msgId = q.get('msgId') ?? '';
          const conv = q.get('conv') ?? '';
          const fwdMsgId = q.get('fwdMsgId') ?? '';
          const fwdKind = q.get('fwdKind') === 'group' ? 'group' : 'c2c';
          const found = await findMediaElement(msgId, 'video', token, fwdMsgId, fwdKind);
          if (!found) return notFound('video element not found');
          const groupId = Number(conv) || 0;
          let url: string;
          try {
            url =
              found.conv === null
                ? await services.mediaUrl.resolveVideoUrlUnknownScene(groupId, found.element)
                : await services.mediaUrl.resolveVideoUrl(found.conv, groupId, found.element);
          } catch (e) {
            console.error('[media] video OIDB resolve failed:', e);
            return notFound('video OIDB resolve failed');
          }
          if (!url) return notFound('video OIDB returned empty url');
          mediaBinding.getStore()?.();
          const outcome = await downloadUrlToFile(url, cachePath);
          return outcome.ok
            ? fileResponse(cachePath)
            : notFound(`video download failed: ${outcome.reason}`);
        }
        case 'ptt': {
          const { source } = await services.fileSearch.findFile(tMs, name, 'ptt');
          mediaBinding.getStore()?.();
          let silk = source;
          if (!silk) {
            // Missing on disk → try rkey first, then OIDB completion. The OIDB
            // fallback matters most for missing-history roam messages (no local
            // Ptt file at all); it needs an online QQ.
            silk = await services.mediaDownload.download(token, {
              ext: '.silk',
              rkeyTypes: PTT_RKEY_TYPES,
            });
            mediaBinding.getStore()?.();
          }
          if (!silk) {
            const boot = getAppContext().bootstrap;
            if (boot && token) {
              const cacheDir = join(boot.userConfig.cacheDir('media'), 'ptt');
              const cachePath = oidbCachePath(cacheDir, token, '.silk');
              if (existsSync(cachePath)) {
                silk = cachePath;
              } else {
                const msgId = q.get('msgId') ?? '';
                const conv = q.get('conv') ?? '';
                const fwdMsgId = q.get('fwdMsgId') ?? '';
                const fwdKind = q.get('fwdKind') === 'group' ? 'group' : 'c2c';
                const found = await findMediaElement(msgId, 'ptt', token, fwdMsgId, fwdKind);
                if (found) {
                  const groupId = Number(conv) || 0;
                  let url: string | undefined;
                  try {
                    url =
                      found.conv === null
                        ? await services.mediaUrl.resolvePttUrlUnknownScene(groupId, found.element)
                        : await services.mediaUrl.resolvePttUrl(found.conv, groupId, found.element);
                  } catch (e) {
                    console.error('[media] ptt OIDB resolve failed:', e);
                  }
                  if (url) {
                    mediaBinding.getStore()?.();
                    const outcome = await downloadUrlToFile(url, cachePath);
                    if (outcome.ok) silk = cachePath;
                  }
                }
              }
            }
          }
          if (!silk) return notFound('ptt not found');
          const wav = await decodeSilkToWav(silk);
          return wav ? fileResponse(wav) : notFound('ptt decode failed');
        }
        case 'mface': {
          const pack = q.get('pack') ?? '';
          const hash = q.get('hash') ?? '';
          if (!pack || !hash) return notFound('mface needs pack+hash');
          // enc=tea → 商城表情包浏览器：下载 CDN 加密流，用 packId 恢复的 QQTEA
          // 密钥（或前端手动输入时间戳派生的 key）解密成 GIF。解密失败时回退到
          // 明文 CDN（raw GIF / PNG）与本地缓存路径，保证贴纸仍可显示。
          if (q.get('enc') === 'tea') {
            const key = q.get('key') ?? '';
            let path = await services.emoji.getMarketPackImage(pack, hash, key || undefined);
            if (!path) path = await services.emoji.getMarketFace(pack, hash);
            return path ? fileResponse(path) : notFound('mface not found');
          }
          const path = await services.emoji.getMarketFace(pack, hash);
          return path ? fileResponse(path) : notFound('mface not found');
        }
        case 'sticker': {
          // AgentLab 克隆体的自定义表情包（蒸馏期缓存到 agentlab/stickers/<md5>.png）。
          const persona = q.get('persona') ?? '';
          const md5 = q.get('md5') ?? '';
          if (!persona || !md5) return notFound('sticker needs persona+md5');
          const path = services.agentLab.getStickerPath(persona, md5);
          return path ? fileResponse(path) : notFound('sticker not found');
        }
        case 'agentvoice': {
          // AgentLab 克隆体合成的语音（agentlab/agentvoice/<hash>.<ext>）。
          const id = q.get('id') ?? '';
          if (!id) return notFound('agentvoice needs id');
          const path = services.agentLab.getAgentVoicePath(id);
          return path ? fileResponse(path) : notFound('agentvoice not found');
        }
        case 'avatar': {
          // Local avatar cache (nt_data/avatar/{user,group,cover}). Three ways in:
          //   hash=<hash>    — an explicit file (本地资源 → 头像 browser)
          //   uid=<peer uid> — compute the file hash from the uid formula
          //   uin=<peer qq>  — same, translating uin→uid (group uin == uid)
          // `v=big|small` picks the resolution (the other is tried as backup).
          // `fb=<enc cdn url>` is the guaranteed fallback: on a local miss we
          // serve (and disk-cache) the CDN avatar, so the renderer needs only one
          // <img src> and its onError is the final glyph net.
          const scope = q.get('scope') ?? '';
          const hash = q.get('hash') ?? '';
          const uid = q.get('uid') ?? '';
          const uin = q.get('uin') ?? '';
          const variant = q.get('v') === 'small' ? 'small' : 'big';
          const fb = q.get('fb') ?? '';
          if (scope !== 'user' && scope !== 'group' && scope !== 'cover') {
            return notFound('avatar needs scope=user|group|cover');
          }
          // 三个来源（QQ 的 b_/s_、WeQ 的 CDN 磁盘缓存、CDN 本身）里取最新的一版：
          // 换头像后 QQ 往往只刷新缩略图，`b_` 会停在几个月前 —— 照旧无条件优先大图
          // 会永远显示旧头像（见 AvatarResourceService.resolveByUidFile 的实测）。
          //
          // 显式刷新（用户刚换过头像）跳过本地判定，强制回源；失败了再往下走本地兜底。
          const refresh = q.get('_weq_avatar_remote') === '1';
          if (fb && refresh) {
            const fresh = await avatarFallbackResponse(fb, true);
            if (fresh.ok) return fresh;
          }
          let local: AvatarLocalFile | null = null;
          if (hash) {
            // 本地资源浏览器按 hash 直取，没有「哪个更新」的语义。
            const path = await services.avatarResource.resolveFile(scope, hash, variant);
            local = path ? { path, variant, stale: false, mtimeMs: 0 } : null;
          } else if (uid) {
            local = await services.avatarResource.resolveByUidFile(scope, uid, variant);
          } else if (uin) {
            local = await services.avatarResource.resolveByUinFile(scope, uin, variant);
          }
          // WeQ 磁盘缓存比本地文件新 ⇒ 上次回源时 CDN 上已经是更新的头像了。
          // 本地没有文件时不必 stat 缓存 —— 直接回源即可。
          const cachedAt =
            local && fb
              ? await getAppContext()
                  .bootstrap?.avatarCache.cachedAt(fb, 'avatar')
                  .catch(() => null)
              : null;
          if (local && !local.stale && (cachedAt == null || cachedAt <= local.mtimeMs))
            return revalidatingFileResponse(local.path);

          // 本地大图过期（只有缩略图是新的）或本地干脆没有 → 回源 CDN：它既比旧大图
          // 新，又比缩略图清晰。缓存比本地文件旧时强制重拉，否则直接用缓存字节。
          if (fb) {
            const fresh = await avatarFallbackResponse(
              fb,
              local ? { notOlderThanMs: local.mtimeMs } : false,
            );
            if (fresh.ok) return fresh;
          }
          // CDN 拿不到（离线 / 无网）→ 至少显示当前头像的缩略图，别退回旧大图。
          if (local) return revalidatingFileResponse(local.path);
          return notFound('avatar not found');
        }
        case 'cemoji': {
          // Custom-emoji cache (nt_data/Emoji/emoji-recv/<month> + personal_emoji).
          // scope+bucket+v pick the Ori/Thumb sub-dir; `file` is the exact on-disk
          // name (extension / `_size` suffix vary), and bytes stream off disk.
          const scope = q.get('scope') ?? '';
          const bucket = q.get('bucket') ?? '';
          const file = q.get('file') ?? '';
          const variant = q.get('v') === 'ori' ? 'ori' : 'thumb';
          if (scope !== 'recv' && scope !== 'personal') {
            return notFound('cemoji needs scope=recv|personal');
          }
          if (!file) return notFound('cemoji needs file');
          const path = await services.customEmoji.resolveFile(scope, bucket, variant, file);
          return path ? fileResponse(path) : notFound('cemoji not found');
        }
        case 'relemoji': {
          // Related-emoji cache (nt_data/Emoji/emoji-related/emoji/<md5>/<gif>).
          // hash is the keyword's md5 dir; `file` is one plaintext gif in it.
          const hash = q.get('hash') ?? '';
          const file = q.get('file') ?? '';
          if (!hash || !file) return notFound('relemoji needs hash+file');
          const path = await services.relatedEmoji.resolveFile(hash, file);
          return path ? fileResponse(path) : notFound('relemoji not found');
        }
        case 'localfile': {
          // Media preview for a trusted local file: either under the account's
          // nt_data tree (QQ 自己的媒体缓存) or a file the user just picked in one
          // of our dialogs. The service re-validates the path AND that it's a real
          // file, so a crafted `path` can't read arbitrary files. Bytes stream off
          // disk (Range is honored, so local videos play / seek).
          const path = q.get('path') ?? '';
          if (!path) return notFound('localfile needs path');
          const resolved = await services.fileResource.resolveLocalFile(path);
          return resolved ? fileResponse(resolved) : notFound('localfile not found');
        }
        case 'localfilevoice': {
          // 同上，但语音：选进来的可能是 SILK（浏览器放不了），解码成缓存 WAV 再回；
          // 已经是可播格式（wav/mp3/m4a…）时 decode 失败，原样按后缀 MIME 流出。
          const path = q.get('path') ?? '';
          if (!path) return notFound('localfilevoice needs path');
          const resolved = await services.fileResource.resolveLocalFile(path);
          if (!resolved) return notFound('localfilevoice not found');
          if (!isSilkFile(resolved)) return fileResponse(resolved);
          const wav = await decodeSilkToWav(resolved);
          return wav ? fileResponse(wav) : notFound('localfilevoice decode failed');
        }
        case 'localmedia': {
          // Local media caches (PhotoWall / Qzone / Pic / Video). `kind` picks the
          // tree; `rel` is the path relative to its root (bucket/name, or
          // month/Ori|Thumb/name). The service re-validates rel stays inside the
          // tree AND is a real file, so a crafted `rel` can't escape. Bytes (incl.
          // range requests for <video>) stream off disk.
          const mkind = q.get('kind') ?? '';
          const rel = q.get('rel') ?? '';
          if (!rel) return notFound('localmedia needs rel');
          const path = await services.mediaResource.resolveFile(mkind, rel);
          return path ? fileResponse(path) : notFound('localmedia not found');
        }
        case 'localvoice': {
          // Voice clip from the Ptt cache (本地资源 → 语音). `rel` is the path
          // relative to the Ptt root (`<month>/Ori/<name>`); the service
          // re-validates it stays inside the tree. The file is SILK, which no
          // browser plays, so it's decoded to a cached WAV before streaming.
          const rel = q.get('rel') ?? '';
          if (!rel) return notFound('localvoice needs rel');
          const silk = await services.mediaResource.resolveFile('ptt', rel);
          if (!silk) return notFound('localvoice not found');
          const wav = await decodeSilkToWav(silk);
          return wav ? fileResponse(wav) : notFound('localvoice decode failed');
        }
        case 'album': {
          return albumRemoteResponse(q.get('src') ?? '');
        }
        default:
          return notFound(`unknown media kind: ${kind}`);
      }
    } catch (e) {
      console.error(`[media] ${kind} failed:`, e);
      return new Response('media error', { status: 500 });
    }
  }
}
