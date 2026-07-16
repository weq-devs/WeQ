/**
 * Read-only recon before installing the anti-recall trigger:
 *   - list every existing trigger (does QQ ship its own? will ours collide?)
 *   - dump the CREATE TABLE for c2c/group so we know PK / UNIQUE constraints
 *     the re-insert path must respect.
 *
 * Run:  pnpm tsx packages/db/test/inspect_triggers.ts
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  const trig = await db.query(
    `SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY tbl_name`,
  );
  console.log(`=== existing triggers: ${trig.length} ===`);
  for (const t of trig) {
    console.log(`\n-- ${String(t[0])}  (on ${String(t[1])})`);
    console.log(String(t[2] ?? '(no sql)'));
  }

  for (const tbl of ['c2c_msg_table', 'group_msg_table']) {
    const sql = await db.query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [tbl],
    );
    console.log(`\n=== ${tbl} CREATE TABLE ===`);
    console.log(String(sql[0]?.[0] ?? '(not found)'));
    const idx = await db.query(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`,
      [tbl],
    );
    console.log(`--- indexes on ${tbl}: ${idx.length} ---`);
    for (const r of idx) console.log(`  ${String(r[0])}: ${String(r[1] ?? 'auto')}`);
  }

  db.close();
}

main().catch((e) => {
  console.error('failed:', e);
  process.exit(1);
});
