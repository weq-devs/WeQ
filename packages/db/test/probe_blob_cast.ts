/**
 * 决定性验证：最外层 CAST(... AS BLOB) 能否让含 0x00 的 || 拼接结果完整存为 blob，
 * 不被 text 阶段截断？这是"SQL 拼 protobuf 写进 40800"可行性的最后一道关卡。
 *
 * 做法：在临时表里真的 INSERT 一个拼接表达式到 BLOB 列，再读回 hex/length，
 * 看 0x00 后面的字节还在不在。用一张我们自己的临时表，不碰 QQ 数据。
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv } from '@weq/testkit';

const KEY = testEnv.key;
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB = testEnv.msgDbPath;

async function main(): Promise<void> {
  const nt = loadNative();
  const db = new QqDb(nt.ntHelper, { dbPath: DB, key: KEY, algo: ALGO });

  try {
    await db.write(`CREATE TABLE IF NOT EXISTS weq_blobtest (id INTEGER PRIMARY KEY, b BLOB)`);
    await db.write(`DELETE FROM weq_blobtest`);

    // A: 直接拼接（不 CAST），存进 BLOB 列
    await db.write(`INSERT INTO weq_blobtest(id,b) VALUES (1, X'0a0100ff' || X'000102')`);
    // B: 最外层 CAST AS BLOB
    await db.write(`INSERT INTO weq_blobtest(id,b) VALUES (2, CAST(X'0a0100ff' || X'000102' AS BLOB))`);
    // C: 含 uid 的真实场景，最外层 CAST
    await db.write(
      `INSERT INTO weq_blobtest(id,b) VALUES (3, CAST(X'FAA51718' || CAST('u_mGIBTBW7gF4Wocw8zapc6w' AS BLOB) || X'0000' AS BLOB))`,
    );

    const rows = await db.query(`SELECT id, typeof(b), length(b), hex(b) FROM weq_blobtest ORDER BY id`);
    for (const r of rows) {
      console.log(`id=${r[0]}  typeof=${r[1]}  length=${r[2]}`);
      console.log(`   hex=${r[3]}`);
    }
    console.log('\n=== 判读 ===');
    console.log('  期望：id=1 可能 length=2(被截) ; id=2/3 typeof=blob 且 length 完整(0x00 后字节都在)。');
    console.log('  id=2 期望 length=7 hex=0A0100FF000102');
    console.log('  id=3 期望 length=4+24+2=30, 末尾是 ...0000, 中段是 uid ascii。');
    console.log('  若 id=2/3 完整 → ✅ 外层 CAST 是可行方案；否则 SQL 拼 protobuf 此路不通。');

    // 清理
    await db.write(`DROP TABLE IF EXISTS weq_blobtest`);
    console.log('\n(已清理临时表 weq_blobtest)');
  } finally {
    db.close();
  }
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
