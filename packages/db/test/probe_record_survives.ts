/**
 * 方案C 地基验证：BEFORE UPDATE + RAISE(IGNORE) 只做「拦截 + 写记录表」（不补插灰条），
 * 记录表 INSERT 能不能活？
 *
 * 已知：BEFORE+RAISE 里「记录+补插+RAISE」三件套全废。但没单独测过「只记录+RAISE」。
 * 若记录表能活 → 方案C 成立（WeQ 轮询记录表补插）。若也被废 → 记录表这条通知路径断，
 * 需换 C2（WeQ 扫消息表，但拦截后原文没变、难分辨）。
 *
 * 用手动模拟 QQ 的 3 连击 UPDATE（body 逐步增大 + type→5/4），复现事务场景。
 * 但注意：手动多条 write 是各自 autocommit（非单事务），可能和 QQ 的单事务不同 →
 * 所以本脚本用 BEGIN/COMMIT 包起 3 连击，尽量贴近 QQ 的多语句事务。
 *
 * ⚠️ 需关 QQ。用完清理。
 * Run: pnpm tsx packages/db/test/probe_record_survives.ts [群号]
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
  const TRIG = 'weq_rec_probe';

  try {
    await db.write(`CREATE TABLE IF NOT EXISTS weq_recall_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, msgid INTEGER, conv TEXT, orig_seq INTEGER, recall_ts INTEGER, orig_body BLOB)`);
    await db.write(`DELETE FROM weq_recall_log`);

    const tgt = await db.query(`SELECT "40001","40800" FROM group_msg_table WHERE "40027"=? AND "40011"=2 AND "40012"=1 ORDER BY "40003" DESC LIMIT 1`, [BigInt(GROUP)]);
    const mid = tgt[0]![0] as bigint;
    const origBody = tgt[0]![1] as Uint8Array;
    console.log(`靶子 msg=${mid} origBodyLen=${origBody.byteLength}`);

    await db.write(`DROP TRIGGER IF EXISTS ${TRIG}`);
    // 只：记录 + RAISE(IGNORE)。不补插灰条。用幂等锁防重复记录。
    await db.write(
      `CREATE TRIGGER ${TRIG} BEFORE UPDATE ON group_msg_table
       WHEN OLD."40027"=${GROUP}
         AND NEW."40800" IS NOT OLD."40800"
         AND NOT EXISTS (SELECT 1 FROM weq_recall_log WHERE msgid=OLD."40001")
       BEGIN
         INSERT INTO weq_recall_log(msgid,conv,orig_seq,recall_ts,orig_body)
           VALUES(OLD."40001", CAST(OLD."40027" AS TEXT), OLD."40003", strftime('%s','now'), OLD."40800");
         SELECT RAISE(IGNORE);
       END`,
    );

    // 场景1：3 条各自 autocommit（我们 QqDb.write 每次独立）——模拟"多次独立写"
    const b1 = Buffer.concat([Buffer.from(origBody), Buffer.from([1,2,3])]);
    const b2 = Buffer.concat([Buffer.from(origBody), Buffer.from([1,2,3,4,5,6])]);
    const b3 = Buffer.concat([Buffer.from(origBody), Buffer.from([1,2,3,4,5,6,7,8,9])]);
    await db.write(`UPDATE group_msg_table SET "40800"=?,"40011"=5,"40012"=4 WHERE "40001"=?`, [b1, mid]);
    await db.write(`UPDATE group_msg_table SET "40800"=? WHERE "40001"=?`, [b2, mid]);
    await db.write(`UPDATE group_msg_table SET "40800"=? WHERE "40001"=?`, [b3, mid]);

    const logN = Number((await db.query(`SELECT COUNT(*) FROM weq_recall_log`))[0]![0]);
    const cur = await db.query(`SELECT "40011","40012",length("40800") FROM group_msg_table WHERE "40001"=?`, [mid]);
    const bodyKept = Buffer.from((await db.query(`SELECT "40800" FROM group_msg_table WHERE "40001"=?`, [mid]))[0]![0] as Uint8Array).equals(Buffer.from(origBody));
    console.log(`\n[多次autocommit UPDATE] 记录表=${logN} 行  原消息 ${cur[0]![0]}/${cur[0]![1]} bodyLen=${cur[0]![2]} 原文保住=${bodyKept?'✅':'❌'}`);
    console.log(`  记录表能活? ${logN>=1?'✅ 能活':'❌ 被废'}   拦截? ${bodyKept?'✅':'❌'}`);

    console.log('\n=== 判读 ===');
    console.log(`  记录表≥1 且 原文保住 → 方案C成立：BEFORE+RAISE 拦截时记录表 INSERT 能活，WeQ 轮询它补插。`);
    console.log(`  记录表=0 → 记录表也被 RAISE 废掉，需 C2（WeQ 扫消息表）或别的通知法。`);
    console.log(`  （注意：这里3条是各自autocommit；QQ真实撤回是单事务3连击，行为可能不同——`);
    console.log(`    若这里能活，还需真机验证QQ单事务下也能活。）`);

    await db.write(`DROP TRIGGER IF EXISTS ${TRIG}`);
    await db.write(`DROP TABLE IF EXISTS weq_recall_log`);
    console.log('\n(已清理)');
  } finally {
    db.close();
  }
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
