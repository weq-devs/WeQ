/**
 * Dump every column of a single message row by msgId (40001), across both the
 * c2c and group message tables, showing the raw value AND its SQLite storage
 * class. Built to debug delete/restore: it flags the QQ-style deleted state on
 * 40011/40012 — QQ (and WeQ, which mirrors it) rewrites both to 1 on delete,
 * leaving the 40800 body intact.
 *
 * Run:  pnpm tsx ./packages/db/test/dump_msg_by_id.ts <msgId> [<msgId> ...]
 *   or  WEQ_TEST_MSG_IDS="7651461878938216377,7661671524070269822" pnpm tsx ./packages/db/test/dump_msg_by_id.ts
 *
 * Path/key are hard-coded below (override with WEQ_TEST_DB_PATH / WEQ_TEST_DB_KEY).
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

// ── hard-coded dev credentials (edit these to your local account) ────────────
const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
// ─────────────────────────────────────────────────────────────────────────────

/** QQ rewrites 40011/40012 to (1,1) on delete/recall; WeQ's delete mirrors it. */
const DELETED_MSG_TYPE = 1n;
const DELETED_SUB_TYPE = 1n;

const TABLES = ['c2c_msg_table', 'group_msg_table'] as const;

function storageClass(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Uint8Array) return 'BLOB';
  if (typeof v === 'bigint') return 'INTEGER';
  if (typeof v === 'number') return Number.isInteger(v) ? 'INTEGER' : 'REAL';
  if (typeof v === 'string') return 'TEXT';
  return typeof v;
}

function describe(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (v instanceof Uint8Array) return `<BLOB ${v.byteLength} bytes>`;
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'string') return v.length > 120 ? `${v.slice(0, 120)}… (${v.length} chars)` : JSON.stringify(v);
  return String(v);
}

async function dumpRow(db: QqDb, table: string, msgId: bigint): Promise<void> {
  const info = await db.query(`PRAGMA table_info("${table}")`);
  const cols = info.map((r) => `"${String(r[1])}"`).join(',');
  const rows = await db.query(`SELECT ${cols} FROM "${table}" WHERE "40001" = ? LIMIT 1`, [msgId]);

  if (rows.length === 0) {
    console.log(`  (not found in ${table})`);
    return;
  }
  const row = rows[0]!;
  // Deleted iff BOTH 40011 and 40012 are 1 (QQ recall / WeQ delete signature).
  const typeVal = row[info.findIndex((r) => String(r[1]) === '40011')];
  const subVal = row[info.findIndex((r) => String(r[1]) === '40012')];
  const asBig = (v: unknown): bigint | null => {
    try { return typeof v === 'bigint' ? v : BigInt(String(v)); } catch { return null; }
  };
  const isDeleted = asBig(typeVal) === DELETED_MSG_TYPE && asBig(subVal) === DELETED_SUB_TYPE;
  info.forEach((r, i) => {
    const name = String(r[1]);
    const val = row[i];
    let note = '';
    if (name === '40011' || name === '40012') {
      note = isDeleted ? `  ⚠️  deleted signature (40011=1 & 40012=1)` : `  ✅ live`;
    }
    console.log(`    ${name.padEnd(8)} [${storageClass(val).padEnd(7)}] = ${describe(val)}${note}`);
  });
}

async function main(): Promise<void> {
  const idsArg = process.argv.slice(2).join(',') || process.env.WEQ_TEST_MSG_IDS || '';
  const ids = idsArg
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => BigInt(s));

  if (ids.length === 0) {
    console.error('usage: pnpm tsx ./packages/db/test/dump_msg_by_id.ts <msgId> [<msgId> ...]');
    process.exit(1);
  }

  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  console.log(`[dump-msg] opening ${DB_PATH}`);
  console.log(`[dump-msg] deleted signature: 40011=${DELETED_MSG_TYPE} & 40012=${DELETED_SUB_TYPE}\n`);

  for (const id of ids) {
    console.log(`\n════════════ msgId ${id} ════════════`);
    for (const table of TABLES) {
      console.log(`\n  ── ${table} ──`);
      await dumpRow(db, table, id);
    }
  }

  db.close();
}

main().catch((e) => {
  console.error('[dump-msg] failed:', e);
  process.exit(1);
});
