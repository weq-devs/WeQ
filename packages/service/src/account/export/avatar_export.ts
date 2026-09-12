/**
 * Avatar export — given the set of sender uins seen while exporting a
 * conversation, write each sender's avatar into an `avatars/` directory next to
 * the message file.
 *
 * Resolution goes through {@link AvatarCacheService.get}, which already does the
 * exact thing we want: serve the bytes from the on-disk avatar cache if present,
 * otherwise fetch them from the QQ CDN once and persist. So "prefer local cache,
 * fall back to CDN to fill the gaps" comes for free — and a CDN miss also warms
 * the shared cache for the renderer.
 *
 * Avatars are addressed by uin (never by a profile's possibly-expired signed
 * url), per the project convention.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AvatarCacheService } from '../../bootstrap/media_cache';

export interface AvatarExportResult {
  /** Distinct senders we attempted. */
  total: number;
  /** Avatars written to disk. */
  ok: number;
  /** Senders whose avatar could not be resolved. */
  failed: number;
}

/** Per-uin public avatar CDN url (same construction the renderer uses). */
function avatarUrlForUin(uin: string): string {
  return `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${uin}`;
}

/** Map a resolved content type to the file extension we persist under. */
function extForContentType(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes('png')) return 'png';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('webp')) return 'webp';
  return 'jpg';
}

/** Run `worker` over `items` with at most `concurrency` in flight. */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function run(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

/** One avatar to write for a guild (频道私聊) conversation: sender id + public URL. */
export interface GuildAvatarTarget {
  /** File stem — the guild tinyId (matches structured-export member platformId). */
  id: string;
  /** Public avatar URL (avatar_meta-derived for the peer, qlogo CDN for self). */
  url: string | null;
}

/**
 * Download the avatars of a 频道私聊 conversation into
 * `<outputDir>/avatars/<tinyId>.<ext>`, cache-first. Guild members have no uin,
 * so instead of the uin→qlogo convention each target carries its own public
 * URL. Targets with an empty id or no URL are skipped up front.
 */
export async function exportGuildAvatars(
  avatarCache: AvatarCacheService,
  targets: GuildAvatarTarget[],
  outputDir: string,
  opts: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<AvatarExportResult> {
  const rows = targets.filter((t) => t.id && t.url);
  const result: AvatarExportResult = { total: rows.length, ok: 0, failed: 0 };
  if (rows.length === 0) return result;

  const avatarsDir = join(outputDir, 'avatars');
  await mkdir(avatarsDir, { recursive: true });

  let done = 0;
  await runWithConcurrency(rows, opts.concurrency ?? 8, async (row) => {
    try {
      const blob = await avatarCache.get(row.url!);
      await writeFile(
        join(avatarsDir, `${row.id}.${extForContentType(blob.contentType)}`),
        blob.data,
      );
      result.ok += 1;
    } catch {
      result.failed += 1;
    } finally {
      done += 1;
      opts.onProgress?.(done, rows.length);
    }
  });

  return result;
}

/**
 * Download the avatar of every uin in `uins` into `<outputDir>/avatars/<uin>.<ext>`,
 * cache-first. Invalid uins (empty / `0`) are skipped. Never throws — a sender
 * whose avatar 404s just counts toward `failed`.
 */
export async function exportAvatars(
  avatarCache: AvatarCacheService,
  uins: Iterable<string>,
  outputDir: string,
  opts: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<AvatarExportResult> {
  const targets = [...new Set(uins)].filter((uin) => uin && uin !== '0');
  const result: AvatarExportResult = { total: targets.length, ok: 0, failed: 0 };
  if (targets.length === 0) return result;

  const avatarsDir = join(outputDir, 'avatars');
  await mkdir(avatarsDir, { recursive: true });

  let done = 0;
  await runWithConcurrency(targets, opts.concurrency ?? 8, async (uin) => {
    try {
      const blob = await avatarCache.get(avatarUrlForUin(uin));
      await writeFile(join(avatarsDir, `${uin}.${extForContentType(blob.contentType)}`), blob.data);
      result.ok += 1;
    } catch {
      result.failed += 1;
    } finally {
      done += 1;
      opts.onProgress?.(done, targets.length);
    }
  });

  return result;
}
