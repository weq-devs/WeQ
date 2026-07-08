/**
 * Insert-a-new-c2c-message smoke test.
 *
 * Picks a random peer (by sortNo = column 40027, the indexed c2c partition
 * key), reads that peer's last message, then writes a *copy* of it as a new row:
 *   - 40001 (msgId)   → last msgId + a small random increment (unique & monotonic)
 *   - 40003 (msgSeq)  → last msgSeq + 1
 *   - 40050 (sendTime)→ NOW (unix seconds)
 *   - 40058 (dayTs)   → today's local midnight (kept consistent with sendTime)
 *   - 40801, 40900    → forced NULL (display-text / source-message cache)
 * Every other column is copied verbatim.
 *
 * ⚠️ This WRITES to the live nt_msg.db. Back up first and run with QQ closed.
 *
 * Run:  pnpm tsx ./packages/db/test/insert_c2c_msg.ts
 */

import { loadNative } from '@weq/native';
import type { SqlValue } from '@weq/native';
import { QqDb } from '../src/qq_db';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';

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

  console.log(`[insert-c2c-msg] opening ${DB_PATH}\n`);

  // 1) Candidate peers by sortNo (top talkers), pick one at random.
  const peers = await db.query(
    `SELECT "40027","40021", COUNT(*) c FROM c2c_msg_table
      WHERE "40027" IS NOT NULL AND "40027" > 0
      GROUP BY "40027"
      ORDER BY c DESC
      LIMIT 10`,
  );
  if (peers.length === 0) {
    console.error('[insert-c2c-msg] no peers with a sortNo found');
    db.close();
    process.exit(1);
  }
  console.log('candidate peers (sortNo, uid, msgCount):');
  for (const p of peers) console.log(`  ${String(p[0]).padEnd(6)} ${String(p[1]).padEnd(28)} ${p[2]}`);

  const pick = peers[Math.floor(Math.random() * peers.length)]!;
  const sortNo = pick[0] as bigint;
  console.log(`\npicked sortNo=${sortNo}n  uid=${pick[1]}  (${pick[2]} msgs)\n`);

  // 2) Full column list + last message for that peer.
  const info = await db.query(`PRAGMA table_info("c2c_msg_table")`);
  const cols = info.map((r) => String(r[1]));
  const quoted = cols.map((c) => `"${c}"`).join(',');
  const idx = (c: string): number => {
    const i = cols.indexOf(c);
    if (i < 0) throw new Error(`column ${c} not found`);
    return i;
  };

  const lastRows = await db.query(
    `SELECT ${quoted} FROM c2c_msg_table
      WHERE "40027" = ?
      ORDER BY "40003" DESC
      LIMIT 1`,
    [sortNo],
  );
  if (lastRows.length === 0) {
    console.error(`[insert-c2c-msg] no messages for sortNo ${sortNo}`);
    db.close();
    process.exit(1);
  }

  const values = [...lastRows[0]!] as SqlValue[];
  const lastMsgId = values[idx('40001')] as bigint;
  const lastSeq = values[idx('40003')] as bigint;
  const lastTime = values[idx('40050')] as bigint;

  // 3) Overrides.
  const now = new Date();
  const nowSec = BigInt(Math.floor(now.getTime() / 1000));
  const midnightSec = BigInt(
    Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000),
  );
  const newMsgId = lastMsgId + BigInt(1 + Math.floor(Math.random() * 1000));
  const newSeq = lastSeq + 1n;
  // 40002 (msgRandom) is part of a UNIQUE index (40027,40002,40005); copying it
  // verbatim collides with the source row, so mint a fresh random.
  const newRandom = BigInt(Math.floor(Math.random() * 0x7fffffff));

  values[idx('40001')] = newMsgId;
  values[idx('40002')] = newRandom;
  values[idx('40003')] = newSeq;
  values[idx('40050')] = nowSec;
  values[idx('40058')] = midnightSec;
  for (const c of NULL_COLUMNS) values[idx(c)] = null;

  console.log(`last : msgId=${lastMsgId}n  msgSeq=${lastSeq}n  sendTime=${lastTime}n`);
  console.log(`new  : msgId=${newMsgId}n  msgSeq=${newSeq}n  sendTime=${nowSec}n (${now.toLocaleString()})\n`);
  console.log('row to insert (overrides marked *):');
  cols.forEach((c, i) => {
    const changed =
      c === '40001' || c === '40002' || c === '40003' || c === '40050' || c === '40058' || NULL_COLUMNS.has(c);
    console.log(`  ${c.padEnd(8)} = ${describe(values[i])}${changed ? ' *' : ''}`);
  });

  // 4) Insert + verify.
  const placeholders = cols.map(() => '?').join(',');
  const affected = await db.write(
    `INSERT INTO c2c_msg_table (${quoted}) VALUES (${placeholders})`,
    values,
  );
  console.log(`\n[insert-c2c-msg] inserted rows: ${affected}`);

  const check = await db.query(
    `SELECT "40001","40003","40033","40050" FROM c2c_msg_table
      WHERE "40027" = ?
      ORDER BY "40003" DESC
      LIMIT 1`,
    [sortNo],
  );
  const c0 = check[0]!;
  console.log(
    `[insert-c2c-msg] newest now → msgId=${c0[0]}  msgSeq=${c0[1]}  senderUin=${c0[2]}  sendTime=${c0[3]}`,
  );

  db.close();
}

main().catch((e) => {
  console.error('[insert-c2c-msg] failed:', e);
  process.exit(1);
});
