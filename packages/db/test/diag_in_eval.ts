/**
 * 只读：直接在 QQ 库上，用那条真实撤回行(40027=673646675, INTEGER)求值触发器 WHEN
 * 里会用到的比较表达式，看 `40027 IN ('字符串')` 到底算 true 还是 false。
 * 触发器 WHEN 的求值语义 = 对该行做标量表达式求值，等价于 SELECT 里对同一行取 CASE。
 * 全 SELECT，不建库不写库。
 * Run: pnpm tsx packages/db/test/diag_in_eval.ts [msgId]
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv } from '@weq/testkit';

const KEY = testEnv.key;
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const LIVE = testEnv.msgDbPath;
const MSG = process.argv[2] ?? '7663237640482557798';

async function main(): Promise<void> {
  const nt = loadNative();
  const db = new QqDb(nt.ntHelper, { dbPath: LIVE, key: KEY, algo: ALGO });

  // 对目标撤回行，逐个求值触发器 WHEN 会用到的表达式
  const q = await db.query(
    `SELECT
       "40027",
       typeof("40027"),
       ("40027" IN (673646675)),
       ("40027" IN ('673646675')),
       ("40021" IN ('u_mGIBTBW7gF4Wocw8zapc6w')),
       ("40011"=5 AND "40012"=4)
     FROM group_msg_table WHERE "40001" = ?`,
    [BigInt(MSG)],
  );
  if (!q.length) { console.log('没找到该 msgId'); db.close(); return; }
  const r = q[0]!;
  console.log(`=== 群撤回行 msg ${MSG} 上，触发器 WHEN 各表达式求值 ===`);
  console.log(`  40027 值=${String(r[0])}  typeof=${String(r[1])}`);
  console.log(`  40027 IN (673646675)     [数字] → ${String(r[2])}  ${Number(r[2])===1?'✅true':'❌false'}`);
  console.log(`  40027 IN ('673646675')   [字符串] → ${String(r[3])}  ${Number(r[3])===1?'✅true':'❌false'}  ← 我们触发器实际用的写法`);
  console.log(`  40021 IN ('u_...')       [TEXT对照] → ${String(r[4])}  ${Number(r[4])===1?'✅true':'❌false'}`);
  console.log(`  40011=5 AND 40012=4      → ${String(r[5])}`);

  console.log('\n=== 结论 ===');
  if (Number(r[3]) === 1) {
    console.log('  字符串字面量在这行也求值为 true → IN 写法不是根因。触发器没拦=连接没加载触发器。');
  } else {
    console.log('  ❌ 字符串字面量求值为 false → 群触发器 IN(\'123\') 匹配不上 INTEGER 列，根因确认！去掉引号即可。');
  }
  db.close();
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
