/**
 * One-off: check whether gray-tip (灰条) messages in group 673646675 carry a
 * msgSeq (40003) and whether seqs are in order at the tail of the group.
 *
 * Run:  pnpm tsx packages/db/test/check_graytip_seq.ts [groupCode] [limit]
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv } from '@weq/testkit';

const DB_PATH = testEnv.msgDbPath;
const KEY = testEnv.key;

const GROUP = process.argv[2] ?? '673646675';
const LIMIT = Number(process.argv[3] ?? 20);

function fmt(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Uint8Array) return `<BLOB ${v.byteLength}B>`;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return v.length > 30 ? `${v.slice(0, 30)}…` : v;
  return String(v);
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  // 40001 msgId, 40003 msgSeq, 40011 msgType, 40012 subMsgType,
  // 40020 senderUid, 40050 sendTime, 40800 body
  const rows = await db.query(
    `SELECT "40001","40003","40011","40012","40020","40050","40800"
       FROM group_msg_table
      WHERE "40027" = ?
      ORDER BY "40050" DESC, "40001" DESC
      LIMIT ?`,
    [GROUP, BigInt(LIMIT)],
  );

  console.log(`group ${GROUP} — last ${rows.length} rows (newest first, ordered by sendTime):\n`);
  console.log(
    'msgId'.padEnd(22) +
      'msgSeq(40003)'.padEnd(16) +
      'type(40011)'.padEnd(13) +
      'sub(40012)'.padEnd(12) +
      'sendTime'.padEnd(12) +
      'senderUid'.padEnd(28) +
      'body',
  );
  for (const r of rows) {
    const time = typeof r[5] === 'bigint' ? Number(r[5]) : Number(r[5] ?? 0);
    const iso = time ? new Date(time * 1000).toISOString().slice(5, 19) : '?';
    console.log(
      fmt(r[0]).padEnd(22) +
        fmt(r[1]).padEnd(16) +
        fmt(r[2]).padEnd(13) +
        fmt(r[3]).padEnd(12) +
        iso.padEnd(12) +
        fmt(r[4]).padEnd(28) +
        fmt(r[6]),
    );
  }

  // Also show the same tail ordered by seq, to compare ordering.
  const bySeq = await db.query(
    `SELECT "40001","40003","40011","40050"
       FROM group_msg_table
      WHERE "40027" = ?
      ORDER BY "40003" DESC, "40001" DESC
      LIMIT ?`,
    [GROUP, BigInt(LIMIT)],
  );
  console.log(`\nsame group ordered by msgSeq DESC:`);
  for (const r of bySeq) {
    const time = typeof r[3] === 'bigint' ? Number(r[3]) : Number(r[3] ?? 0);
    const iso = time ? new Date(time * 1000).toISOString().slice(5, 19) : '?';
    console.log(`seq=${fmt(r[1]).padEnd(14)} type=${fmt(r[2]).padEnd(4)} msgId=${fmt(r[0]).padEnd(22)} ${iso}`);
  }

  db.close();
}

main().catch((e) => {
  console.error('failed:', e);
  process.exit(1);
});
