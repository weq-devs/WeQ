/**
 * 只读诊断：群聊 anti_recall 触发器为何不命中？
 *
 * 私聊(40021 TEXT)成功、群聊(40027 INTEGER)失败，最大嫌疑是触发器对 INTEGER 的
 * 40027 用了字符串字面量 `IN ('1092701080')`。本脚本直接读真实库求证：
 *   1. 群里已撤回行的 40027 真实存储类（typeof）与值；
 *   2. 手动跑 `40027 IN (数字)` vs `40027 IN ('字符串')` 各命中多少行；
 *   3. 顺带 dump 一个受保护群号，确认它到底存成 int 还是 text。
 *
 * 全是 SELECT，不写库。QQ 开着也能读（WAL）。
 * Run: pnpm tsx packages/db/test/diag_group_filter.ts [groupCode]
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv } from '@weq/testkit';

const KEY = testEnv.key;
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const LIVE = testEnv.msgDbPath;
const GROUP = process.argv[2] ?? '1092701080'; // 配置里第一个受保护群

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, { dbPath: LIVE, key: KEY, algo: ALGO });

  // 1. 该群最新一行的 40027 存储类 + 值
  const t = await db.query(
    `SELECT "40027", typeof("40027"), "40021", typeof("40021")
       FROM group_msg_table WHERE "40027" = ? ORDER BY rowid DESC LIMIT 1`,
    [GROUP],
  );
  console.log(`=== 群 ${GROUP} 最新一行 ===`);
  if (t.length) {
    console.log(`  40027 值=${String(t[0]![0])}  typeof=${String(t[0]![1])}`);
    console.log(`  40021 值=${String(t[0]![2])}  typeof=${String(t[0]![3])}`);
  } else {
    console.log('  （用字符串参数没查到——本身就是信号）');
  }

  // 2. 同一个群，数字 vs 字符串 两种字面量各命中多少
  const numHit = await db.query(
    `SELECT COUNT(*) FROM group_msg_table WHERE "40027" IN (${GROUP})`,
  );
  const strHit = await db.query(
    `SELECT COUNT(*) FROM group_msg_table WHERE "40027" IN ('${GROUP}')`,
  );
  console.log(`\n=== 字面量命中对比（群 ${GROUP}）===`);
  console.log(`  40027 IN (${GROUP})      [数字] → ${String(numHit[0]![0])} 行`);
  console.log(`  40027 IN ('${GROUP}')    [字符串] → ${String(strHit[0]![0])} 行`);

  // 3. 群里已撤回行样本 + 它们的 40027 存储类
  const rev = await db.query(
    `SELECT "40001","40027",typeof("40027"),"40011","40012"
       FROM group_msg_table WHERE "40011"=5 AND "40012"=4 ORDER BY rowid DESC LIMIT 5`,
  );
  console.log(`\n=== 群里已撤回(5/4)样本: ${rev.length} ===`);
  for (const r of rev) {
    console.log(`  msg=${String(r[0])} 40027=${String(r[1])}(${String(r[2])}) type=${String(r[3])}/${String(r[4])}`);
  }

  console.log('\n=== 结论 ===');
  const nh = Number(numHit[0]![0]);
  const sh = Number(strHit[0]![0]);
  if (nh > 0 && sh === 0) {
    console.log('  ❌ 实锤：40027 是 INTEGER，只有数字字面量命中，字符串 IN(\'...\') 命中0行。');
    console.log('     → 群聊触发器必须用数字字面量（去掉引号）。私聊 40021 是 TEXT 所以不受影响。');
  } else if (nh > 0 && sh > 0) {
    console.log('  ⚠️ 两种都命中（类型亲和生效）→ 群失败另有原因，需再查（如撤回改的是别的列）。');
  } else {
    console.log(`  ？ 数字命中${nh} 字符串命中${sh}，需人工判读上面样本。`);
  }

  db.close();
}

main().catch((e) => {
  console.error('failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
