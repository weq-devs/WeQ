/**
 * Dump every column of a single message row by msgId (40001), across both the
 * c2c and group message tables, showing the raw value AND its SQLite storage
 * class. Built to debug soft-delete: it flags whether the 40027 mask bit
 * (1<<62) is set and whether 40021 carries the `weqdel` prefix.
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

/** Same mask the service uses (SOFT_DELETE_MASK = bit 62). */
const SOFT_DELETE_MASK = 1n << 62n;
const SOFT_DELETE_UID_PREFIX = 'weqdel';

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
  info.forEach((r, i) => {
    const name = String(r[1]);
    const val = row[i];
    let note = '';
    if (name === '40027') {
      // Is the delete mask bit set?
      let asInt: bigint | null = null;
      try { asInt = typeof val === 'bigint' ? val : BigInt(String(val)); } catch { asInt = null; }
      if (asInt !== null) {
        const masked = (asInt & SOFT_DELETE_MASK) !== 0n;
        note = masked
          ? `  ⚠️  MASK BIT SET (deleted) — original = ${asInt ^ SOFT_DELETE_MASK}`
          : `  ✅ clean (mask bit not set)`;
      }
    }
    if (name === '40021' && typeof val === 'string') {
      note = val.startsWith(SOFT_DELETE_UID_PREFIX)
        ? `  ⚠️  has "${SOFT_DELETE_UID_PREFIX}" prefix (deleted)`
        : `  ✅ no delete prefix`;
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
  console.log(`[dump-msg] mask = ${SOFT_DELETE_MASK} (bit 62), uidPrefix = "${SOFT_DELETE_UID_PREFIX}"\n`);

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
