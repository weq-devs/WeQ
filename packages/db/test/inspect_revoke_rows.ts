/**
 * Inspect the 5/4 (revoke) rows in detail: after QQ rewrites a message into a
 * revoke gray-tip, what survives in the scalar columns and what does the 40800
 * body now decode to? This tells us:
 *   - whether the original sender/time/seq is still recoverable post-revoke
 *   - the exact grayTipRevoke element shape (who revoked, display text)
 *
 * Run:  pnpm tsx packages/db/test/inspect_revoke_rows.ts [table] [n]
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { decodeBody } from '../src/msg/util';
import { testEnv } from '@weq/testkit';

const DB_PATH = testEnv.msgDbPath;
const KEY = testEnv.key;
const TABLE = process.argv[2] ?? 'group_msg_table';
const N = Number(process.argv[3] ?? 4);

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  // full column list so we can see everything the revoke left behind
  const info = await db.query(`PRAGMA table_info("${TABLE}")`);
  const cols = info.map((r) => `"${String(r[1])}"`).join(',');

  const rows = await db.query(
    `SELECT ${cols} FROM ${TABLE} WHERE "40011" = 5 AND "40012" = 4
      ORDER BY rowid DESC LIMIT ?`,
    [BigInt(N)],
  );

  console.log(`[inspect] ${TABLE}: ${rows.length} revoke (5/4) rows\n`);

  for (const row of rows) {
    console.log('════════════════════════════════════════');
    info.forEach((r, i) => {
      const name = String(r[1]);
      const v = row[i];
      if (v === null || v === undefined) return; // skip nulls to cut noise
      if (name === '40800') return; // handled below
      const disp =
        v instanceof Uint8Array
          ? `<BLOB ${v.byteLength}B>`
          : typeof v === 'string' && v.length > 60
            ? `${v.slice(0, 60)}…`
            : String(v);
      console.log(`  ${name.padEnd(8)} = ${disp}`);
    });
    const blob = row[info.findIndex((r) => String(r[1]) === '40800')];
    console.log('  40800 decoded elements:');
    console.log(json(decodeBody(blob)).split('\n').map((l) => `    ${l}`).join('\n'));
  }

  db.close();
}

main().catch((e) => {
  console.error('[inspect] failed:', e);
  process.exit(1);
});
