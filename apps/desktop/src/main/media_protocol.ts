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
 *
 * Like the other custom schemes: `registerMediaScheme()` runs before app
 * `ready`; `registerMediaProtocol()` runs after.
 */

import { net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
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
 */
async function findMediaElement(
  msgId: string,
  kind: 'video' | 'file',
  token: string,
): Promise<{ element: MediaElement; conv: 'group' | 'c2c' } | null> {
  const services = getAppContext().services;
  if (!services || !msgId) return null;
  let raw: Awaited<ReturnType<typeof services.msgs.getRawElements>>;
  try {
    raw = await services.msgs.getRawElements(BigInt(msgId));
  } catch {
    return null;
  }
  if (!raw) return null;
  const matches = raw.elements.filter((e) => e.kind === kind);
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

function fileResponse(path: string): Promise<Response> {
  return net.fetch(pathToFileURL(path).toString());
}

/**
 * CDN fallback for an avatar the local cache didn't have. Routes through the
 * shared {@link AvatarCacheService} disk cache (so the fetched bytes warm the
 * same cache the rest of the app reads), returning 404 on any failure so the
 * renderer shows its glyph.
 */
async function avatarFallbackResponse(src: string): Promise<Response> {
  if (!/^https?:\/\//i.test(src)) return notFound('avatar fallback needs http url');
  const cache = getAppContext().bootstrap?.avatarCache;
  if (!cache) return notFound('avatar cache unavailable');
  try {
    const blob = await cache.get(src);
    return new Response(new Uint8Array(blob.data), {
      status: 200,
      headers: { 'Content-Type': blob.contentType, 'Cache-Control': 'public, max-age=86400' },
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
    host.endsWith('.photo.store.qq.com');
  if (!allowed) return notFound('album image host not allowed');
  const res = await net.fetch(src, {
    headers: {
      Referer: 'https://user.qzone.qq.com/',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36',
    },
  });
  if (!res.ok) return new Response(`album image http ${res.status}`, { status: res.status });
  return res;
}

export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    const kind = url.hostname;
    const q = url.searchParams;

    const services = getAppContext().services;
    if (!services) return notFound('no account session');

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
          const found = await findMediaElement(msgId, 'video', token);
          if (!found) return notFound('video element not found');
          let url: string;
          try {
            url = await services.mediaUrl.resolveVideoUrl(found.conv, Number(conv) || 0, found.element);
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
          if (path) return fileResponse(path);
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
