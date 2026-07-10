/**
 * One-off inspection dump: ALL columns of a single `recent_contact_v3_table`
 * row. Prints the full schema (PRAGMA table_info) then one row's every column
 * with a value preview (BLOBs as byte-length + hex head, text truncated).
 *
 * Run:  pnpm --filter @weq/db test:recent-contact-dump
 *
 * Requires `native/win32/x64/nt_helper.node` + dev credentials
 * (or WEQ_TEST_DB_PATH / WEQ_TEST_DB_KEY env vars).
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';

const TABLE = 'recent_contact_v3_table';

function describe(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v.slice(0, 48)).toString('hex');
    return `<BLOB ${v.byteLength} bytes> ${hex}${v.byteLength > 48 ? '…' : ''}`;
  }
  if (typeof v === 'bigint') return `${v}n (bigint)`;
  if (typeof v === 'string') {
    return v.length > 160 ? `${v.slice(0, 160)}… (${v.length} chars)` : `"${v}"`;
  }
  return `${String(v)} (${typeof v})`;
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  console.log(`[recent-contact-dump] opening ${DB_PATH}\n`);

  // 1) full schema.
  const info = await db.query(`PRAGMA table_info("${TABLE}")`);
  console.log(`================ ${TABLE} — columns (${info.length}) ================`);
  const colNames: string[] = [];
  for (const row of info) {
    // PRAGMA table_info → [cid, name, type, notnull, dflt_value, pk]
    const name = String(row[1]);
    colNames.push(name);
    console.log(`  ${name.padEnd(10)} ${String(row[2] || '').padEnd(10)} notnull=${row[3]} pk=${row[5]}`);
  }

  // 2) one row (most recent), every column.
  const rows = await db.query(`SELECT * FROM "${TABLE}" ORDER BY "40050" DESC LIMIT 1`);
  if (rows.length === 0) {
    console.log('\n(no rows)');
    db.close();
    return;
  }
  const row = rows[0]!;
  console.log(`\n================ one example row — ${row.length} columns ================`);
  for (let i = 0; i < row.length; i++) {
    console.log(`  ${(colNames[i] ?? `#${i}`).padEnd(10)} = ${describe(row[i])}`);
  }

  db.close();
}

main().catch((e) => {
  console.error('[recent-contact-dump] failed:', e);
  process.exit(1);
});
