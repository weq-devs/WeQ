/**
 * 只读诊断：找「卸载防撤回后没卸干净」的坏行 —— body(40800) 已是撤回灰条(首元素=8
 * 或含 baa517/c2a517)，但类型列(40011/40012)还停在原消息值(非 5/4、非 5/17)。这类
 * 行处于「半拦截」矛盾态：内容被改写、类型没跟上，UI 可能显示原文没了但又不标撤回。
 *
 * 目的：搞清是哪一步留下的、有多少、能否用 orig_body(记录表) 或类型回填修复。只读。
 *
 * 用法：pnpm tsx packages/db/test/diag_half_recall.ts [group|c2c]
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv } from '@weq/testkit';

const KEY = testEnv.key;
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB = testEnv.msgDbPath;

const ETYPE = `hex(substr("40800", instr("40800", X'd0fc15') + 3, 1))`;
const IS_GRAY = `(instr("40800", X'd0fc15') > 0 AND ${ETYPE} = '08')`;
const HAS_OP = `(instr("40800", X'baa517') > 0)`;      // 操作者字段
const HAS_SND = `(instr("40800", X'c2a517') > 0)`;     // 原发送者字段
const IS_54 = `("40011"=5 AND "40012"=4)`;
const IS_517 = `("40011"=5 AND "40012"=17)`;           // WeQ 补插灰条

async function run(kind: string): Promise<void> {
  const table = kind === 'c2c' ? 'c2c_msg_table' : 'group_msg_table';
  const db = new QqDb(loadNative().ntHelper, { dbPath: DB, key: KEY, algo: ALGO });
  try {
    console.log(`\n### ${table} —— 半拦截矛盾行诊断`);

    // 矛盾态①：body 是撤回灰条（含操作者字段），但类型不是 5/4 也不是 5/17
    const contradict = `${HAS_OP} AND NOT ${IS_54} AND NOT ${IS_517}`;
    const n1 = Number((await db.query(`SELECT COUNT(*) FROM ${table} WHERE ${contradict}`).catch(() => [[0]]))[0]?.[0] ?? 0);
    console.log(`  ① body含操作者(baa517) 但 type 非5/4 非5/17 : ${n1}  ← 你说的“删了800没改类型”的候选`);

    // 矛盾态②：首元素=8 灰条，但类型是普通消息类型（2/1、9/33…）且不含撤回字段
    const grayNoType = `${IS_GRAY} AND NOT ${IS_54} AND NOT ${IS_517} AND NOT ${HAS_OP} AND NOT ${HAS_SND}`;
    const n2 = Number((await db.query(`SELECT COUNT(*) FROM ${table} WHERE ${grayNoType}`).catch(() => [[0]]))[0]?.[0] ?? 0);
    console.log(`  ② 首元素=8 但无撤回字段且type普通 : ${n2}  ← 灰条壳但不是撤回(占位空/其它?)`);

    // 类型分布：所有 body 含操作者字段的行，按类型看落在哪
    console.log(`\n  body 含操作者字段(baa517) 的行，按 type 分布:`);
    const dist = await db.query(
      `SELECT "40011","40012",COUNT(*),
        SUM(CASE WHEN ${IS_GRAY} THEN 1 ELSE 0 END)
       FROM ${table} WHERE ${HAS_OP}
       GROUP BY "40011","40012" ORDER BY COUNT(*) DESC LIMIT 15`).catch(() => []);
    for (const r of dist) console.log(`    ${r[0]}/${r[1]}  × ${Number(r[2]).toLocaleString()}  (其中首元素=8: ${r[3]})`);

    // 抽样：矛盾态① 的具体行
    if (n1 > 0) {
      console.log(`\n  矛盾态① 抽样:`);
      const s = await db.query(
        `SELECT "40001","40011","40012",${ETYPE},length("40800"),
          CAST("40020" AS TEXT),
          hex(substr("40800",1,32))
         FROM ${table} WHERE ${contradict} LIMIT 8`).catch(() => []);
      for (const r of s) console.log(`    msg=${r[0]} type=${r[1]}/${r[2]} etype=${r[3]} blen=${r[4]} author=${String(r[5]).slice(0,20)} head=${String(r[6]).slice(0,28)}…`);
    }

    // 记录表里是否有这些行的 orig_body（能否恢复原文）
    const logExists = (await db.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='weq_recall_log' LIMIT 1`).catch(() => [])).length > 0;
    if (logExists) {
      const withOrig = Number((await db.query(
        `SELECT COUNT(*) FROM ${table} t JOIN weq_recall_log l ON l.msgid=t."40001"
         WHERE t.${contradict} AND l.orig_body IS NOT NULL`).catch(() => [[0]]))[0]?.[0] ?? 0);
      console.log(`\n  矛盾态① 中在 weq_recall_log 有 orig_body 可恢复的: ${withOrig}/${n1}`);
    } else {
      console.log(`\n  （weq_recall_log 不存在或已清空，无法用 orig_body 恢复；只能靠 QQ 重新 backfill）`);
    }
  } finally {
    db.close();
  }
}

run(process.argv[2] === 'c2c' ? 'c2c' : 'group').catch((e) => {
  console.error('failed:', e instanceof Error ? e.message : e); process.exit(1);
});
