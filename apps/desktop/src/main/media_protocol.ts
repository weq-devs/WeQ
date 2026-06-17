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
import { getAppContext } from './context/app_context';
import { decodeSilkToWav } from './voice';

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

    try {
      switch (kind) {
        case 'pic': {
          // pic subType 1 = received animated emoji: lives under Emoji/emoji-recv
          // with no "original"; the displayable image comes back as `thumb`.
          const picType = q.get('recv') === '1' ? 'emoji' : 'pic';
          const { source, thumb } = await services.fileSearch.findFile(tMs, name, picType);
          const path = wantThumb ? (thumb ?? source) : (source ?? thumb);
          return path ? fileResponse(path) : notFound('pic not found');
        }
        case 'video': {
          // Only the cover is served inline; the mp4 opens externally on click.
          const { thumb } = await services.fileSearch.findFile(tMs, name, 'video');
          return thumb ? fileResponse(thumb) : notFound('video cover not found');
        }
        case 'ptt': {
          const { source } = await services.fileSearch.findFile(tMs, name, 'ptt');
          if (!source) return notFound('ptt not found');
          const wav = await decodeSilkToWav(source);
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
