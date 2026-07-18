/**
 * One-off write: set msgSeq (40003) = 9999 on the gray-tip message
 * 7737024164892267232 in group 673646675, leaving 40008 untouched.
 * Then re-read to confirm. Used to observe how QQ renders a seq-clash灰条.
 *
 * ⚠️ Writes QQ's live nt_msg.db — run with QQ FULLY CLOSED. Back up first.
 *
 * Run:  pnpm tsx packages/db/test/hack_graytip_seq.ts
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';

const MSG_ID = 7737024164892267232n;
const _NEW_SEQ = 9999n;

function fmt(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Uint8Array) return `<BLOB ${v.byteLength}B>`;
  return String(v);
}

async function readRow(db: QqDb, label: string): Promise<void> {
  const rows = await db.query(
    `SELECT "40001","40003","40008","40050","40058","40011","40012","40020"
       FROM group_msg_table WHERE "40001" = ? LIMIT 1`,
    [MSG_ID],
  );
  if (!rows.length) {
    console.log(`[${label}] row NOT FOUND`);
    return;
  }
  const r = rows[0]!;
  const t = Number(r[3]);
  const iso = t ? new Date(t * 1000).toISOString() : '?';
  console.log(
    `[${label}] seq(40003)=${fmt(r[1])} local(40008)=${fmt(r[2])} ` +
      `sendTime(40050)=${fmt(r[3])} (${iso}) day(40058)=${fmt(r[4])} ` +
      `type=${fmt(r[5])} sub=${fmt(r[6])}`,
  );
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  await readRow(db, 'before');

  // Extreme future: 2099-01-01 00:00:00 UTC = 4070908800. See if QQ still renders it.
  const future = 4070908800n;
  const dayStart = 4070908800n;
  const affected = await db.write(
    `UPDATE group_msg_table SET "40003" = ?, "40008" = ?, "40050" = ?, "40058" = ? WHERE "40001" = ?`,
    [9999n, 9999n, future, dayStart, MSG_ID],
  );
  console.log(`UPDATE affected ${affected} row(s) — sendTime→${future} (${new Date(Number(future) * 1000).toISOString()})`);

  await readRow(db, 'after ');
  db.close();
}

main().catch((e) => {
  console.error('failed:', e);
  process.exit(1);
});
