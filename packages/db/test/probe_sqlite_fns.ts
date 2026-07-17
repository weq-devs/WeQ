/**
 * 决定性探测：QQ 的 SQLCipher 支不支持 unhex() / printf()？
 *
 * 这决定 "SQL 拼 tipJson 灰条" 的优雅度：
 *  - 若支持 unhex()，则所有二进制字节(tag、两层长度前缀 varint)都能用
 *    unhex('十六进制串') 干净生成，彻底绕开 char() 的 UTF-8 膨胀坑；
 *    动态长度前缀可用 unhex(printf('%02x%02x', b0, b1)) 生成。
 *  - 若不支持，则退回"固定长度 tipJson / 预生成常量 blob"方案。
 *
 * 全是常量 SELECT，不建表、不写数据，QQ 开着也能跑(WAL 读)。
 * Run: pnpm tsx packages/db/test/probe_sqlite_fns.ts
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;

const J = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

async function main(): Promise<void> {
  const nt = loadNative();
  const db = new QqDb(nt.ntHelper, { dbPath: DB, key: KEY, algo: ALGO });

  const tries: Array<[string, string]> = [
    ['sqlite_version', `SELECT sqlite_version()`],
    ['unhex 基础', `SELECT typeof(unhex('85037b22')), hex(unhex('85037b22')), length(unhex('85037b22'))`],
    ['printf %02x', `SELECT printf('%02x', 133)`],
    ['printf+unhex 生成varint 85 03', `SELECT hex(unhex(printf('%02x%02x', 133, 3)))`],
    ['unhex||unhex 拼接保 blob', `SELECT typeof(unhex('fac817') || unhex('8503')), hex(unhex('fac817') || unhex('8503')), length(unhex('fac817') || unhex('8503'))`],
    ['unhex + uid(text) 拼接', `SELECT hex(unhex('baa51718') || CAST('u_mGIBTBW7gF4Wocw8zapc6w' AS BLOB))`],
    ['整段外层CAST', `SELECT typeof(CAST(unhex('82f613') || unhex('8503') || CAST('{"a":1}' AS BLOB) AS BLOB)), length(CAST(unhex('82f613') || unhex('8503') || CAST('{"a":1}' AS BLOB) AS BLOB))`],
    // 动态：给定内容长度 L，算 2字节 varint 前缀（L<16384）
    ['动态varint(L=389)', `SELECT hex(unhex(printf('%02x%02x', (389 & 127)|128, (389>>7)&127)))`],
  ];

  for (const [name, sql] of tries) {
    try {
      const r = await db.query(sql);
      console.log(`[OK]   ${name}\n         → ${J(r[0])}`);
    } catch (e) {
      console.log(`[FAIL] ${name}\n         → ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log('\n=== 判读 ===');
  console.log('  · unhex 基础 期望: blob / 85037B22 / 4');
  console.log('  · printf+unhex 生成varint 期望: 8503');
  console.log('  · 动态varint(L=389) 期望: 8503  ← 若对，则任意长度前缀都能 SQL 现算！');
  console.log('  · 全 OK → 🎉 SQL 拼 tipJson 灰条(含动态 uin/nick/seq + 动态长度)完全可行。');

  db.close();
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
