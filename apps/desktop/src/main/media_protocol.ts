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
import {
  PRIVATE_VIDEO_RKEY_TYPE,
  GROUP_VIDEO_RKEY_TYPE,
  PRIVATE_PTT_RKEY_TYPE,
  GROUP_PTT_RKEY_TYPE,
} from '@weq/service';
import { getAppContext } from './context/app_context';
import { decodeSilkToWav } from './voice';

/** rkey types accepted when downloading each media kind (private + group). */
const VIDEO_RKEY_TYPES = [PRIVATE_VIDEO_RKEY_TYPE, GROUP_VIDEO_RKEY_TYPE];
const PTT_RKEY_TYPES = [PRIVATE_PTT_RKEY_TYPE, GROUP_PTT_RKEY_TYPE];

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
          // ?v=thumb → cover image; otherwise → original mp4 (downloaded on click).
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
          const dl = await services.mediaDownload.download(token, {
            ext: '.mp4',
            rkeyTypes: VIDEO_RKEY_TYPES,
          });
          return dl ? fileResponse(dl) : notFound('video not found');
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
        default:
          return notFound(`unknown media kind: ${kind}`);
      }
    } catch (e) {
      console.error(`[media] ${kind} failed:`, e);
      return new Response('media error', { status: 500 });
    }
  });
}
