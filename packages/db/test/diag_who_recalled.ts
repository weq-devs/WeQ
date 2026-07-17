/**
 * 只读定位：为什么这次撤回没拦住？
 *   1. 现在库里还有没有 anti-recall trigger（install 装了、cleanup 卸了——现在应为0）
 *   2. 那条 5/4 (msg 7737174878596463872) 是不是"老撤回残留"——它凌晨就被撤过。
 *      如果它现在还是 5/4，说明是历史残留，不是这次的。
 *   3. 这次小号发的消息在哪？按 sender uid 找最近非-H3CoF6 发的消息，看它现状。
 *      （H3CoF6=大号 u_mGIBTBW7gF4Wocw8zapc6w；小号是别的 uid）
 * 全只读。
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const LIVE =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const GROUP = process.argv[2] ?? '673646675';
const BIGUID = 'u_mGIBTBW7gF4Wocw8zapc6w'; // 大号 H3CoF6

async function main(): Promise<void> {
  const nt = loadNative();
  const db = new QqDb(nt.ntHelper, { dbPath: LIVE, key: KEY, algo: ALGO });

  // 1. 现存 trigger
  const trig = await db.query(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'weq_%'`);
  console.log(`=== 现存 weq_ trigger: ${trig.length} ===`);
  for (const t of trig) console.log(`  ${t[0]}`);
  console.log('  （cleanup 后应为 0；若为0，说明"这次撤回"发生时 trigger 状态取决于当时——见下）');

  // 2. 群里所有 5/4（被撤回且未拦住的），按时间
  const revoked = await db.query(
    `SELECT "40001","40020","40050",
            hex(substr("40800", instr("40800", X'c2a517')+4, 24)) AS revoke_uid_hex
       FROM group_msg_table WHERE "40027"=? AND "40011"=5 AND "40012"=4
      ORDER BY rowid DESC LIMIT 10`,
    [BigInt(GROUP)],
  );
  console.log(`\n=== 群里 5/4（撤回成功=没拦住）共列 ${revoked.length} 条 ===`);
  for (const r of revoked) {
    const ruid = typeof r[3] === 'string' && r[3] ? Buffer.from(r[3], 'hex').toString('utf8') : '(无)';
    console.log(`  msg=${r[0]} sender=${r[1]} time=${r[2]} 撤回者=${ruid}`);
  }

  // 3. 小号发的消息（sender != 大号）最近 10 条
  const alt = await db.query(
    `SELECT "40001","40011","40012","40020","40093","40050"
       FROM group_msg_table WHERE "40027"=? AND "40020" <> ? AND "40020" LIKE 'u\\_%' ESCAPE '\\'
      ORDER BY rowid DESC LIMIT 10`,
    [BigInt(GROUP), BIGUID],
  );
  console.log(`\n=== 群里"非大号"发的最近 10 条（含小号）===`);
  for (const r of alt) {
    console.log(`  msg=${r[0]} type=${r[1]}/${r[2]} sender=${r[3]} nick=${r[4] === null ? 'NULL' : JSON.stringify(r[4])} time=${r[5]}`);
  }

  db.close();
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
