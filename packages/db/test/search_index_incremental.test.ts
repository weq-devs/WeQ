/**
 * Watermark-based incremental sync — the offline twin of the old
 * `tools/verify_search_index_incremental.ts`, driving the REAL
 * `MsgSearchIndexDb` against a plain-SQLite fixture source (the testkit stub's
 * `fastDecryptDatabase` degrades to a plain file copy).
 *
 * Locked in:
 *  - `sync()` full-rebuilds and hard-bounds keys == fts rows, srcRowid unique;
 *  - trimming the newest seqs of a partition, then
 *    `incrementalFromWatermarks()` restores exact parity with the source;
 *  - a re-run is a no-op (idempotent — the keys table dedups by srcRowid);
 *  - trigram `searchPartition` / `topPartitions` work on the rebuilt index.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MsgSearchIndexDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const TABLE = 'group_msg_fts';
const G1 = '777';
const G2 = '888';

let dir: string;
let sourcePath: string;
let indexDbPath: string;
let idx: MsgSearchIndexDb;
const nt = createSqliteStub();

afterEach(() => {
  idx.dispose();
  closeAllFixtureDbs();
  rmSync(dir, { recursive: true, force: true });
});

async function count(path: string, sql: string): Promise<number> {
  const rows = await nt.executeSql(path, sql, null);
  return Number(rows[0]?.[0] ?? 0);
}

function createFixture(): void {
  dir = mkdtempSync(join(tmpdir(), 'weq-fts-index-'));
  sourcePath = join(dir, 'group_msg_fts.db');
  indexDbPath = join(dir, 'index.db');

  const sql = fixtureDb(sourcePath);
  // Real QQ databases run in WAL mode — MsgSearchIndexDb.sync() fingerprints
  // the `-wal` sidecar and skips the rebuild entirely when it is absent.
  sql.exec('PRAGMA journal_mode=WAL');
  sql.exec(`
    CREATE TABLE ${TABLE} (
      "40027" TEXT, "40050" INTEGER, "40003" INTEGER, "40021" TEXT,
      "40020" TEXT, "40001" TEXT, "40010" INTEGER, "41701" TEXT, "41702" TEXT
    )
  `);
  const ins = sql.prepare(
    `INSERT INTO ${TABLE}
       ("40027","40050","40003","40021","40020","40001","40010","41701","41702")
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (let seq = 1; seq <= 5; seq++) {
    ins.run(
      G1,
      1700000000 + seq,
      seq,
      'u_peer',
      'u_sender',
      String(1000 + seq),
      1,
      `hello group world ${seq}`,
      '',
    );
  }
  for (let seq = 1; seq <= 3; seq++) {
    ins.run(
      G2,
      1700001000 + seq,
      seq,
      'u_peer',
      'u_sender',
      String(2000 + seq),
      0,
      `goodbye cruel world ${seq}`,
      'file.dat',
    );
  }

  idx = new MsgSearchIndexDb({
    nt,
    sourcePath,
    indexDbPath,
    key: 'fixture-key',
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
    tableName: TABLE,
  });
}

describe('MsgSearchIndexDb incremental sync (offline fixture)', () => {
  it('rebuild → trim → incremental restores parity and stays idempotent', async () => {
    createFixture();

    await idx.sync();
    expect(idx.ready, `sync failed: ${idx.lastError ?? 'unknown'}`).toBe(true);

    // Full rebuild: hard-bounded by source row count.
    expect(await count(indexDbPath, 'SELECT COUNT(*) FROM weq_fts_idx')).toBe(8);
    expect(await count(indexDbPath, 'SELECT COUNT(*) FROM weq_fts_keys')).toBe(8);
    expect(
      await count(
        indexDbPath,
        `SELECT COUNT(*) FROM (SELECT srcRowid FROM weq_fts_keys GROUP BY srcRowid HAVING COUNT(*) > 1)`,
      ),
    ).toBe(0);
    expect(await idx.maxSeqs()).toEqual(
      new Map([
        [G1, 5n],
        [G2, 3n],
      ]),
    );

    // Simulate a stale index: drop the newest 2 seqs of each partition.
    for (const p of [G1, G2]) {
      const delKeys = await nt.executeSqlWrite(
        indexDbPath,
        `DELETE FROM weq_fts_keys WHERE partition = ? AND msgSeq IN (
           SELECT msgSeq FROM weq_fts_keys WHERE partition = ? ORDER BY msgSeq DESC LIMIT 2
         )`,
        [p, p],
      );
      await nt.executeSqlWrite(
        indexDbPath,
        `DELETE FROM weq_fts_idx WHERE partition = ? AND msgSeq IN (
           SELECT msgSeq FROM weq_fts_idx WHERE partition = ? ORDER BY msgSeq DESC LIMIT 2
         )`,
        [p, p],
      );
      expect(delKeys).toBe(2);
    }
    expect(await idx.maxSeqs()).toEqual(
      new Map([
        [G1, 3n],
        [G2, 1n],
      ]),
    );

    // Live watermarks from the source pull the missing rows back.
    await idx.incrementalFromWatermarks(
      new Map([
        [G1, 5n],
        [G2, 3n],
      ]),
    );
    expect(await count(indexDbPath, 'SELECT COUNT(*) FROM weq_fts_idx')).toBe(8);
    expect(await count(indexDbPath, 'SELECT COUNT(*) FROM weq_fts_keys')).toBe(8);

    // Idempotent: re-run changes nothing.
    await idx.incrementalFromWatermarks(
      new Map([
        [G1, 5n],
        [G2, 3n],
      ]),
    );
    expect(await count(indexDbPath, 'SELECT COUNT(*) FROM weq_fts_idx')).toBe(8);
    expect(await count(indexDbPath, 'SELECT COUNT(*) FROM weq_fts_keys')).toBe(8);
  });

  it('trigram search works over the rebuilt index', async () => {
    createFixture();

    await idx.sync();

    const top = await idx.topPartitions('hello', 10);
    expect(top).toHaveLength(1);
    expect(String(top[0]!.partition)).toBe(G1);
    expect(top[0]!.count).toBe(5);

    const page = await idx.searchPartition(777n, 'world', 20);
    expect(page.total).toBe(5);
    expect(page.items.map((h) => Number(h.msgSeq)).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);

    // Files column survives the copy + reindex.
    const fileHit = await idx.searchPartition(888n, 'file.dat', 20);
    expect(fileHit.total).toBe(3);
  });
});
