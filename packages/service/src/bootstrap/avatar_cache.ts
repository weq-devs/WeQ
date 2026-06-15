/**
 * AvatarCacheService — single funnel for every avatar the renderer shows.
 *
 * The QQ avatar CDN (`thirdqq.qlogo.cn` / `p.qlogo.cn`) is slow and re-hit on
 * every render/account-switch, which makes the UI feel janky. This service
 * puts a disk cache in front of it: the renderer asks for one upstream URL,
 * we
 *
 *   1. hash the URL → a stable filename under the cache dir,
 *   2. serve the cached bytes if present,
 *   3. otherwise fetch upstream once, persist, and return the bytes.
 *
 * Concurrent requests for the same URL share a single in-flight fetch (so a
 * screen that mounts 50 identical avatars hits the network once).
 *
 * Cache directory resolution (override wins, default never hard-coded here):
 *   `UserConfig.avatarCacheDir`  →  `platform.avatarCacheDir()`
 *
 * The transport (a custom protocol) lives in the desktop app; this service is
 * transport-agnostic and just deals in URLs → bytes.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Platform } from '@weq/platform';
import type { UserConfigService } from './user_config';

/** Bytes + content type for one resolved avatar. */
export interface AvatarBlob {
  data: Buffer;
  contentType: string;
  /** Whether the bytes came off disk (true) or a fresh upstream fetch (false). */
  fromCache: boolean;
}

/** Only http(s) avatars are cacheable; anything else is rejected up front. */
function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Map a Content-Type / URL to the file extension we persist under. */
function extFor(contentType: string | null, url: string): string {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('png')) return 'png';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  // Fall back to the URL's extension, else jpg (QQ serves JPEG by default).
  const m = url.split('?')[0]?.match(/\.(png|gif|webp|jpe?g)$/i);
  return m ? m[1]!.toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}

/** Guess a content type from a cached file's extension. */
function contentTypeForExt(ext: string): string {
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/jpeg';
  }
}

export class AvatarCacheService {
  /** De-dupe concurrent fetches of the same upstream URL. */
  private readonly inFlight = new Map<string, Promise<AvatarBlob>>();

  constructor(
    private readonly platform: Platform,
    private readonly userConfig: UserConfigService,
  ) {}

  /** Effective cache directory: config override, else the platform default. */
  cacheDir(): string {
    const override = this.userConfig.read().avatarCacheDir;
    return override && override.trim() ? override : this.platform.avatarCacheDir();
  }

  /**
   * Resolve one upstream avatar URL to bytes, going through the disk cache.
   * Throws on a non-http URL or an upstream failure (the caller turns that
   * into a 4xx/5xx so the renderer falls back to its default glyph).
   */
  async get(url: string): Promise<AvatarBlob> {
    if (!isHttpUrl(url)) {
      throw new Error(`refusing to cache non-http avatar url: ${url}`);
    }

    const hit = this.readFromDisk(url);
    if (hit) return hit;

    // Collapse concurrent misses onto a single fetch.
    const existing = this.inFlight.get(url);
    if (existing) return existing;

    const promise = this.fetchAndStore(url).finally(() => {
      this.inFlight.delete(url);
    });
    this.inFlight.set(url, promise);
    return promise;
  }

  /** `<cacheDir>/<sha1(url)>` (no extension — we glob the real one on read). */
  private basePath(url: string): string {
    const hash = createHash('sha1').update(url).digest('hex');
    return join(this.cacheDir(), hash);
  }

  /** Return cached bytes for `url` if any extension variant exists on disk. */
  private readFromDisk(url: string): AvatarBlob | null {
    const base = this.basePath(url);
    for (const ext of ['png', 'jpg', 'gif', 'webp']) {
      const path = `${base}.${ext}`;
      if (!existsSync(path)) continue;
      try {
        return {
          data: readFileSync(path),
          contentType: contentTypeForExt(ext),
          fromCache: true,
        };
      } catch {
        // Unreadable (mid-write race / corruption) — fall through to refetch.
        return null;
      }
    }
    return null;
  }

  private async fetchAndStore(url: string): Promise<AvatarBlob> {
    const res = await fetch(url, {
      headers: { Referer: '', 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) {
      throw new Error(`avatar upstream ${res.status} for ${url}`);
    }
    const contentType = res.headers.get('content-type');
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length === 0) {
      throw new Error(`avatar upstream returned empty body for ${url}`);
    }

    const ext = extFor(contentType, url);
    const dir = this.cacheDir();
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(`${this.basePath(url)}.${ext}`, data);
    } catch {
      // A cache-write failure shouldn't fail the request — serve the bytes we
      // already fetched; the next request just re-fetches.
    }

    return { data, contentType: contentTypeForExt(ext), fromCache: false };
  }
}
