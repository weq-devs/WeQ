/**
 * Natural experiment: did QQ's recall change column 40002?
 *
 * The user's proposed bypass hinges on recall LEAVING 40002 untouched, so WeQ
 * can signal "this is my edit, allow it" by bumping 40002 in the same UPDATE.
 *
 * We have a pre-recall backup (message still original) and the live DB (same
 * message was recalled while only the 5/4-gated trigger was active, so the body
 * rewrite slipped through). Comparing 40002 (and a few neighbours) for the
 * known recalled msgId across the two files answers it directly.
 *
 * Run:  pnpm tsx packages/db/test/compare_recall_40002.ts <backupPath> <msgId>
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' };
const LIVE =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;

const BACKUP = process.argv[2] ?? `${LIVE}.bak-2026-07-16T00-56-27`;
const MSG_ID = BigInt(process.argv[3] ?? '7662924636114616691');

const COLS = ['40001', '40002', '40003', '40005', '40011', '40012', '40013', '40008', '40009'];

const fmt = (v: unknown) =>
  v instanceof Uint8Array ? `<BLOB ${v.byteLength}B>` : v === null ? 'NULL' : String(v);

async function readRow(path: string): Promise<Record<string, unknown> | null> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, { dbPath: path, key: KEY, algo: ALGO });
  try {
    const sel = COLS.map((c) => `"${c}"`).join(',');
    const rows = await db.query(
      `SELECT ${sel}, length("40800") AS blen FROM group_msg_table WHERE "40001" = ? LIMIT 1`,
      [MSG_ID],
    );
    if (!rows.length) return null;
    const out: Record<string, unknown> = {};
    COLS.forEach((c, i) => (out[c] = rows[0]![i]));
    out['40800.len'] = rows[0]![COLS.length];
    return out;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  console.log(`msgId ${MSG_ID}`);
  console.log(`backup: ${BACKUP}`);
  console.log(`live:   ${LIVE}\n`);

  const before = await readRow(BACKUP);
  const after = await readRow(LIVE);

  if (!before) { console.log('⚠️ msgId not in backup'); }
  if (!after) { console.log('⚠️ msgId not in live'); }
  if (!before || !after) return;

  const keys = [...COLS, '40800.len'];
  console.log('col'.padEnd(12) + 'BEFORE (backup)'.padEnd(24) + 'AFTER (live/recalled)'.padEnd(24) + 'changed?');
  console.log('-'.repeat(72));
  for (const k of keys) {
    const b = fmt(before[k]);
    const a = fmt(after[k]);
    const changed = b !== a ? (k === '40002' ? '★ CHANGED' : 'changed') : '';
    console.log(k.padEnd(12) + b.padEnd(24) + a.padEnd(24) + changed);
  }

  console.log('\n=== verdict for the bypass plan ===');
  if (before['40002'] === after['40002'] || fmt(before['40002']) === fmt(after['40002'])) {
    console.log('✅ 40002 UNCHANGED by recall → WeQ can bump 40002 as a clean bypass signal.');
  } else {
    console.log('❌ recall ALSO changed 40002 → cannot use it as the bypass signal; pick another column.');
  }
}

main().catch((e) => {
  console.error('failed:', e);
  process.exit(1);
});
