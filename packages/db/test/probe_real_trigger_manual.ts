/**
 * 最后一步隔离：装**真实 AntiRecallDb 生成的 trigger**，然后手动 UPDATE 触发（不靠
 * QQ），立刻查记录表 + 同表灰条落没落地。这是唯一没单独做过的精确复现——把真实
 * trigger 和"手动可控的触发"结合，排除 QQ 那一侧的任何变量。
 *
 * 若这里也失败 → 真凶在真实 trigger 的 body SQL 本身（38列VALUES+blob 在 trigger
 *   编译/执行期的某种限制），可打印生成的 SQL 逐段查。
 * 若这里成功 → 真凶在"QQ 的 UPDATE"和"我们手动 UPDATE"的差异（QQ 可能用了不同的
 *   写法，如 UPDATE OF 特定列、或 QQ 的连接 recursive_triggers 设置不同）。
 *
 * ⚠️ 需关 QQ。用完清理。
 * Run: pnpm tsx packages/db/test/probe_real_trigger_manual.ts [群号]
 */
import { loadNative } from '@weq/native';
import { AntiRecallDb } from '../src/msg/anti_recall';
import { QqDb } from '../src/qq_db';
import { testEnv } from '@weq/testkit';

const KEY = testEnv.key;
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB = testEnv.msgDbPath;
const GROUP = process.argv[2] ?? '673646675';

async function main(): Promise<void> {
  const nt = loadNative();
  if (nt.ntHelper.getQqProcesses().length) { console.error('先关 QQ'); process.exit(1); }
  const db = new QqDb(nt.ntHelper, { dbPath: DB, key: KEY, algo: ALGO });

  try {
    // 1. 用正式 AntiRecallDb 装真实 trigger（含记录表）
    const ar = new AntiRecallDb(nt.ntHelper, { dbPath: DB, key: KEY, algo: ALGO });
    await ar.reconcile([{ kind: 'group', id: GROUP }]);
    ar.close();
    console.log('已装真实 trigger + 记录表');

    // 打印真实 trigger 的 SQL（供出错时逐段查）
    const trigSql = await db.query(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='weq_anti_recall_group'`);
    console.log('\n=== 真实 trigger SQL（前 400 字符）===');
    console.log(String(trigSql[0]?.[0] ?? '(无)').slice(0, 400));

    // 2. 靶子 + 触发前计数
    const tgt = await db.query(`SELECT "40001","40800" FROM group_msg_table WHERE "40027"=? AND "40011"=2 AND "40012"=1 ORDER BY "40003" DESC LIMIT 1`, [BigInt(GROUP)]);
    const mid = tgt[0]![0] as bigint;
    const body = tgt[0]![1] as Uint8Array;
    const logBefore = Number((await db.query(`SELECT COUNT(*) FROM weq_recall_log`))[0]![0]);
    const gtBefore = Number((await db.query(`SELECT COUNT(*) FROM group_msg_table WHERE "40027"=? AND "40011"=5 AND "40012"=17`, [BigInt(GROUP)]))[0]![0]);
    console.log(`\n靶子 msg=${mid}  触发前: 记录表=${logBefore} 灰条(5/17)=${gtBefore}`);

    // 3. 手动触发一次撤回式 UPDATE（改 40800 + 40011/40012→5/4，40002 不动 → 命中 WHEN）
    const fake = Buffer.concat([Buffer.from(body), Buffer.from([0])]);
    let err = '';
    const aff = await db.write(`UPDATE group_msg_table SET "40800"=?, "40011"=5, "40012"=4 WHERE "40001"=?`, [fake, mid]).catch((e) => { err = String(e); return -1; });

    const logAfter = Number((await db.query(`SELECT COUNT(*) FROM weq_recall_log`))[0]![0]);
    const gtAfter = Number((await db.query(`SELECT COUNT(*) FROM group_msg_table WHERE "40027"=? AND "40011"=5 AND "40012"=17`, [BigInt(GROUP)]))[0]![0]);
    const orig = await db.query(`SELECT "40011","40012" FROM group_msg_table WHERE "40001"=?`, [mid]);

    console.log(`\nUPDATE affected=${aff}${err ? ` err=${err}` : ''}`);
    console.log(`拦截: 靶子仍 ${orig[0]![0]}/${orig[0]![1]}  ${String(orig[0]![0])==='2'?'✅':'❌'}`);
    console.log(`记录表: +${logAfter-logBefore} ${logAfter-logBefore===1?'✅':'❌'}`);
    console.log(`补插灰条: +${gtAfter-gtBefore} ${gtAfter-gtBefore===1?'✅':'❌'}`);

    console.log('\n=== 判读 ===');
    if (logAfter-logBefore===1 && gtAfter-gtBefore===1) {
      console.log('  ★手动触发全成功！→ 真凶在"QQ的UPDATE"vs"手动UPDATE"的差异（QQ可能 UPDATE 不同列组合，或没命中 WHEN）。');
      console.log('    下一步：查 QQ 撤回到底改了哪些列（是否真的动 40800，还是先改别的列分两次写）。');
    } else {
      console.log('  ★手动触发也失败 → 真凶在真实 trigger body SQL 本身。对比上面打印的 SQL 与成功的最小版找差异。');
    }

    // 4. 清理
    await new AntiRecallDb(nt.ntHelper, { dbPath: DB, key: KEY, algo: ALGO }).reconcile([]);
    const del = await db.write(`DELETE FROM group_msg_table WHERE "40027"=? AND "40011"=5 AND "40012"=17 AND instr(CAST("40800" AS TEXT),'撤回了一条消息')>0 AND "40050">=strftime('%s','now')-180`, [BigInt(GROUP)]);
    await db.write(`DROP TABLE IF EXISTS weq_recall_log`);
    console.log(`\n(清理: 卸trigger + 删灰条${del}行 + 删记录表)`);
  } finally {
    db.close();
  }
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
