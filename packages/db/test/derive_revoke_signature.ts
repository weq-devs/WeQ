/**
 * Derive a byte SIGNATURE that is present in EVERY recall (5/4) 40800 body and
 * ABSENT from all normal bodies — so a trigger can gate on
 * `instr(NEW."40800", X'<sig>') > 0` using only built-in SQL (no custom native
 * function, which would crash QQ's own connection).
 *
 * Also reports whether recall touches column 40900 (forward/reply content),
 * and if so how, so we know whether/how to guard it too.
 *
 * Run:  pnpm tsx packages/db/test/derive_revoke_signature.ts [table] [scan]
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const TABLE = process.argv[2] ?? 'group_msg_table';
const SCAN = Number(process.argv[3] ?? 20000);

const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

/** All length-n byte windows of a buffer, as hex strings. */
function ngrams(buf: Uint8Array, n: number): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i + n <= buf.length; i++) s.add(hex(buf.subarray(i, i + n)));
  return s;
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  // recall bodies (5/4) and a big sample of normal bodies
  const revoke = await db.query(
    `SELECT "40800","40900" FROM ${TABLE} WHERE "40011"=5 AND "40012"=4 AND "40800" IS NOT NULL`,
  );
  const normal = await db.query(
    `SELECT "40800" FROM ${TABLE} WHERE NOT ("40011"=5 AND "40012"=4) AND "40800" IS NOT NULL
      ORDER BY rowid DESC LIMIT ?`,
    [BigInt(SCAN)],
  );

  console.log(`revoke bodies: ${revoke.length}, normal bodies sampled: ${normal.length}\n`);
  if (revoke.length === 0) {
    console.log('no revoke samples in this table — try the other table.');
    db.close();
    return;
  }

  // --- 40900 behaviour on recall ---
  let with900 = 0;
  let len900 = 0;
  for (const r of revoke) {
    const b = r[1];
    if (b instanceof Uint8Array && b.byteLength > 0) {
      with900++;
      len900 += b.byteLength;
    }
  }
  console.log(`=== 40900 on recall rows ===`);
  console.log(`  ${with900}/${revoke.length} recall rows still carry non-empty 40900 (avg ${with900 ? (len900 / with900).toFixed(0) : 0}B)`);
  console.log(`  → if ~0, recall CLEARS 40900; if most retain, recall leaves 40900 alone.\n`);

  // --- signature search on 40800 ---
  const N = 8; // window length to try
  const revBodies = revoke.map((r) => r[0]).filter((b): b is Uint8Array => b instanceof Uint8Array);

  // intersection of n-grams across ALL revoke bodies
  let common: Set<string> | null = null;
  for (const b of revBodies) {
    const g = ngrams(b, N);
    if (common === null) common = g;
    else {
      for (const x of [...common]) if (!g.has(x)) common.delete(x);
    }
    if (common.size === 0) break;
  }
  console.log(`=== 40800 signature (window ${N}B) ===`);
  console.log(`  n-grams common to ALL ${revBodies.length} revoke bodies: ${common?.size ?? 0}`);

  if (!common || common.size === 0) {
    console.log('  ⚠️ no single common window across all revoke bodies at this length; try smaller N.');
    db.close();
    return;
  }

  // remove any that appear in ANY normal body
  const normalBodies = normal.map((r) => r[0]).filter((b): b is Uint8Array => b instanceof Uint8Array);
  const candidates = [...common];
  const clean: string[] = [];
  for (const c of candidates) {
    const bytes = Buffer.from(c, 'hex');
    let seen = false;
    for (const nb of normalBodies) {
      if (Buffer.from(nb).includes(bytes)) { seen = true; break; }
    }
    if (!seen) clean.push(c);
  }
  console.log(`  of those, ABSENT from all ${normalBodies.length} normal bodies: ${clean.length}`);
  console.log(`\n=== clean signature candidates (present in every recall, no normal) ===`);
  for (const c of clean.slice(0, 20)) console.log(`  X'${c.toUpperCase()}'`);
  if (clean.length === 0) {
    console.log('  ⚠️ none clean at this length — recall shares all 8-grams with some normal msg. Try longer N.');
  } else {
    console.log(`\n✅ use e.g.  WHEN instr(NEW."40800", X'${clean[0]!.toUpperCase()}') > 0`);
  }

  db.close();
}

main().catch((e) => {
  console.error('failed:', e);
  process.exit(1);
});
