/**
 * Read-only inspection of the QQ 游戏中心 account across every table we plan to
 * fabricate a fake account into. Prints all columns of each matching row (BLOBs
 * as byte-length + hex head), and decodes the c2c ark message body so we know
 * the exact shape to imitate.
 *
 *   nt_msg.db       : c2c_msg_table, nt_uid_mapping_table, recent_contact_v3_table
 *   profile_info.db : profile_info_v6, profile_info_public_account
 *
 * Run:  pnpm --filter @weq/db test:inspect-game-center
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { ProtoMsg } from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { decodeElement } from '@weq/codec';
import { testEnv } from '@weq/testkit';

const KEY = testEnv.key;
const MSG_DB_PATH = testEnv.msgDbPath;
const PROFILE_DB_PATH = testEnv.profileDbPath;

const TARGET_UID = 'u_-PBswiplK-7J7bmaQLA-mA';

const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;

const bodyCodec = new ProtoMsg(MsgBody);

function describe(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v.slice(0, 64)).toString('hex');
    return `<BLOB ${v.byteLength} bytes> ${hex}${v.byteLength > 64 ? '…' : ''}`;
  }
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'string') return v.length > 200 ? `${v.slice(0, 200)}… (${v.length} chars)` : `"${v}"`;
  return `${String(v)} (${typeof v})`;
}

/** Dump every column of every matching row for one table. */
async function dumpRows(db: QqDb, table: string, whereCol: string, whereVal: string, limit = 3): Promise<void> {
  const info = await db.query(`PRAGMA table_info("${table}")`);
  const cols = info.map((r) => String(r[1]));
  console.log(`\n================ ${table} — WHERE "${whereCol}" = ${String(whereVal)} ================`);
  console.log(`(schema: ${cols.length} columns)`);
  let rows: Awaited<ReturnType<QqDb['query']>>;
  try {
    rows = await db.query(`SELECT * FROM "${table}" WHERE "${whereCol}" = ? LIMIT ?`, [whereVal, BigInt(limit)]);
  } catch (e) {
    console.log(`  !! query failed: ${(e as Error).message}`);
    return;
  }
  console.log(`matched rows: ${rows.length}`);
  rows.forEach((row, ri) => {
    console.log(`\n--- row ${ri} ---`);
    row.forEach((val, i) => {
      console.log(`  ${(cols[i] ?? `#${i}`).padEnd(10)} = ${describe(val)}`);
    });
  });
}

async function main(): Promise<void> {
  const native = loadNative();

  // ---------- nt_msg.db ----------
  const msgDb = new QqDb(native.ntHelper, { dbPath: MSG_DB_PATH, key: KEY, algo: ALGO });
  console.log(`[inspect] opening ${MSG_DB_PATH}`);

  // nt_uid_mapping_table — resolve uid → sortNo/uin.
  await dumpRows(msgDb, 'nt_uid_mapping_table', '48902', TARGET_UID);

  // recent_contact_v3_table — keyed by 40021 (targetUid).
  await dumpRows(msgDb, 'recent_contact_v3_table', '40021', TARGET_UID);

  // c2c_msg_table — keyed by 40021 (targetUid). Then decode the last ark body.
  await dumpRows(msgDb, 'c2c_msg_table', '40021', TARGET_UID, 2);

  console.log(`\n================ c2c ark body decode ================`);
  const arkRows = await msgDb.query(
    `SELECT "40001","40011","40800" FROM c2c_msg_table WHERE "40021" = ? ORDER BY "40003" DESC LIMIT 5`,
    [TARGET_UID],
  );
  for (const r of arkRows) {
    const msgId = r[0];
    const msgType = r[1];
    const blob = r[2];
    if (!(blob instanceof Uint8Array)) continue;
    try {
      const decoded = bodyCodec.decode(blob);
      const els = (decoded.elements ?? []).map(decodeElement);
      const kinds = els.map((e) => e.kind).join(',');
      console.log(`\nmsgId=${msgId} msgType=${msgType} elementKinds=[${kinds}]`);
      for (const el of els) {
        if (el.kind === 'ark') {
          console.log(`  ark.arkData (${el.arkData.length} chars):`);
          try {
            console.log(JSON.stringify(JSON.parse(el.arkData), null, 2));
          } catch {
            console.log(`  (not JSON) ${el.arkData}`);
          }
        }
      }
    } catch (e) {
      console.log(`  decode failed for msgId=${msgId}: ${(e as Error).message}`);
    }
  }

  msgDb.close();

  // ---------- profile_info.db ----------
  const profileDb = new QqDb(native.ntHelper, { dbPath: PROFILE_DB_PATH, key: KEY, algo: ALGO });
  console.log(`\n\n[inspect] opening ${PROFILE_DB_PATH}`);

  await dumpRows(profileDb, 'profile_info_v6', '1000', TARGET_UID);

  // profile_info_public_account — unknown schema; probe common uid columns.
  console.log(`\n================ profile_info_public_account — schema probe ================`);
  try {
    const info = await profileDb.query(`PRAGMA table_info("profile_info_public_account")`);
    const cols = info.map((r) => String(r[1]));
    console.log(`columns (${cols.length}): ${cols.join(', ')}`);
    // Try the same 1000 uid column first, then fall back to dumping a couple rows.
    let matched = false;
    for (const c of ['1000', '1002']) {
      if (!cols.includes(c)) continue;
      const rows = await profileDb.query(
        `SELECT * FROM "profile_info_public_account" WHERE "${c}" = ? LIMIT 3`,
        [TARGET_UID],
      );
      if (rows.length > 0) {
        matched = true;
        console.log(`\nmatched on column ${c}: ${rows.length} rows`);
        rows.forEach((row, ri) => {
          console.log(`\n--- row ${ri} ---`);
          row.forEach((val, i) => {
            console.log(`  ${(cols[i] ?? `#${i}`).padEnd(10)} = ${describe(val)}`);
          });
        });
      }
    }
    if (!matched) {
      console.log(`\nno row matched TARGET_UID; dumping first 2 rows as a shape sample:`);
      const rows = await profileDb.query(`SELECT * FROM "profile_info_public_account" LIMIT 2`);
      rows.forEach((row, ri) => {
        console.log(`\n--- sample row ${ri} ---`);
        row.forEach((val, i) => {
          console.log(`  ${(cols[i] ?? `#${i}`).padEnd(10)} = ${describe(val)}`);
        });
      });
    }
  } catch (e) {
    console.log(`  !! profile_info_public_account not accessible: ${(e as Error).message}`);
  }

  profileDb.close();
}

main().catch((e) => {
  console.error('[inspect] failed:', e);
  process.exit(1);
});
