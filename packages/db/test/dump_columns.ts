/**
 * Schema-dump helper for the two message tables.
 *
 * Lists every column of `c2c_msg_table` and `group_msg_table`, then prints one
 * example row per table so we can see the actual data shape behind the numeric
 * column ids.
 *
 * Run:  pnpm tsx ./packages/db/test/dump_columns.ts
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv } from '@weq/testkit';

const DB_PATH = testEnv.msgDbPath;
const KEY = testEnv.key;

const TABLES = ['c2c_msg_table', 'group_msg_table'] as const;

function describe(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (v instanceof Uint8Array) return `<BLOB ${v.byteLength} bytes>`;
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'string') return v.length > 200 ? `${v.slice(0, 200)}… (${v.length} chars)` : v;
  return String(v);
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  console.log(`[dump-columns] opening ${DB_PATH}\n`);

  for (const table of TABLES) {
    console.log(`\n================ ${table} ================`);

    // 1) all columns
    const info = await db.query(`PRAGMA table_info("${table}")`);
    console.log(`columns (${info.length}):`);
    for (const row of info) {
      // PRAGMA table_info → [cid, name, type, notnull, dflt_value, pk]
      console.log(`  ${String(row[1]).padEnd(8)} ${String(row[2] || '').padEnd(10)} pk=${row[5]}`);
    }

    // 2) one example row, column → value
    const cols = info.map((r) => `"${String(r[1])}"`).join(',');
    const sample = await db.query(`SELECT ${cols} FROM "${table}" LIMIT 1`);
    console.log(`\nexample row:`);
    if (sample.length === 0) {
      console.log('  (table empty)');
    } else {
      const row0 = sample[0]!;
      info.forEach((r, i) => {
        console.log(`  ${String(r[1]).padEnd(8)} = ${describe(row0[i])}`);
      });
    }
  }

  db.close();
}

main().catch((e) => {
  console.error('[dump-columns] failed:', e);
  process.exit(1);
});
