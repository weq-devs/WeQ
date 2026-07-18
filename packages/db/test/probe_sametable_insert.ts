/**
 * 决定性隔离：BEFORE UPDATE trigger 里，INSERT「异表」vs INSERT「同表」的差异。
 *
 * 已知：
 *   - probe_raise_insert：BEFORE UPDATE 里 INSERT 异表(weq_raise_probe) + RAISE(IGNORE) → 异表行留存=1 ✅
 *   - 真实 trigger：BEFORE UPDATE 里 INSERT 记录表(异表) + INSERT 灰条(同表 group_msg_table) + RAISE(IGNORE) → 两者都没落地 ❌
 *   - 两条 INSERT 单独在普通连接跑 ��� 都成功 ✅
 * → 强烈怀疑：BEFORE UPDATE 里 INSERT **同一张正在被 UPDATE 的表**被 SQLite 特殊处理，
 *   且它的失败/限制把整个 trigger program 连带异表 INSERT 一起废掉。
 *
 * 本测：一个 BEFORE UPDATE trigger，body 里先 INSERT 异表(probe_other)，再 INSERT
 * 同表(group_msg_table 一行灰条)，再 RAISE(IGNORE)。触发一次 UPDATE 后看：
 *   - probe_other 有没有那行（异表 INSERT 落地否）
 *   - group_msg_table 有没有新增那行灰条（同表 INSERT 落地否）
 * 对照：再单独测「只 INSERT 异表」的 body，确认异表本身没问题。
 *
 * ⚠️ 需关 QQ。全部临时物用完即清。
 * Run: pnpm tsx packages/db/test/probe_sametable_insert.ts [群号]
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

  const TRIG = 'weq_st_probe_trig';
  try {
    // 靶子消息
    const tgt = await db.query(`SELECT "40001","40800" FROM group_msg_table WHERE "40027"=? AND "40011"=2 AND "40012"=1 ORDER BY "40003" DESC LIMIT 1`, [BigInt(GROUP)]);
    const mid = tgt[0]![0] as bigint;
    const body = tgt[0]![1] as Uint8Array;
    console.log(`靶子 msg=${mid}`);

    await db.write(`CREATE TABLE IF NOT EXISTS weq_probe_other (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT)`);

    // 记录当前群消息行数（同表 INSERT 前后对比）
    const cntMsgBefore = Number((await db.query(`SELECT COUNT(*) FROM group_msg_table WHERE "40027"=?`, [BigInt(GROUP)]))[0]![0]);

    await db.write(`DELETE FROM weq_probe_other`);
    await db.write(`DROP TRIGGER IF EXISTS ${TRIG}`);
    // body：先异表 INSERT，再同表 INSERT（用一条最小合法列的灰条：clone OLD 全列不好写，
    // 这里用最少列插入——只插 PK 变体 + 分区 + 一个假 body，够验证"同表 INSERT 能否落地"）
    await db.write(
      `CREATE TRIGGER ${TRIG} BEFORE UPDATE ON group_msg_table
       WHEN OLD."40001"=${mid}
       BEGIN
         INSERT INTO weq_probe_other(note) VALUES('other-before-sametable');
         INSERT INTO group_msg_table ("40001","40002","40003","40011","40012","40027","40020","40050","40800")
           VALUES (OLD."40001" + 777, abs(random()) % 2147483647, OLD."40003", 5, 17, OLD."40027", OLD."40020", strftime('%s','now'), X'0a00');
         INSERT INTO weq_probe_other(note) VALUES('other-after-sametable');
         SELECT RAISE(IGNORE);
       END`,
    );

    const fake = Buffer.concat([Buffer.from(body), Buffer.from([0])]);
    let err = '';
    const aff = await db.write(`UPDATE group_msg_table SET "40800"=? WHERE "40001"=?`, [fake, mid]).catch((e) => { err = String(e); return -1; });

    const other = await db.query(`SELECT note FROM weq_probe_other ORDER BY id`);
    const cntMsgAfter = Number((await db.query(`SELECT COUNT(*) FROM group_msg_table WHERE "40027"=?`, [BigInt(GROUP)]))[0]![0]);

    console.log(`\nUPDATE affected=${aff}${err ? ` err=${err.slice(0,60)}` : ''}`);
    console.log(`异表 weq_probe_other 落地行: ${other.length}  → ${JSON.stringify(other.map(r=>r[0]))}`);
    console.log(`  期望 ['other-before-sametable','other-after-sametable'] 两行都在`);
    console.log(`同表 group_msg_table 新增: ${cntMsgAfter - cntMsgBefore} 行  ${cntMsgAfter-cntMsgBefore===1?'✅ 同表INSERT落地':'❌ 同表INSERT没落地'}`);

    console.log('\n=== 判读 ===');
    if (other.length === 2 && cntMsgAfter - cntMsgBefore === 1) console.log('  两者都落地 → 同表INSERT没问题，真实trigger失败另有原因（灰条blob/列约束）');
    else if (other.length === 2 && cntMsgAfter - cntMsgBefore === 0) console.log('  ★异表落地、同表没落地 → BEFORE UPDATE 里 INSERT 同表被 SQLite 拒绝/忽略！');
    else if (other.length === 1) console.log('  ★异表只落地"before"那行 → 同表INSERT那句抛错中断了后续，且异表after被回滚 → 同表INSERT是元凶');
    else if (other.length === 0) console.log('  ★异表0行 → 整个body被废（同表INSERT错误把program abort，连异表也回滚）');

    // 清理：删可能插入的同表灰条 + 异表 + trigger
    await db.write(`DROP TRIGGER IF EXISTS ${TRIG}`);
    const delMsg = await db.write(`DELETE FROM group_msg_table WHERE "40027"=? AND "40011"=5 AND "40012"=17 AND "40800"=X'0a00'`, [BigInt(GROUP)]);
    if (delMsg) console.log(`\n(清理同表测试灰条 ${delMsg} 行)`);
    await db.write(`DROP TABLE IF EXISTS weq_probe_other`);
    console.log('(清理异表 + trigger)');
  } finally {
    db.close();
  }
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
