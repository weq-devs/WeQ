/**
 * 验证方案 B：用 AFTER UPDATE trigger 代替 BEFORE+RAISE(IGNORE)。
 * 已证明：BEFORE+RAISE 在 QQ 多语句事务里会把补插 INSERT 一起废掉。
 *
 * 方案 B：AFTER UPDATE 里
 *   ① INSERT 记录表  ② INSERT 补插灰条  ③ UPDATE 把被撤消息改回 OLD 原文
 * 不用 RAISE，所以 INSERT 能落地；③ 用 AFTER 时 OLD.40800=撤回前原文，还原消息。
 *
 * 递归控制：③ 的 UPDATE 会再次触发本 trigger。靠 WHEN 判据天然终止——改回后
 * body=原文，"NEW.40800 IS NOT OLD.40800" 为假，不再 fire。本脚本验证这个是否成立、
 * 以及 QQ 式 3 连击 UPDATE 下最终：原文保住 + 记录1 + 灰条1。
 *
 * ⚠️ 需关 QQ。手动模拟 3 连击撤回。用完清理。
 * Run: pnpm tsx packages/db/test/probe_after_trigger.ts [群号]
 */
import { loadNative } from '@weq/native';
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
  const TRIG = 'weq_after_probe';

  try {
    await db.write(`CREATE TABLE IF NOT EXISTS weq_recall_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, msgid INTEGER, conv TEXT, orig_seq INTEGER, recall_ts INTEGER, orig_body BLOB)`);
    await db.write(`DELETE FROM weq_recall_log`);

    // 靶子
    const tgt = await db.query(`SELECT "40001","40800","40011","40012" FROM group_msg_table WHERE "40027"=? AND "40011"=2 AND "40012"=1 ORDER BY "40003" DESC LIMIT 1`, [BigInt(GROUP)]);
    const mid = tgt[0]![0] as bigint;
    const origBody = tgt[0]![1] as Uint8Array;
    console.log(`靶子 msg=${mid} origBodyLen=${origBody.byteLength} type=${tgt[0]![2]}/${tgt[0]![3]}`);

    await db.write(`DROP TRIGGER IF EXISTS ${TRIG}`);
    // AFTER UPDATE：记录 + 补插最小灰条 + 还原原文。
    // 防递归/防重复的幂等锁：记录表里已有这条 msgid 就不再触发（NOT EXISTS）。
    // 第一次撤回 → 记录表没有 → 命中 → 记录(写入msgid) + 补插 + 还原。
    // 后续 2/3 连击 UPDATE → 记录表已有该 msgid → NOT EXISTS 为假 → 不再触发。
    // ③ 自还原的 UPDATE 同理被幂等锁挡住，不递归。
    await db.write(
      `CREATE TRIGGER ${TRIG} AFTER UPDATE ON group_msg_table
       WHEN OLD."40027" = ${GROUP}
         AND NEW."40800" IS NOT OLD."40800"
         AND NOT EXISTS (SELECT 1 FROM weq_recall_log WHERE msgid = OLD."40001")
       BEGIN
         INSERT INTO weq_recall_log(msgid,conv,orig_seq,recall_ts,orig_body)
           VALUES(OLD."40001", CAST(OLD."40027" AS TEXT), OLD."40003", strftime('%s','now'), OLD."40800");
         INSERT INTO group_msg_table ("40001","40002","40003","40011","40012","40027","40020","40050","40800")
           VALUES (OLD."40001"+555, abs(random())%2147483647, OLD."40003", 5, 17, OLD."40027", OLD."40020", strftime('%s','now'), X'0a03616263');
         UPDATE group_msg_table SET "40800"=OLD."40800", "40011"=OLD."40011", "40012"=OLD."40012"
           WHERE "40001"=NEW."40001";
       END`,
    );

    // 模拟 QQ 3 连击撤回（body 逐步变大 + type→5/4）
    const b1 = Buffer.concat([Buffer.from(origBody), Buffer.from([1,2,3])]);
    const b2 = Buffer.concat([Buffer.from(origBody), Buffer.from([1,2,3,4,5,6])]);
    const b3 = Buffer.concat([Buffer.from(origBody), Buffer.from([1,2,3,4,5,6,7,8,9])]);
    await db.write(`UPDATE group_msg_table SET "40800"=?, "40011"=5, "40012"=4 WHERE "40001"=?`, [b1, mid]);
    await db.write(`UPDATE group_msg_table SET "40800"=? WHERE "40001"=?`, [b2, mid]);
    await db.write(`UPDATE group_msg_table SET "40800"=? WHERE "40001"=?`, [b3, mid]);

    // 验证
    const after = await db.query(`SELECT "40011","40012",length("40800") FROM group_msg_table WHERE "40001"=?`, [mid]);
    const bodyKept = Buffer.from((await db.query(`SELECT "40800" FROM group_msg_table WHERE "40001"=?`, [mid]))[0]![0] as Uint8Array).equals(Buffer.from(origBody));
    const logN = Number((await db.query(`SELECT COUNT(*) FROM weq_recall_log`))[0]![0]);
    const gtN = Number((await db.query(`SELECT COUNT(*) FROM group_msg_table WHERE "40027"=? AND "40011"=5 AND "40012"=17 AND "40800"=X'0a03616263'`, [BigInt(GROUP)]))[0]![0]);

    console.log(`\n结果:`);
    console.log(`  原消息 type=${after[0]![0]}/${after[0]![1]} bodyLen=${after[0]![2]}  body==原文? ${bodyKept?'✅':'❌'}  (期望 2/1 + 原文)`);
    console.log(`  记录表: ${logN} 行 ${logN===1?'✅':'❌(期望1，>1=递归了)'}`);
    console.log(`  补插灰条: ${gtN} 条 ${gtN===1?'✅':'❌(期望1，>1=递归了)'}`);
    console.log(`\n=== 判读 ===`);
    if (bodyKept && logN===1 && gtN===1) console.log('  🎉 方案B成立！AFTER还原+补插，无递归，QQ 3连击下最终正确。');
    else if (logN>1||gtN>1) console.log('  ⚠️ 递归了（WHEN 没挡住自还原的UPDATE）——需加强判据。');
    else console.log('  ❌ 原文没保住或补插失败，看上面数值。');

    // 清理
    await db.write(`DROP TRIGGER IF EXISTS ${TRIG}`);
    await db.write(`DELETE FROM group_msg_table WHERE "40027"=? AND "40011"=5 AND "40012"=17 AND "40800"=X'0a03616263'`, [BigInt(GROUP)]);
    await db.write(`DROP TABLE IF EXISTS weq_recall_log`);
    console.log('\n(已清理)');
  } finally {
    db.close();
  }
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
