/**
 * End-to-end verification for the watermark-based incremental sync in
 * search_index.ts.
 *
 * Builds a scratch index from the REAL encrypted group_msg_fts.db via the
 * exact same code path as fullRebuild() (MsgSearchIndexDb.sync()), then:
 *   1. trims the newest rows of two partitions from the index (simulates a
 *      stale index built earlier);
 *   2. drives the real MsgSearchIndexDb.incrementalFromWatermarks() with
 *      watermarks read from the LIVE encrypted source;
 *   3. asserts the index per-partition row count exactly equals the source
 *      (hard bound), that a re-run is a no-op (idempotent), and that
 *      maxSeqs / trigram search still work.
 *
 * Run: pnpm --filter @weq/db exec tsx tools/verify_search_index_incremental.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNative } from '@weq/native';
import { qqDbPath, testEnv } from '@weq/testkit';
import { MsgSearchIndexDb } from '../src/msg/search_index';

const KEY = testEnv.key;
const ALGO = { pageHmacAlgorithm: 'SHA1' as const, kdfHmacAlgorithm: 'SHA512' as const };
const TABLE = 'group_msg_fts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function count(db: string, sql: string, params?: (string | bigint | number)[]): Promise<number> {
  const rows = await loadNative().ntHelper.executeSql(db, sql, (params as never) ?? null);
  return Number(rows[0]?.[0] ?? 0);
}

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;
  const sourcePath = qqDbPath(`${TABLE}.db`);
  const scratch = mkdtempSync(join(tmpdir(), 'weq-verify-index-'));
  const indexDbPath = join(scratch, 'index.db');

  // --- 0) probe the live encrypted source ---
  const srcInfo = await nt.executeSqlWithKey(
    sourcePath,
    `SELECT "40027", COUNT(*), MAX("40003") FROM ${TABLE} GROUP BY "40027" ORDER BY COUNT(*) DESC LIMIT 5`,
    KEY,
    ALGO,
    null,
  );
  console.log('[verify] top partitions (40027 | rows | maxSeq):');
  for (const r of srcInfo) console.log(`   ${String(r[0])}  ${Number(r[1])}  ${String(r[2])}`);
  assert(srcInfo.length > 0, 'source has no partitions');
  const targets = srcInfo.slice(0, 2).map((r) => String(r[0]));
  console.log(`[verify] targets = ${targets.join(', ')}`);

  // --- 1) full rebuild into a scratch file (exact class code path) ---
  const idx = new MsgSearchIndexDb({
    nt,
    sourcePath,
    indexDbPath,
    key: KEY,
    algo: ALGO,
    tableName: TABLE,
  });
  const t0 = Date.now();
  await idx.sync();
  console.log(`[verify] sync() done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const ftsTotal = await count(indexDbPath, `SELECT COUNT(*) FROM weq_fts_idx`);
  const keysTotal = await count(indexDbPath, `SELECT COUNT(*) FROM weq_fts_keys`);
  console.log(`[verify] after full rebuild: fts=${ftsTotal} keys=${keysTotal}`);
  assert(ftsTotal > 0, 'fts populated');
  assert(ftsTotal === keysTotal, 'keys == fts after rebuild');
  const dup = await count(
    indexDbPath,
    `SELECT COUNT(*) FROM (SELECT srcRowid FROM weq_fts_keys GROUP BY srcRowid HAVING COUNT(*) > 1)`,
  );
  assert(dup === 0, 'keys srcRowid unique');

  // --- 2) simulate a stale index: drop the newest 3 seqs of each target ---
  for (const p of targets) {
    const delKeys = await nt.executeSqlWrite(
      indexDbPath,
      `DELETE FROM weq_fts_keys WHERE partition = ? AND msgSeq IN (
         SELECT msgSeq FROM weq_fts_keys WHERE partition = ? ORDER BY msgSeq DESC LIMIT 3
       )`,
      [p, p],
    );
    const delFts = await nt.executeSqlWrite(
      indexDbPath,
      `DELETE FROM weq_fts_idx WHERE partition = ? AND msgSeq IN (
         SELECT msgSeq FROM weq_fts_idx WHERE partition = ? ORDER BY msgSeq DESC LIMIT 3
       )`,
      [p, p],
    );
    console.log(`[verify] trimmed ${delKeys} keys / ${delFts} fts rows from partition ${p}`);
    assert(delKeys > 0 && delFts > 0, 'trim removed rows');
  }

  // --- 3) real watermarks from the live encrypted source ---
  const wmRows = await nt.executeSqlWithKey(
    sourcePath,
    `SELECT "40027", MAX("40003") FROM ${TABLE}
      WHERE "40027" IN (${targets.map(() => '?').join(',')})
      GROUP BY "40027"`,
    KEY,
    ALGO,
    targets,
  );
  const watermarks = new Map(wmRows.map((r) => [String(r[0]), BigInt(String(r[1]))]));
  console.log(`[verify] watermarks: ${[...watermarks.entries()].map(([p, s]) => `${p}=${s}`).join(', ')}`);

  // --- 4) drive the real incremental (ready is set by sync()) ---
  await idx.incrementalFromWatermarks(watermarks);
  assert(idx.lastError === null, `incremental failed: ${idx.lastError}`);

  // Hard bound: per partition, index row count == source row count exactly.
  for (const p of targets) {
    const srcCount = Number(
      (
        await nt.executeSqlWithKey(
          sourcePath,
          `SELECT COUNT(*) FROM ${TABLE} WHERE "40027" = ?`,
          KEY,
          ALGO,
          [p],
        )
      )[0]?.[0] ?? 0,
    );
    const idxCount = await count(indexDbPath, `SELECT COUNT(*) FROM weq_fts_keys WHERE partition = ?`, [p]);
    console.log(`[verify] partition ${p}: index ${idxCount} vs source ${srcCount}`);
    assert(idxCount === srcCount, `partition ${p}: index ${idxCount} != source ${srcCount}`);
  }

  // --- 5) idempotency: re-running the same watermarks must be a no-op ---
  const before = await count(indexDbPath, `SELECT COUNT(*) FROM weq_fts_keys`);
  await idx.incrementalFromWatermarks(watermarks);
  const after = await count(indexDbPath, `SELECT COUNT(*) FROM weq_fts_keys`);
  assert(after === before, `re-run changed keys count: ${before} -> ${after}`);
  const ftsAfter = await count(indexDbPath, `SELECT COUNT(*) FROM weq_fts_idx`);
  assert(ftsAfter === after, `fts(${ftsAfter}) != keys(${after}) after incremental`);

  // --- 6) maxSeqs caught up + trigram search still works ---
  const maxes = await idx.maxSeqs();
  for (const [p, w] of watermarks) {
    console.log(`[verify] maxSeq ${p}: have ${maxes.get(p)} want ${w}`);
    assert(maxes.get(p) === w, `maxSeq for ${p} not caught up`);
  }
  const snippet = await nt.executeSql(
    indexDbPath,
    `SELECT body FROM weq_fts_idx WHERE partition = ? AND length(body) >= 3 LIMIT 1`,
    [targets[0]!],
  );
  assert(snippet.length > 0, 'no searchable body found');
  const kw = String(snippet[0]?.[0]).slice(0, 8);
  const hits = await idx.searchPartition(BigInt(targets[0]!), kw, 5, 0);
  console.log(`[verify] searchPartition("${kw}") -> total=${hits.total} items=${hits.items.length}`);
  assert(hits.total > 0, 'search returned nothing');

  console.log('\n[verify] ALL CHECKS PASSED');
  try {
    nt.closeDb(indexDbPath);
  } catch {
    /* cached connection is gone already */
  }
  rmSync(scratch, { recursive: true, force: true });
}

main().catch((e) => {
  console.error('[verify] FAILED:', e);
  process.exit(1);
});
