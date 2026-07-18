/**
 * 决定性隔离测：BEFORE UPDATE trigger 里，RAISE(IGNORE) 之前的 INSERT 会不会
 * 被一起丢弃？这解释"拦截成功但补插/记录都没落地"。
 *
 * 在真库建一张自己的临时表 weq_raise_probe，装一个 BEFORE UPDATE trigger 到
 * group_msg_table：先 INSERT 一行进 probe 表，再 RAISE(IGNORE)。然后对某条消息做
 * 一次会命中的 UPDATE，看 probe 表里到底有没有那行。
 *
 * ⚠️ 写库（建表+trigger+一次UPDATE），但 UPDATE 会被 RAISE 取消、probe 表用完即删。
 *    需要关 QQ。
 *
 * Run: pnpm tsx packages/db/test/probe_raise_insert.ts [群号]
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const GROUP = process.argv[2] ?? '673646675';

async function main(): Promise<void> {
  const nt = loadNative();
  if (nt.ntHelper.getQqProcesses().length) { console.error('先关 QQ'); process.exit(1); }
  const db = new QqDb(nt.ntHelper, { dbPath: DB, key: KEY, algo: ALGO });

  try {
    await db.write(`DROP TRIGGER IF EXISTS weq_raise_probe_trig`);
    await db.write(`CREATE TABLE IF NOT EXISTS weq_raise_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT)`);
    await db.write(`DELETE FROM weq_raise_probe`);

    // 拿一条该群消息的 40001 做靶子
    const tgt = await db.query(`SELECT "40001","40800" FROM group_msg_table WHERE "40027"=? AND "40011"=2 ORDER BY "40003" DESC LIMIT 1`, [BigInt(GROUP)]);
    if (!tgt.length) { console.error('无靶子消息'); return; }
    const mid = tgt[0]![0] as bigint;
    const body = tgt[0]![1] as Uint8Array;

    // 三种 trigger 变体，分别测：
    //   A: INSERT 后 RAISE(IGNORE)      —— INSERT 留不留？
    //   B: INSERT 后 RAISE(ABORT,...)   —— 预期回滚，INSERT 不留（对照）
    //   C: 只 INSERT 不 RAISE           —— 但这样 UPDATE 会真的改数据（不测，只逻辑对照）
    for (const [variant, raiseStmt] of [['A_IGNORE', `SELECT RAISE(IGNORE);`], ['B_ABORT', `SELECT RAISE(ABORT, 'x');`]] as const) {
      await db.write(`DELETE FROM weq_raise_probe`);
      await db.write(`DROP TRIGGER IF EXISTS weq_raise_probe_trig`);
      await db.write(
        `CREATE TRIGGER weq_raise_probe_trig BEFORE UPDATE ON group_msg_table
         WHEN OLD."40001"=${mid}
         BEGIN
           INSERT INTO weq_raise_probe(note) VALUES('fired-${variant}');
           ${raiseStmt}
         END`,
      );
      // 触发一次会命中的 UPDATE（改 40800，加个字节）
      const fake = Buffer.concat([Buffer.from(body), Buffer.from([0])]);
      let updErr = '';
      const affected = await db.write(`UPDATE group_msg_table SET "40800"=? WHERE "40001"=?`, [fake, mid]).catch((e) => { updErr = String(e); return -1; });
      const probeCnt = Number((await db.query(`SELECT COUNT(*) FROM weq_raise_probe`))[0]![0]);
      // 确认靶子没被真改
      const stillType = await db.query(`SELECT "40011","40012" FROM group_msg_table WHERE "40001"=?`, [mid]);
      console.log(`[${variant}] UPDATE affected=${affected}${updErr ? ` err=${updErr.slice(0, 40)}` : ''}  →  probe表INSERT留存=${probeCnt} 行  (靶子仍 ${stillType[0]?.[0]}/${stillType[0]?.[1]})`);
    }

    console.log('\n=== 判读 ===');
    console.log('  A_IGNORE probe=1 → RAISE(IGNORE) 不回滚前面的 INSERT（那补插失败另有原因，如 blob 拼错/UNIQUE）');
    console.log('  A_IGNORE probe=0 → ★RAISE(IGNORE) 把同 trigger 内先前 INSERT 一起丢弃！需换策略（AFTER trigger 或别的取消法）');

    // 清理
    await db.write(`DROP TRIGGER IF EXISTS weq_raise_probe_trig`);
    await db.write(`DROP TABLE IF EXISTS weq_raise_probe`);
    console.log('\n(已清理 probe trigger + 表)');
  } finally {
    db.close();
  }
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
