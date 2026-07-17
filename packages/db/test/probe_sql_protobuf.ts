/**
 * 地基验证：SQLite 能否在 SQL 层安全拼接 protobuf blob？
 * 决定"trigger 里 format 替换拼灰条"这条路可不可行。全是常量 SELECT，不碰表。
 *
 * 逐个回答：
 *  1. blob || blob 结果还是 blob 吗？含 0x00 会不会被截断/转 text？
 *  2. text 列的 uid 用 CAST(... AS BLOB) 嵌进去，字节对不对？
 *  3. uid 字节长度是否真的固定（决定 length 是否可当常量）？
 *  4. char() 能否生成任意字节做 varint？（char(0) 能出 0x00 吗）
 *  5. 一个"最小灰条"protobuf 手工拼出来，hex 对不对？
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

  const q1 = async (sql: string): Promise<unknown[]> => (await db.query(sql))[0]!;

  console.log('=== 1. blob||blob 是否保持 blob、含 0x00 是否完整 ===');
  const r1 = await q1(`SELECT typeof(X'0a0100ff' || X'000102'), hex(X'0a0100ff' || X'000102'), length(X'0a0100ff' || X'000102')`);
  console.log(`   typeof=${r1[0]}  hex=${r1[1]}  length=${r1[2]}  (期望 blob / 0A0100FF000102 / 7)`);

  console.log('\n=== 2. text uid 用 CAST(AS BLOB) 嵌入 ===');
  const r2 = await q1(`SELECT typeof(X'0a' || CAST('u_mGIBTBW7gF4Wocw8zapc6w' AS BLOB)), hex(X'0a' || CAST('u_mGIBTBW7gF4Wocw8zapc6w' AS BLOB))`);
  console.log(`   typeof=${r2[0]}`);
  console.log(`   hex=${r2[1]}`);

  console.log('\n=== 3. uid 字节长度是否固定 ===');
  const r3 = await db.query(
    `SELECT DISTINCT length(CAST("40020" AS BLOB)) AS L, COUNT(*) AS c
       FROM group_msg_table WHERE "40020" LIKE 'u\\_%' ESCAPE '\\' GROUP BY L ORDER BY c DESC LIMIT 10`,
  );
  console.log('   uid 字节长度分布 (length -> 行数):');
  for (const r of r3) console.log(`     ${r[0]}B -> ${r[1]} 行`);

  console.log('\n=== 4. char() 能否生成任意字节（varint 用）===');
  const r4 = await q1(`SELECT typeof(char(10)), hex(char(10)), hex(char(0)), hex(char(200))`);
  console.log(`   typeof(char(10))=${r4[0]}  hex(char(10))=${r4[1]}  hex(char(0))=${r4[2]}  hex(char(200))=${r4[3]}`);
  console.log('   注意：char() 返回 TEXT(UTF-8)，char(0) 可能出空串或被截；char(200) 会 UTF-8 编码成 2 字节，不是裸 0xC8！');

  console.log('\n=== 5. 手工拼一个最小片段：field#47703(uid) 的 wire ===');
  // tag = (47703<<3)|2 = 381626 -> varint。len=24。这里演示"若 uid 定长则全常量"。
  // 47703 tag varint: 381626 = 0x5D2FA -> varint bytes: FA A5 17
  const r5 = await q1(`SELECT hex(X'FAA517' || char(24) || CAST('u_mGIBTBW7gF4Wocw8zapc6w' AS BLOB))`);
  console.log(`   hex=${r5[0]}`);
  console.log('   ← 若 char(24) 正确出 0x18，且尾部是 uid 的 ascii，则定长 uid 全常量拼接可行。');

  db.close();
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
