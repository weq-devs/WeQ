/**
 * Snapshot every scalar column + blob lengths + a body hash for one group
 * message, so we can diff the SAME row before vs after a recall and see exactly
 * which columns QQ's recall touches — the deciding test for the "bump 40002 as
 * bypass signal" plan.
 *
 * Run:  pnpm tsx packages/db/test/snapshot_msg.ts <msgId> [label]
 *   writes/prints a JSON snapshot; run once before recall, once after.
 */

import { createHash } from 'node:crypto';
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' };

const MSG_ID = BigInt(process.argv[2] ?? '7737174878596463872');
const LABEL = process.argv[3] ?? 'snapshot';

const BLOB_COLS = new Set(['40800', '40900', '40600', '40601', '40801', '40605', '40062']);

function cell(_name: string, v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Uint8Array) {
    const h = createHash('sha1').update(v).digest('hex').slice(0, 12);
    return `<BLOB ${v.byteLength}B sha1:${h}>`;
  }
  return String(v);
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, { dbPath: DB_PATH, key: KEY, algo: ALGO });
  try {
    const info = await db.query(`PRAGMA table_info("group_msg_table")`);
    const cols = info.map((r) => String(r[1]));
    const sel = cols.map((c) => `"${c}"`).join(',');
    const rows = await db.query(
      `SELECT ${sel} FROM group_msg_table WHERE "40001" = ? LIMIT 1`,
      [MSG_ID],
    );
    if (!rows.length) {
      console.log(`[${LABEL}] msgId ${MSG_ID} NOT FOUND`);
      return;
    }
    const row = rows[0]!;
    console.log(`===== [${LABEL}] msgId ${MSG_ID} =====`);
    cols.forEach((c, i) => {
      const mark = c === '40002' ? '  ← 40002' : BLOB_COLS.has(c) ? '  (blob)' : '';
      console.log(`  ${c.padEnd(8)} = ${cell(c, row[i])}${mark}`);
    });
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error('failed:', e);
  process.exit(1);
});
