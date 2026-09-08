/**
 * OIDB 0x9067_202 — fetch rich-media download `rkey`s for private images
 * (type 10), group images (type 20) and the fallback entry (type 2).
 *
 * Reuses the shared NTV2 request schema (`NTV2_RICH_MEDIA_REQ`) that already
 * backs the video/ptt download commands, so the rich-media header layout has
 * exactly one TS definition. Ported from nt_helper
 * `src/protocol/service/fetch_rkeys.rs`; uses `isUid=true` like the native
 * implementation did.
 */

import { message } from '../protobuf';
import { NTV2_RICH_MEDIA_REQ } from './media-schemas';
import { toInt } from './shared';
import { invokeOidb, type OidbSpec } from './invoke';
import type { OidbNative } from '../transport';

const DOWNLOAD_RKEY_ENTRY = message([
  { name: 'rkey', tag: 1, type: 'string' },
  { name: 'rkeyTtlSec', tag: 2, type: 'uint64' },
  { name: 'storeId', tag: 3, type: 'uint32' },
  { name: 'rkeyCreateTime', tag: 4, type: 'uint32' },
  { name: 'type', tag: 5, type: 'uint32' },
]);

const DOWNLOAD_RKEY_RESP = message([
  { name: 'rkeys', tag: 1, type: DOWNLOAD_RKEY_ENTRY, repeated: true },
]);

const NTV2_RKEY_RESP = message([{ name: 'downloadRkey', tag: 4, type: DOWNLOAD_RKEY_RESP }]);

export interface DownloadRkey {
  /** URL fragment as returned by QQ, e.g. `&rkey=CAQS…`. */
  rkey: string;
  /** Media type: 10 = private image, 20 = group image, 2 = fallback. */
  type: number;
  /** Server TTL in seconds. */
  ttlSeconds: number;
  /** Unix seconds the rkey was issued. Expiry = createTime + ttlSeconds. */
  createTime: number;
}

export namespace FetchDownloadRkeys {
  export const command = 0x9067;
  export const subCommand = 202;
  export const uinForm = true;
  export const reqSchema = NTV2_RICH_MEDIA_REQ;
  export const respSchema = NTV2_RKEY_RESP;

  export interface Params {
    /** Requested rkey types; defaults to private/group/fallback image rkeys. */
    types?: number[];
  }

  export const serialize = (p: Params): Record<string, unknown> => ({
    reqHead: {
      common: { requestId: 1, command: 202 },
      scene: { requestType: 2, businessType: 1, sceneType: 0 },
      client: { agentType: 2 },
    },
    downloadRkey: { types: p.types ?? [10, 20, 2] },
  });

  export const deserialize = (body: Record<string, unknown>): DownloadRkey[] => {
    const downloadRkey = body.downloadRkey as Record<string, unknown> | undefined;
    const out: DownloadRkey[] = [];
    for (const raw of (downloadRkey?.rkeys as Record<string, unknown>[] | undefined) ?? []) {
      const rkey = typeof raw.rkey === 'string' ? raw.rkey : '';
      if (!rkey) continue;
      out.push({
        rkey,
        type: toInt(raw.type),
        ttlSeconds: toInt(raw.rkeyTtlSec),
        createTime: toInt(raw.rkeyCreateTime),
      });
    }
    return out;
  };

  export const invoke = (nt: OidbNative, pid: number): Promise<DownloadRkey[]> =>
    invokeOidb(nt, pid, FetchDownloadRkeys as OidbSpec<Params, DownloadRkey[]>, {});
}
