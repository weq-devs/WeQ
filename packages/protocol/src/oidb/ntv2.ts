/**
 * Shared NTV2 rich-media helpers — the four voice/video URL fetchers
 * (group/private × ptt/video) build the same request shape and parse the same
 * response triple (`domain + urlPath + rKeyParam` → composed https URL).
 */

import { normalizeMediaNode, type MediaIndexNode } from './media-schemas';
import { ensureRetCodeZero } from './shared';

/** Build an `NTV2RichMediaReq` object for a download. `scene` carries the
 *  request/business/scene type + the group/c2c discriminator. */
export function buildNtv2DownloadReq(
  requestId: number,
  scene: Record<string, unknown>,
  node: MediaIndexNode,
): Record<string, unknown> {
  const videoExt = node.videoExt;
  return {
    reqHead: {
      common: { requestId, command: 200 },
      scene,
      client: { agentType: 2 },
    },
    download: {
      node: normalizeMediaNode(node, !!videoExt),
      download: {
        video: videoExt
          ? {
              busiType: 0,
              subBusiType: 0,
              field5: 0,
              videoMeta: {
                businessType: 100,
                channelParams: videoExt.channelParams ?? '',
                videoFlag45421: videoExt.videoFlag45421 ?? '',
                videoFlag45863: videoExt.videoFlag45863 ?? 0,
              },
            }
          : {},
        ...(videoExt ? { extra: { field1: 0 } } : {}),
      },
      ...(videoExt ? { field3: 0 } : {}),
    },
  };
}

/** Compose the final download URL from a decoded `NTV2RichMediaResp`. */
export function parseNtv2DownloadUrl(body: Record<string, unknown>): string {
  const respHead = (body.respHead ?? {}) as Record<string, unknown>;
  ensureRetCodeZero('ntv2 download', respHead.retCode, respHead.message);

  const download = (body.download ?? {}) as Record<string, unknown>;
  const info = (download.info ?? {}) as Record<string, unknown>;
  const domain = typeof info.domain === 'string' ? info.domain : '';
  const path = typeof info.urlPath === 'string' ? info.urlPath : '';
  const rKeyParam = typeof download.rKeyParam === 'string' ? download.rKeyParam : '';
  if (!domain || !path) throw new Error('ntv2 download response invalid');
  return `https://${domain}${path}${rKeyParam}`;
}
