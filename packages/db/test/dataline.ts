/**
 * Inspection dump for `dataline_msg_table` — QQ's cross-device sync messages
 * (「我的手机」/「我的电脑」/「我的平板」). Structurally this table looks identical to
 * `c2c_msg_table`; this test confirms that and surfaces the special device uids
 * so we can wire a dataline read path (mirroring C2cMsgDb).
 *
 * Known device uids (from QQ NT):
 *   DATALINE_PAD_UID   = u_l7jpPIZxQo0mzJwoEt-SKw
 *   DATALINE_PC_UID    = u_rK7NMsbv2ZjEGPdCuOiCfw
 *   DATALINE_PHONE_UID = u_Wcc5rknRRqRO8y5gxMD6sA
 *
 * Convention (per product decision): treat the *PC* as "self" — messages whose
 * senderUid = DATALINE_PC_UID are ours; the other device is the peer.
 *
 * Run:  pnpm --filter @weq/db test:dataline
 *
 * Requires `native/win32/x64/nt_helper.node` + the dev account credentials
 * (or WEQ_TEST_DB_PATH / WEQ_TEST_DB_KEY env vars).
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { decodeBody, toBigint, toStr } from '../src/msg/util';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';

const TABLE = 'dataline_msg_table';

// Same subset C2cMsgDb reads — verify these columns exist & carry the same data.
const SELECT_COLUMNS = `"40001","40020","40021","40030","40033","40050","40800","40003"`;

function describe(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (v instanceof Uint8Array) return `<BLOB ${v.byteLength} bytes>`;
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'string') return v.length > 120 ? `${v.slice(0, 120)}… (${v.length} chars)` : v;
  return String(v);
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  console.log(`[dataline] opening ${DB_PATH}\n`);

  // 1) schema — compare against c2c_msg_table's column map.
  const info = await db.query(`PRAGMA table_info("${TABLE}")`);
  console.log(`================ ${TABLE} — columns (${info.length}) ================`);
  for (const row of info) {
    // PRAGMA table_info → [cid, name, type, notnull, dflt_value, pk]
    console.log(`  ${String(row[1]).padEnd(8)} ${String(row[2] || '').padEnd(10)} pk=${row[5]}`);
  }

  // 2) how many rows, and the distinct (targetUid, senderUid) pairs — reveals
  //    which device uids appear and which side is "us".
  const total = await db.query(`SELECT COUNT(*) FROM "${TABLE}"`);
  console.log(`\ntotal rows: ${describe(total[0]?.[0])}`);

  const pairs = await db.query(
    `SELECT "40021" AS targetUid, "40020" AS senderUid, COUNT(*) AS n
       FROM "${TABLE}"
       GROUP BY "40021", "40020"
       ORDER BY n DESC`,
  );
  console.log(`\ntargetUid × senderUid distribution:`);
  for (const r of pairs) {
    console.log(`  target=${toStr(r[0]).padEnd(26)} sender=${toStr(r[1]).padEnd(26)} n=${describe(r[2])}`);
  }

  // 3) a few decoded recent rows — confirm 40800 decodes like c2c.
  const rows = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM "${TABLE}" ORDER BY "40050" DESC LIMIT 10`,
  );
  const decoded = rows.map((row) => ({
    msgId: toBigint(row[0]),
    senderUid: toStr(row[1]),
    targetUid: toStr(row[2]),
    targetUin: toBigint(row[3]),
    senderUin: toBigint(row[4]),
    sendTime: toBigint(row[5]),
    elements: decodeBody(row[6]),
    msgSeq: toBigint(row[7]),
  }));
  console.log(`\nrecent ${decoded.length} rows (decoded):`);
  console.log(JSON.stringify(decoded, bigintReplacer, 2));

  db.close();
}

main().catch((e) => {
  console.error('[dataline] failed:', e);
  process.exit(1);
});
