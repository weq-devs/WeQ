/**
 * 核对：group / c2c 表里，撤回一条消息时能从 OLD 拿到的「原发送者」标量列。
 * 决定 tipJson 灰条的 uin/nick、以及 weq_recall_log 记录表各列取哪。
 *
 * 打印几条真实（非撤回）消息的关键列，确认：
 *   40020 senderUid / 40033 senderUin / 40093 senderNick / 40003 seq / 40050 sendTime
 *   group: 40027 群号 ; c2c: 40021 peerUid, 40030 peerUin
 * 只读。
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;

async function main(): Promise<void> {
  const nt = loadNative();
  const db = new QqDb(nt.ntHelper, { dbPath: DB, key: KEY, algo: ALGO });

  for (const [table, cols] of [
    ['group_msg_table', `"40001","40027","40020","40033","40093","40003","40050"`],
    ['c2c_msg_table', `"40001","40021","40030","40020","40033","40093","40003","40050"`],
  ] as const) {
    const rows = await db.query(
      `SELECT ${cols} FROM ${table} WHERE "40011"=2 AND "40093" IS NOT NULL ORDER BY rowid DESC LIMIT 3`,
    );
    console.log(`\n=== ${table} (最近3条普通文本) ===`);
    console.log(`   列: ${cols}`);
    for (const r of rows) console.log('   ', JSON.stringify(r.map((v) => (typeof v === 'bigint' ? v.toString() : v))));
  }

  db.close();
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
