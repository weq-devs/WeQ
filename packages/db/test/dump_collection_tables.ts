/**
 * List every table name inside `collection.db` (QQ 收藏夹库).
 *
 * Reuses the same native decrypt path / hardcoded key as the other db tests.
 *
 * Run:  pnpm tsx ./packages/db/test/dump_collection_tables.ts
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const UIN = '1707889225';
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\collection.db`;

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  console.log(`[dump-collection] opening ${DB_PATH}\n`);

  const rows = await db.query(
    `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`,
  );

  console.log(`tables/views (${rows.length}):`);
  for (const row of rows) {
    const name = String(row[0]);
    let count = '?';
    try {
      const c = await db.query(`SELECT COUNT(*) FROM "${name}"`);
      count = String(c[0]?.[0] ?? '?');
    } catch {
      count = '(n/a)';
    }
    console.log(`  ${String(row[1]).padEnd(5)} ${name.padEnd(40)} rows=${count}`);
  }

  db.close();
}

main().catch((e) => {
  console.error('[dump-collection] failed:', e);
  process.exit(1);
});
