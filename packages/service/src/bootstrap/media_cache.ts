/**
 * MediaCacheService — disk cache for remote media (avatars, dress assets, etc).
 *
 * Provides a single interface for caching any HTTP(S) resource with per-type
 * subdirectory organization and configurable TTL.
 *
 * Flow:
 *   1. hash the URL → stable filename under `<cacheBase>/<subdir>/<hash>`
 *   2. serve cached bytes if present and not past TTL
 *   3. otherwise fetch upstream once, persist, and return the bytes
 *
 * Concurrent requests for the same URL share a single in-flight fetch.
 *
 * The transport (custom protocols) lives in the desktop app; this service is
 * transport-agnostic and just deals in URLs → bytes.
 */

import { createHash } from 'node:crypto';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UserConfigService } from './user_config';

/** Cache subdirectory for organizing different media types. */
export type CacheSubdir = 'avatar' | 'dress' | 'collection' | 'linkpreview';

/** Bytes + content type for one resolved media resource. */
export interface MediaBlob {
  data: Buffer;
  contentType: string;
  /** Whether the bytes came off disk (true) or a fresh upstream fetch (false). */
  fromCache: boolean;
}

/** Backward compatibility alias. */
export type AvatarBlob = MediaBlob;

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

/**
 * How long a cached resource stays fresh.
 *
 * Default TTL (7 days): QQ's avatar URLs carry no version, so the sha1(url) key
 * can never invalidate itself — without an expiry a changed avatar would show
 * the old bytes forever. Seven days trades a weekly re-fetch for bounded staleness.
 *
 * Dress assets (30 days): more stable than avatars, longer TTL reduces refetches.
 *
 * The LOCAL `nt_data/avatar` path (see AvatarResourceService) deliberately has
 * no TTL: its filename is derived from the uid, so QQ overwrites the same file
 * in place and our next read already sees the new bytes.
 */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DRESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function ttlForSubdir(subdir: CacheSubdir): number {
  return subdir === 'dress' ? DRESS_TTL_MS : DEFAULT_TTL_MS;
}

export class MediaCacheService {
  /** De-dupe concurrent fetches of the same upstream URL. */
  private readonly inFlight = new Map<string, Promise<MediaBlob>>();

  constructor(private readonly userConfig: UserConfigService) {}

  /**
   * Cache directory for a specific media type.
   *
   * Shared `<cacheBase>/<subdir>` that the 清理缓存 UI enumerates and wipes
   * (`UserConfigService.clearCache`). It MUST be derived from `cacheBaseDir()`
   * so a user-set cache-dir override moves both writes and cleanup.
   */
  cacheDir(subdir: CacheSubdir = 'avatar'): string {
    return this.userConfig.cacheDir(subdir);
  }

  /**
   * Resolve one upstream URL to bytes, going through the disk cache.
   *
   * @param url - HTTP(S) URL to fetch
   * @param subdir - Cache subdirectory (default: 'avatar')
   * @param ttl - Time-to-live in ms (default: auto per subdir)
   *
   * Throws on a non-http URL or an upstream failure (the caller turns that
   * into a 4xx/5xx so the renderer falls back to its default glyph).
   */
  async get(url: string, subdir: CacheSubdir = 'avatar', ttl?: number): Promise<MediaBlob> {
    if (!isHttpUrl(url)) {
      throw new Error(`refusing to cache non-http url: ${url}`);
    }

    const effectiveTtl = ttl ?? ttlForSubdir(subdir);
    const hit = await this.readFromDisk(url, subdir, effectiveTtl);
    if (hit) return hit;

    // Collapse concurrent misses onto a single fetch.
    const cacheKey = `${subdir}:${url}`;
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const promise = this.fetchAndStore(url, subdir).finally(() => {
      this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  /** `<cacheDir(subdir)>/<sha1(url)>` (no extension — we glob on read). */
  private basePath(url: string, subdir: CacheSubdir): string {
    const hash = createHash('sha1').update(url).digest('hex');
    return join(this.cacheDir(subdir), hash);
  }

  /**
   * Return cached bytes for `url` if any extension variant exists on disk and
   * is still within TTL. Async (non-blocking) so dozens of concurrent requests
   * interleave on the event loop. An expired file is deleted so the refetch
   * below writes a clean entry.
   */
  private async readFromDisk(url: string, subdir: CacheSubdir, ttl: number): Promise<MediaBlob | null> {
    const base = this.basePath(url, subdir);
    for (const ext of ['png', 'jpg', 'gif', 'webp']) {
      const path = `${base}.${ext}`;
      try {
        const st = await stat(path);
        if (Date.now() - st.mtimeMs > ttl) {
          await unlink(path).catch(() => {});
          continue;
        }
        const data = await readFile(path);
        return { data, contentType: contentTypeForExt(ext), fromCache: true };
      } catch {
        // Missing (ENOENT) or unreadable — try the next extension.
      }
    }
    return null;
  }

  private async fetchAndStore(url: string, subdir: CacheSubdir): Promise<MediaBlob> {
    const res = await fetch(url, {
      headers: { Referer: '', 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) {
      throw new Error(`media upstream ${res.status} for ${url}`);
    }
    const contentType = res.headers.get('content-type');
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length === 0) {
      throw new Error(`media upstream returned empty body for ${url}`);
    }

    const ext = extFor(contentType, url);
    try {
      await writeFile(`${this.basePath(url, subdir)}.${ext}`, data);
    } catch {
      // A cache-write failure shouldn't fail the request — serve the bytes we
      // already fetched; the next request just re-fetches.
    }

    return { data, contentType: contentTypeForExt(ext), fromCache: false };
  }
}

/** Backward compatibility type alias. */
export type AvatarCacheService = MediaCacheService;
