/**
 * Chain verification: codec → db → service.
 *
 * Builds the real CollectionDb (which decodes collection.db blobs via the
 * codec schemas), wraps it in CollectionService, then pages through ALL of my
 * favorites via the service's paginated API — exercising every layer.
 *
 * Run:  pnpm tsx ./packages/service/test/collection_chain.ts
 */

import { loadNative } from '@weq/native';
import { CollectionDb, type CollectionItem } from '@weq/db';
import type { AccountSession } from '@weq/account';
import { CollectionService } from '../src/account/collection';

const UIN = '1707889225';
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\collection.db`;

/** One-line human summary of an item, for spot-checking decoded content. */
function preview(it: CollectionItem): string {
  const s = it.summary;
  if (s.richMediaSummary) return s.richMediaSummary.brief || s.richMediaSummary.title || '(rich media)';
  if (s.linkSummary) return `${s.linkSummary.title ?? ''} → ${s.linkSummary.url ?? ''}`;
  if (s.fileSummary) return s.fileSummary.fileInfo?.name ?? '(file)';
  if (s.videoSummary) return `video ${s.videoSummary.duration ?? '?'}s`;
  if (s.audioSummary) return `audio ${s.audioSummary.duration ?? '?'}ms`;
  if (s.locationSummary) return `${s.locationSummary.name ?? ''} @${s.locationSummary.latitude ?? '?'},${s.locationSummary.longitude ?? '?'}`;
  if (s.gallerySummary) return `gallery ×${s.gallerySummary.picList?.length ?? 0}`;
  if (s.textSummary) return s.textSummary.text ?? '(text)';
  return '(unknown)';
}

async function main() {
  const native = loadNative();
  const db = new CollectionDb(native.ntHelper, { dbPath: DB_PATH, key: KEY, algo: ALGO });

  // The service only touches `session.collection`, so a minimal stub is enough
  // to drive the real service → db → codec path.
  const session = { collection: db } as unknown as AccountSession;
  const service = new CollectionService(session);

  try {
    const total = await service.countCollections();
    console.log(`[chain] total favorites: ${total}`);

    // Page through everything via the service pagination API.
    const all: CollectionItem[] = [];
    const PAGE = 15;
    let offset = 0;
    for (;;) {
      const page = await service.listCollections(PAGE, offset);
      all.push(...page.items);
      console.log(
        `[chain] page offset=${page.offset} got=${page.items.length} hasMore=${page.hasMore}`,
      );
      if (!page.hasMore) break;
      offset += PAGE;
    }

    console.log(`\n[chain] collected ${all.length} items across pages (expected ${total})`);

    // Type distribution.
    const dist = new Map<string, number>();
    for (const it of all) dist.set(it.kind, (dist.get(it.kind) ?? 0) + 1);
    console.log('[chain] kind distribution:');
    [...dist.entries()].sort().forEach(([k, n]) => console.log(`   ${k.padEnd(12)} ${n}`));

    // One decoded sample per kind.
    console.log('\n[chain] one sample per kind:');
    const seen = new Set<string>();
    for (const it of all) {
      if (seen.has(it.kind)) continue;
      seen.add(it.kind);
      const who = it.author?.strId || it.author?.uid || '?';
      console.log(`   [${it.kind}] by ${who}: ${preview(it).slice(0, 60)}`);
    }

    if (all.length !== total) {
      throw new Error(`pagination mismatch: paged ${all.length} but count says ${total}`);
    }
    console.log('\n[chain] ✅ codec → db → service verified: pagination consistent, all rows decoded.');
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error('[chain] failed:', e);
  process.exit(1);
});
