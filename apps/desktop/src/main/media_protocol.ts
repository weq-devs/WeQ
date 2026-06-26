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
 *   weq-media://mface?pack=<emojiPackId>&hash=<previewMd5Hex> → sticker bytes
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
          const path = await services.emoji.getMarketFace(pack, hash);
          return path ? fileResponse(path) : notFound('mface not found');
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
