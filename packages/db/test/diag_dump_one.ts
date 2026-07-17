/**
 * 只读：按 msgId 完整 dump 一条消息的全部列 + rowid + 40800 解码。
 * 用于撤回前/后对比。全 SELECT，不写库。
 * Run: pnpm tsx packages/db/test/diag_dump_one.ts <msgId> [table]
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { decodeBody } from '../src/msg/util';

const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const LIVE =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;

const MSG_ID = BigInt(process.argv[2] ?? '0');
const TABLES = process.argv[3] ? [process.argv[3]] : ['group_msg_table', 'c2c_msg_table', 'dataline_msg_table'];

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const fmt = (v: unknown) => (v instanceof Uint8Array ? `<BLOB ${v.byteLength}B>` : v === null ? 'NULL' : String(v));

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, { dbPath: LIVE, key: KEY, algo: ALGO });

  for (const table of TABLES) {
    let info;
    try { info = await db.query(`PRAGMA table_info("${table}")`); } catch { continue; }
    if (!info.length) continue;
    const cols = info.map((r) => String(r[1]));
    const sel = cols.map((c) => `"${c}"`).join(',');
    const rows = await db.query(
      `SELECT rowid, ${sel} FROM ${table} WHERE "40001" = ? LIMIT 1`,
      [MSG_ID],
    );
    if (!rows.length) continue;

    const row = rows[0]!;
    console.log(`\n████████ 在 ${table} 找到 msgId ${MSG_ID} ████████`);
    console.log(`  rowid = ${fmt(row[0])}   ← 撤回后若变=INSERT新行(触发器不fire)`);
    let bodyIdx = -1;
    cols.forEach((name, i) => {
      const v = row[i + 1];
      if (name === '40800') { bodyIdx = i + 1; }
      console.log(`  ${name.padEnd(8)} = ${fmt(v)}`);
    });
    if (bodyIdx >= 0) {
      console.log('\n  40800 解码:');
      console.log(json(decodeBody(row[bodyIdx])).split('\n').map((l) => '    ' + l).join('\n'));
    }
    // 顺带记录：该会话(同分区)当前最大 rowid，撤回后可看是否新增行
    const part = table === 'group_msg_table' ? '40027' : '40021';
    const key = row[cols.indexOf(part) + 1];
    const mx = await db.query(`SELECT MAX(rowid), COUNT(*) FROM ${table} WHERE "${part}" = ?`, [key as never]);
    console.log(`\n  [该会话 ${part}=${fmt(key)}] 当前 MAX(rowid)=${fmt(mx[0]![0])} 总行数=${fmt(mx[0]![1])}`);
    db.close();
    return;
  }

  console.log(`⚠️ 三张表都没找到 msgId ${MSG_ID}`);
  db.close();
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
