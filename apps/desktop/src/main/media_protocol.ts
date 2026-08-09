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
 *   weq-media://mface?pack=&hash=&enc=tea&key=<opt> → 商城表情包 CDN 加密流 QQTEA 解密后 GIF
 *   weq-media://agentvoice?persona=&id=<hash.ext>             → clone TTS audio bytes
 *   weq-media://avatar?scope=user&hash=<hash>&v=big|small     → local avatar-cache bytes
 *   weq-media://avatar?scope=user&uin=<qq>&fb=<cdnUrl>        → local by uid-hash, CDN fallback
 *   weq-media://avatar?scope=group&uid=<code>&fb=<cdnUrl>     → group avatar (uin==uid)
 *   weq-media://localfile?path=<absOriPath>                   → File/Ori file bytes (image preview)
 *   weq-media://localmedia?kind=pic&rel=<month/Ori/name>      → PhotoWall/Qzone/Pic/Video cache bytes
 *   weq-media://localvoice?rel=<month/Ori/name>               → decoded WAV for a Ptt cache clip
 *   weq-media://dress?src=<tianquanUrl>                       → 会员装扮资源(挂件/名片/浮屏/背景/气泡切片)
 *   weq-media://dressfont?id=<itemId>                         → 已安装的装扮字体 ttf
 *   weq-media://dressbubble?id=<itemId>                       → 走 protocol 装的气泡九宫格(本地 PNG)
 *   weq-media://dressbubble?id=<itemId>&frame=<n>              → 同上,整泡帧动画的第 n 帧(n 从 1 开始)
 *   weq-media://dresspendant?id=<itemId>&frame=<n>             → 走 protocol 换的头像挂件动画帧(本地 PNG,n 从 1 开始)
 *   weq-media://dressbg?v=<stamp>                             → 用户自选的聊天背景(本地图)
 *   weq-media://linkpreview?id=<hash.ext>                     → 链接卡片封面(已落盘、验过魔数)
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
  type MediaElement,
} from '@weq/service';
import { getAppContext } from './context/app_context';
import { decodeSilkToWav } from './voice';

/** rkey types accepted when downloading the video COVER (thumb only; the
 *  original mp4 now goes through OIDB). ptt still uses rkey end-to-end. */
const VIDEO_RKEY_TYPES = [PRIVATE_VIDEO_RKEY_TYPE, GROUP_VIDEO_RKEY_TYPE];
const PTT_RKEY_TYPES = [PRIVATE_PTT_RKEY_TYPE, GROUP_PTT_RKEY_TYPE];

/** Stable cache path for an OIDB-downloaded original by its fileToken. */
function oidbCachePath(cacheDir: string, token: string, ext: string): string {
  const hash = createHash('sha1').update(token).digest('hex');
  return join(cacheDir, `${hash}${ext}`);
}

/**
 * Find the video / file element a chat media URL refers to by re-reading its
 * raw message. Returns the element plus the conversation kind so callers can
 * branch group vs c2c. Matches by fileToken when a message carries several of
 * the same kind; else the first one of that kind.
 *
 * `fwdMsgId` marks a merged-forward sub-message: its snapshot lives only in the
 * carrying message's 40900 cache (never in our own msg tables), so `msgId` is
 * the CARRIER and `fwdMsgId` the sub-message. Those resolve to `conv: null` —
 * a forwarded medium's original scene is unknowable, so the caller must try
 * both. See MediaUrlService.resolveVideoUrlUnknownScene.
 */
async function findMediaElement(
  msgId: string,
  kind: 'video' | 'file',
  token: string,
  fwdMsgId = '',
  fwdKind: 'group' | 'c2c' = 'c2c',
): Promise<{ element: MediaElement; conv: 'group' | 'c2c' | null } | null> {
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
  if (!raw) return null;
  const matches = raw.elements.filter(
    (e) => e.kind === kind || (kind === 'video' && e.kind === 'bubbleVideo'),
  );
  const el =
    matches.find((e) => (e as { fileToken?: string }).fileToken === token) ?? matches[0];
  if (!el) return null;
  return { element: el as unknown as MediaElement, conv: raw.kind };
}

export const MEDIA_SCHEME = 'weq-media';

export const MEDIA_PRIVILEGED_SCHEME = {
  scheme: MEDIA_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
  },
} as const;

