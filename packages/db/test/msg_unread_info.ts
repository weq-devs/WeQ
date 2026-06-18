/**
 * Integration test for reading msg_unread_info_table from nt_msg.db.
 *
 * Run:  pnpm --filter @weq/db test:msg-unread-info
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import * as raw from '@weq/codec/raw';

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

  console.log(`[test:msg-unread-info] opening ${DB_PATH}`);

  // First, get table structure
  const schema = await db.query(`PRAGMA table_info(msg_unread_info_table)`);
  console.log('[test:msg-unread-info] table schema:');
  for (const col of schema) {
    console.log(`  ${col[1]}: ${col[2]}`);
  }

  const rows = await db.query(`SELECT * FROM msg_unread_info_table LIMIT 50`);

  console.log(`[test:msg-unread-info] got ${rows.length} rows`);

  for (const row of rows.slice(0, 3)) {
    const peer = row[0];
    const buf = row[1] as Uint8Array;
    console.log(`\n  peer=${peer}, buf_size=${buf?.length ?? 0}`);
    if (buf && buf.length > 0) {
      console.log(`    hex:`, bufferToHex(buf));
      try {
        const decoded = raw.decode(buf);
        console.log(`    decoded:`, JSON.stringify(decoded, bigintReplacer, 2));
      } catch (e) {
        console.log(`    decode failed:`, e);
      }
    }
  }

  console.log('\n--- first 3 full ---');
  for (const [i, row] of rows.slice(0, 3).entries()) {
    const peer = row[0];
    const buf = row[1] as Uint8Array;
    console.log(`\nRow ${i}: peer=${peer}`);
    console.log(`  Full hex: ${bufferToHex(buf)}`);
  }

  db.close();
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

function bufferToHex(buf: Uint8Array): string {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

main().catch((e) => {
  console.error('[test:msg-unread-info] failed:', e);
  process.exit(1);
});
