/**
 * Insert-a-new-group-message smoke test.
 *
 * Reads the last message of a target group, then writes a *copy* of it back as
 * a brand-new row:
 *   - 40001 (msgId)  → last msgId + a small random increment (stays unique & monotonic)
 *   - 40003 (msgSeq) → last msgSeq + 1
 *   - 40801, 40900   → forced to NULL (display-text / source-message cache;
 *                       copying them verbatim breaks reply/forward rendering)
 * Every other column is copied verbatim from the last message (there is no
 * meaningful default for the unknown columns, so "same as last" is the safest
 * fill).
 *
 * ⚠️ This WRITES to the live nt_msg.db. Back up first and run with QQ closed.
 *
 * Run:  pnpm tsx ./packages/db/test/insert_group_msg.ts
 */

import { loadNative } from '@weq/native';
import type { SqlValue } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv } from '@weq/testkit';

const DB_PATH = testEnv.msgDbPath;
const KEY = testEnv.key;

const GROUP_CODE = '1090396070';

/** Columns that must be blanked out on the copy. */
const NULL_COLUMNS = new Set(['40801', '40900']);

function describe(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (v instanceof Uint8Array) return `<BLOB ${v.byteLength} bytes>`;
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'string') return v.length > 120 ? `${v.slice(0, 120)}… (${v.length} chars)` : v;
  return String(v);
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  console.log(`[insert-group-msg] opening ${DB_PATH}`);
  console.log(`[insert-group-msg] target group ${GROUP_CODE}\n`);

  // Full column list, in table order.
  const info = await db.query(`PRAGMA table_info("group_msg_table")`);
  const cols = info.map((r) => String(r[1]));
  const quoted = cols.map((c) => `"${c}"`).join(',');
  const idx = (c: string): number => {
    const i = cols.indexOf(c);
    if (i < 0) throw new Error(`column ${c} not found`);
    return i;
  };

  // Last message in this group (newest by msgSeq).
  const lastRows = await db.query(
    `SELECT ${quoted} FROM group_msg_table
      WHERE "40027" = ?
      ORDER BY "40003" DESC
      LIMIT 1`,
    [GROUP_CODE],
  );
  if (lastRows.length === 0) {
    console.error(`[insert-group-msg] no messages found for group ${GROUP_CODE}`);
    db.close();
    process.exit(1);
  }

  const values = [...lastRows[0]!] as SqlValue[];
  const lastMsgId = values[idx('40001')] as bigint;
  const lastSeq = values[idx('40003')] as bigint;

  console.log(`last message: msgId=${lastMsgId}n  msgSeq=${lastSeq}n`);

  // Build the new row: copy + overrides.
  const newMsgId = lastMsgId + BigInt(1 + Math.floor(Math.random() * 1000));
  const newSeq = lastSeq + 1n;
  values[idx('40001')] = newMsgId;
  values[idx('40003')] = newSeq;
  for (const c of NULL_COLUMNS) values[idx(c)] = null;

  console.log(`new  message: msgId=${newMsgId}n  msgSeq=${newSeq}n\n`);
  console.log('row to insert (overrides marked *):');
  cols.forEach((c, i) => {
    const mark = c === '40001' || c === '40003' || NULL_COLUMNS.has(c) ? ' *' : '';
    console.log(`  ${c.padEnd(8)} = ${describe(values[i])}${mark}`);
  });

  // Insert.
  const placeholders = cols.map(() => '?').join(',');
  const affected = await db.write(
    `INSERT INTO group_msg_table (${quoted}) VALUES (${placeholders})`,
    values,
  );
  console.log(`\n[insert-group-msg] inserted rows: ${affected}`);

  // Verify by re-reading the newest message.
  const check = await db.query(
    `SELECT "40001","40003","40033","40050" FROM group_msg_table
      WHERE "40027" = ?
      ORDER BY "40003" DESC
      LIMIT 1`,
    [GROUP_CODE],
  );
  const c0 = check[0]!;
  console.log(
    `[insert-group-msg] newest now → msgId=${c0[0]}  msgSeq=${c0[1]}  senderUin=${c0[2]}  sendTime=${c0[3]}`,
  );

  db.close();
}

main().catch((e) => {
  console.error('[insert-group-msg] failed:', e);
  process.exit(1);
});