function notFound(reason: string): Response {
  return new Response(reason, { status: 404 });
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
 * CDN fallback for an avatar the local cache didn't have. Routes through the
 * shared {@link AvatarCacheService} disk cache (so the fetched bytes warm the
 * same cache the rest of the app reads), returning 404 on any failure so the
 * renderer shows its glyph.
 *
 * Short `max-age`: the disk cache is the real cache (and applies its own TTL),
 * so a long browser cache would only delay a changed avatar from showing.
 */
async function avatarFallbackResponse(src: string): Promise<Response> {
  if (!/^https?:\/\//i.test(src)) return notFound('avatar fallback needs http url');
  const cache = getAppContext().bootstrap?.avatarCache;
  if (!cache) return notFound('avatar cache unavailable');
  try {
    const blob = await cache.get(src);
    return new Response(new Uint8Array(blob.data), {
      status: 200,
      headers: { 'Content-Type': blob.contentType, 'Cache-Control': 'public, max-age=300' },
    });
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
    // 群相册视频走视频 CDN,和图片不同域。
    host.endsWith('.video.qq.com') ||
    host.endsWith('.gtimg.com') ||
    host.endsWith('.qzone.qq.com');
  if (!allowed) return notFound('album image host not allowed');
  // Referer 的协议必须跟目标一致：Chromium 禁止 https→http 的 referrer 降级,
  // 撞上就是 ERR_BLOCKED_BY_CLIENT(资料卡精选图片走的 ugc.qpic.cn 只有 http)。
  const res = await fetch(src, {
    headers: {
      Referer: `${target.protocol}//user.qzone.qq.com/`,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36',
    },
  });
  if (!res.ok) return new Response(`album image http ${res.status}`, { status: res.status });
  const contentType = res.headers.get('content-type') ?? '';
  // 视频原样回传：要保留 range 支持,且不能把整段 mp4 读进内存。
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
async function dressRemoteResponse(src: string): Promise<Response> {
  if (!/^https:\/\//i.test(src)) return notFound('dress asset needs https url');
  const host = new URL(src).hostname.toLowerCase();
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

  // 图片一律走头像那套磁盘缓存。注意聊天背景的 aioImage 没有扩展名、Content-Type 是
  // application/octet-stream,但内容就是 PNG,浏览器按魔数认,不影响渲染。
  const cache = getAppContext().bootstrap?.avatarCache;
  if (!cache) return notFound('dress cache unavailable');
  try {
    const blob = await cache.get(src);
    return new Response(new Uint8Array(blob.data), {
      status: 200,
      headers: { 'Content-Type': blob.contentType, 'Cache-Control': 'public, max-age=86400' },
    });
  } catch {
    return notFound('dress asset fetch failed');
  }
}

/**
 * Serve one `weq-media://` request. Pure `Request`→`Response`, so the web app
 * can mount it on a plain HTTP route (see `apps/web`) without Electron.
 */
export function handleMediaRequest(request: Request): Promise<Response> {
  return currentRequest.run(request, async () => {
    const url = new URL(request.url);
    const kind = url.hostname;
    const q = url.searchParams;

    // 装扮资源只依赖 bootstrap 的缓存,不需要打开的账号 —— 放在 services 断言之前。
    if (kind === 'dress') {
      try {
        return await dressRemoteResponse(q.get('src') ?? '');
      } catch (e) {
        console.error('[media] dress failed:', e);
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

    const services = getAppContext().services;
    if (!services) return notFound('no account session');

    // 装扮字体:清单里记的 ttf 绝对路径。放在这里(而不是 weq-asset)是因为
    // weq-asset 只服务仓库的 resources/ 树,读不了账号缓存目录。
    if (kind === 'dressfont') {
      const id = Number(q.get('id') ?? '0');
      const path = id ? services.dressInstall.fontFile(id) : null;
      return path ? fileResponse(path) : notFound('dress font not installed');
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
    // 见 dress_install.ts 的 resolvePendantAnimation/pendantFrameFile。没有「不带
    // frame 取静态图」这一档 —— 挂件不设中间的静态兜底(见该方法头注释)。
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
          const path = wantThumb ? (thumb ?? source) : (source ?? thumb);
          if (path) return fileResponse(path);
          // Missing on disk → CDN: digit token → originalUrl (no rkey); else rkey.
          const dl = await services.mediaDownload.download(token, {
            originalUrl: q.get('orig') ?? '',
          });
          return dl ? fileResponse(dl) : notFound('pic not found');
        }
        case 'video': {
          // ?v=thumb → cover image (rkey is fine for covers); otherwise →
          // original mp4, completed via OIDB (rkey doesn't work for video
          // originals, so it's intentionally not attempted).
          if (wantThumb) {
            const { thumb } = await services.fileSearch.findFile(tMs, name, 'video');
            if (thumb) return fileResponse(thumb);
            const dl = await services.mediaDownload.download(token, {
              ext: '.jpg',
              rkeyTypes: VIDEO_RKEY_TYPES,
            });
            return dl ? fileResponse(dl) : notFound('video cover not found');
          }
          const { source } = await services.fileSearch.findFile(tMs, name, 'video');
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
          const outcome = await downloadUrlToFile(url, cachePath);
          return outcome.ok ? fileResponse(cachePath) : notFound(`video download failed: ${outcome.reason}`);
        }
        case 'ptt': {
          const { source } = await services.fileSearch.findFile(tMs, name, 'ptt');
          let silk = source;
          if (!silk) {
            // Missing on disk → download the silk, then decode as usual.
            silk = await services.mediaDownload.download(token, {
              ext: '.silk',
              rkeyTypes: PTT_RKEY_TYPES,
            });
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
          // 密钥（或前端手动输入时间戳派生的 key）解密成 GIF。否则走聊天里那条
          // 明文 CDN / 本地缓存路径（不解密）。
          if (q.get('enc') === 'tea') {
            const key = q.get('key') ?? '';
            const path = await services.emoji.getMarketPackImage(pack, hash, key || undefined);
            return path ? fileResponse(path) : notFound('mface (tea) not found');
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
          let path: string | null = null;
          if (hash) path = await services.avatarResource.resolveFile(scope, hash, variant);
          else if (uid) path = await services.avatarResource.resolveByUid(scope, uid, variant);
          else if (uin) path = await services.avatarResource.resolveByUin(scope, uin, variant);
          if (path) return revalidatingFileResponse(path);
          // Local miss → CDN fallback (disk-cached by AvatarCacheService).
          if (fb) return avatarFallbackResponse(fb);
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
          // Image preview for a file living under nt_data/File/Ori. The service
          // re-validates the path is inside the Ori tree AND is a real file, so a
          // crafted `path` can't read outside the File dir. Bytes stream off disk.
          const path = q.get('path') ?? '';
          if (!path) return notFound('localfile needs path');
          const resolved = await services.fileResource.resolveLocalFile(path);
          return resolved ? fileResponse(resolved) : notFound('localfile not found');
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
  });
}
