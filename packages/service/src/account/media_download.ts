/**
 * MediaDownloadService — CDN fallback for chat media that isn't on disk.
 *
 * When `FileSearchService` can't find media locally, we fetch it from QQ's
 * multimedia CDN using the element's `fileToken` plus a live download rkey
 * harvested by {@link AccountMonitorService}:
 *
 *   https://multimedia.nt.qq.com.cn/download?appid=<appid>&fileid=<token>&spec=0<rkey>
 *
 * rkeys are scene- AND media-bound — a different rkey/appid pair per (chat
 * scene × media kind). We don't thread the chat scene down here, so for a given
 * media kind we try each non-expired rkey of the matching types (with its
 * appid) until one returns real bytes. The rkey value already carries its own
 * `&rkey=` prefix. Results are cached on disk keyed by a hash of the token.
 *
 * Currently only image download (pic / received emoji) is wired up; video and
 * ptt download are intentionally deferred.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountConfigService, DownloadRkey } from './user_config';
import { rkeyExpiryMs } from './user_config';

const MEDIA_HOST = 'https://multimedia.nt.qq.com.cn';
const DOWNLOAD_BASE = `${MEDIA_HOST}/download`;

/** rkey `type_` values, by (scene × media kind). */
export const PRIVATE_IMAGE_RKEY_TYPE = 10;
export const GROUP_IMAGE_RKEY_TYPE = 20;
export const PRIVATE_VIDEO_RKEY_TYPE = 12;
export const GROUP_VIDEO_RKEY_TYPE = 22;
export const PRIVATE_PTT_RKEY_TYPE = 14;
export const GROUP_PTT_RKEY_TYPE = 24;

/** rkey types usable to download images (pic / received animated emoji). */
const IMAGE_RKEY_TYPES = [PRIVATE_IMAGE_RKEY_TYPE, GROUP_IMAGE_RKEY_TYPE];

/** Group scenes use appid 1407; private (c2c) scenes use 1406. */
const GROUP_RKEY_TYPES = new Set([
  GROUP_IMAGE_RKEY_TYPE,
  GROUP_VIDEO_RKEY_TYPE,
  GROUP_PTT_RKEY_TYPE,
]);

export interface DownloadOptions {
  /** Extension for the cached file, e.g. `.jpg` / `.mp4` / `.silk`. */
  ext?: string;
  /** rkey types allowed for this download. Defaults to image types (10/20). */
  rkeyTypes?: number[];
  /**
   * CDN path/URL for the original media. When the `fileToken` is all digits the
   * media predates the rkey scheme — we fetch `<host><originalUrl>` directly
   * (no rkey) and prefer it over the rkey attempts.
   */
  originalUrl?: string;
}

export class MediaDownloadService {
  constructor(
    private readonly accountConfig: AccountConfigService,
    private readonly cacheDir: string,
  ) {}

  /**
   * Download `fileToken` to the cache and return its local path, or null if no
   * usable rkey is available or every attempt failed. Cached on success.
   */
  async download(fileToken: string, opts: DownloadOptions = {}): Promise<string | null> {
    if (!fileToken) return null;
    const cachePath = join(this.cacheDir, `${hashToken(fileToken)}${opts.ext ?? ''}`);
    if (existsSync(cachePath)) return cachePath;

    const urls: string[] = [];
    // Digit-only tokens are pre-rkey media: fetch the original directly, no rkey.
    if (opts.originalUrl && isAllDigits(fileToken)) {
      urls.push(resolveOriginalUrl(opts.originalUrl));
    }
    const allowed = opts.rkeyTypes ?? IMAGE_RKEY_TYPES;
    for (const rkey of this.validRkeys(allowed)) {
      urls.push(buildUrl(fileToken, rkey));
    }

    for (const url of urls) {
      const bytes = await tryFetch(url);
      if (bytes) {
        mkdirSync(this.cacheDir, { recursive: true });
        writeFileSync(cachePath, bytes);
        return cachePath;
      }
    }
    return null;
  }

  private validRkeys(allowedTypes: number[]): DownloadRkey[] {
    const rkeys = this.accountConfig.getRecord()?.rkeys ?? [];
    const now = Date.now();
    return rkeys.filter((r) => allowedTypes.includes(r.type) && rkeyExpiryMs(r) > now);
  }
}

function isAllDigits(s: string): boolean {
  return /^\d+$/.test(s);
}

/** `originalUrl` is usually a host-relative path; join it onto the media host. */
function resolveOriginalUrl(originalUrl: string): string {
  if (/^https?:\/\//i.test(originalUrl)) return originalUrl;
  return `${MEDIA_HOST}${originalUrl.startsWith('/') ? '' : '/'}${originalUrl}`;
}

function buildUrl(fileToken: string, rkey: DownloadRkey): string {
  const appid = GROUP_RKEY_TYPES.has(rkey.type) ? '1407' : '1406';
  // rkey.rkey already includes its "&rkey=" prefix as QQ returns it.
  return `${DOWNLOAD_BASE}?appid=${appid}&fileid=${encodeURIComponent(fileToken)}&spec=0${rkey.rkey}`;
}

async function tryFetch(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    // A wrong-scene / expired rkey tends to come back as an HTML/text error
    // page with a 200 — reject anything that isn't binary media.
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.startsWith('text/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

function hashToken(token: string): string {
  return createHash('sha1').update(token).digest('hex');
}
