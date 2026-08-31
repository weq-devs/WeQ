/**
 * System-emoji (小黄脸 faceElement) export — copy the QQ NT built-in emoji
 * images used by a conversation into the export bundle so the HTML page can show
 * the real faces instead of a `[表情]` text placeholder.
 *
 * QQ ships its built-in animated emoji under the logged-in account's
 * `…/nt_data/Emoji/BaseEmojiSyastems/EmojiSystermResource/<id>/…`, each face
 * carrying up to three formats (see {@link SysEmojiResourceService}):
 *
 *   <id>/apng/<id>.png   ← APNG animation (extension is .png but it animates)
 *   <id>/png/<id>.png    ← static thumbnail (fallback when no apng)
 *
 * `<img>` renders APNG natively, so we prefer the APNG and fall back to the
 * static PNG. Both land at the bundle's deterministic `media/face/<id>.png`,
 * which is exactly the path the HTML exporter writes into each `<img src=…>` —
 * so the message file doesn't need to know which copies actually succeeded (a
 * missing image just falls back to its `[表情]` alt text in the browser).
 *
 * Unicode-glyph faces (🍺 等，faceId 是 Unicode code point) have no `<id>/apng`
 * dir and are rendered as text glyphs by the exporter, so they never reach here
 * — the caller only collects numeric face ids.
 */

import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaStageResult, StageProgress } from './media_export';

/** Bundle subdirectory (under `media/`) that system-emoji images land in. */
export const SYSFACE_SUBDIR = 'face';

/** Bundle subdirectory (under `media/`) that market (store) sticker images land in. */
export const MFACE_SUBDIR = 'mface';

/**
 * Pick the source image for one face id: prefer `apng/<id>.png`, else the static
 * `png/<id>.png`, else the first image the dir carries. Returns the absolute
 * source path, or null when the face has no on-disk image.
 */
async function pickFaceImage(root: string, id: string): Promise<string | null> {
  for (const fmt of ['apng', 'png'] as const) {
    const exact = join(root, id, fmt, `${id}.png`);
    // The primary file is `<id>.png`; probe it directly, else scan the dir for
    // any `.png` (some faces name their frames differently).
    const dir = join(root, id, fmt);
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.png'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;
    return files.includes(`${id}.png`) ? exact : join(dir, files.sort()[0]!);
  }
  return null;
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

/**
 * Copy every collected system-emoji face into `<mediaRoot>/face/<id>.png`,
 * cache-first from the account's emoji resource dir. Ids with no on-disk image
 * (unknown / not-installed faces) count toward `failed` — the HTML page then
 * shows their `[表情]` alt fallback. Never throws.
 *
 * @param faceIds  distinct numeric face ids seen while exporting (as strings)
 * @param emojiRoot  account emoji resource dir (platform.emojiResourceDir), or null
 * @param mediaRoot  the bundle's `media/` directory
 */
export async function exportSysFaces(
  faceIds: Iterable<string>,
  emojiRoot: string | null,
  mediaRoot: string,
  onProgress?: StageProgress,
  concurrency = 8,
): Promise<MediaStageResult> {
  const ids = [...new Set(faceIds)].filter((id) => /^\d+$/.test(id));
  const result: MediaStageResult = { total: ids.length, ok: 0, failed: 0 };
  if (ids.length === 0 || !emojiRoot) return result;

  const faceDir = join(mediaRoot, SYSFACE_SUBDIR);
  await mkdir(faceDir, { recursive: true });

  let done = 0;
  await runWithConcurrency(ids, concurrency, async (id) => {
    try {
      const src = await pickFaceImage(emojiRoot, id);
      if (src) {
        await copyFile(src, join(faceDir, `${id}.png`));
        result.ok += 1;
      } else {
        result.failed += 1;
      }
    } catch {
      result.failed += 1;
    } finally {
      done += 1;
      onProgress?.(done, ids.length);
    }
  });

  return result;
}

/**
 * Copy every collected market (store) sticker into `<mediaRoot>/mface/<hash>.gif`,
 * resolving each via the injected `resolve(pack, hash)` → locally-cached / CDN
 * decrypted sticker path (bridged from `EmojiService.getMarketFace`).
 *
 * Driven by the same「QQ系统表情」media option as {@link exportSysFaces} (商城表情
 * 归类进该资源)；refs are the `pack:hash` strings collected by the HTML exporter.
 * A sticker that can't be resolved counts toward `failed` — the HTML page then shows
 * its `[表情]` alt fallback. Never throws.
 *
 * @param refs    distinct `pack:hash` reference strings seen while exporting
 * @param resolve  `(pack, hash) → absolute sticker path | null`
 * @param mediaRoot  the bundle's `media/` directory
 */
export async function exportMarketFaces(
  refs: Iterable<string>,
  resolve: (pack: string, hash: string) => Promise<string | null>,
  mediaRoot: string,
  onProgress?: StageProgress,
  concurrency = 8,
): Promise<MediaStageResult> {
  const items: Array<{ pack: string; hash: string }> = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const i = ref.indexOf(':');
    if (i <= 0) continue;
    const pack = ref.slice(0, i);
    const hash = ref.slice(i + 1);
    if (!/^\d+$/.test(pack) || !/^[0-9a-f]+$/i.test(hash)) continue;
    const key = `${pack}:${hash.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ pack, hash: key.slice(key.indexOf(':') + 1) });
  }
  const result: MediaStageResult = { total: items.length, ok: 0, failed: 0 };
  if (items.length === 0) return result;

  const faceDir = join(mediaRoot, MFACE_SUBDIR);
  await mkdir(faceDir, { recursive: true });

  let done = 0;
  await runWithConcurrency(items, concurrency, async (item) => {
    try {
      const src = await resolve(item.pack, item.hash);
      if (src) {
        await copyFile(src, join(faceDir, `${item.hash}.gif`));
        result.ok += 1;
      } else {
        result.failed += 1;
      }
    } catch {
      result.failed += 1;
    } finally {
      done += 1;
      onProgress?.(done, items.length);
    }
  });

  return result;
}
