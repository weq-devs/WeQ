/**
 * 只读深挖：确认 `!8→8` 收窄判据的两个残余风险点，纯 SELECT，QQ 开着也能跑。
 *
 *   A) group 里“有 c2a517 但非 5/4”的 3 条 —— 是中间态还是占位空补写？看 type/head/uid。
 *   B) 分布里的 1/1、1/2（msgType=1 却首元素=8）—— 正常消息不该首元素=8。若它们其实是
 *      灰条被存成 msgType=1，需确认不会经“真消息→灰条”的 UPDATE 产生（否则 !8→8 误伤）。
 *   C) 验证 revokeUid 抽取：对撤回行按现网表达式切 uid，抽样看是否都是合法 24B u_ 串。
 *   D) 关键跃迁反证：真消息(首元素≠8) 与 撤回灰条(首元素=8) 的 elementType 值分布，
 *      确认“正常消息首元素几乎不为 8” —— 支撑 OLD≠8 前提成立。
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;

const ETYPE = `hex(substr("40800", instr("40800", X'd0fc15') + 3, 1))`;
const HAS_REVOKE = `(instr("40800", X'c2a517') > 0)`;
const IS_54 = `("40011" = 5 AND "40012" = 4)`;
const IS_GRAY = `(instr("40800", X'd0fc15') > 0 AND ${ETYPE} = '08')`;
/** 现网 revokeUid 抽取表达式（照搬 anti_recall.ts）。 */
const REVOKE_UID = `CASE WHEN instr("40800", X'c2a517') > 0
  THEN CAST(substr("40800", instr("40800", X'c2a517') + 4, 24) AS TEXT) ELSE '' END`;

async function main(): Promise<void> {
  const db = new QqDb(loadNative().ntHelper, { dbPath: DB, key: KEY, algo: ALGO });
  try {
    console.log('══════ A) group「有 uid 但非 5/4」样本 ══════');
    const a = await db.query(
      `SELECT "40001","40011","40012",${ETYPE},${REVOKE_UID},length("40800"),hex(substr("40800",1,40))
       FROM group_msg_table WHERE ${HAS_REVOKE} AND NOT ${IS_54} LIMIT 10`).catch((e) => { console.log('err', e); return []; });
    for (const r of a) console.log(`  msg=${r[0]} type=${r[1]}/${r[2]} etype=${r[3]} uid=${r[4]} blen=${r[5]} head=${String(r[6]).slice(0,32)}…`);

    console.log('\n══════ B) 「msgType=1 但首元素=8」样本（1/1、1/2）══════');
    for (const tbl of ['group_msg_table', 'c2c_msg_table']) {
      const b = await db.query(
        `SELECT "40001","40011","40012",${ETYPE},${HAS_REVOKE},${IS_54},length("40800"),hex(substr("40800",1,40))
         FROM ${tbl} WHERE ${IS_GRAY} AND "40011"=1 LIMIT 6`).catch(() => []);
      console.log(`  [${tbl}]`);
      for (const r of b) console.log(`    msg=${r[0]} type=${r[1]}/${r[2]} etype=${r[3]} hasUid=${r[4]} is54=${r[5]} blen=${r[6]} head=${String(r[7]).slice(0,32)}…`);
    }

    console.log('\n══════ C) revokeUid 抽取抽样（撤回行）══════');
    const c = await db.query(
      `SELECT "40001",${REVOKE_UID},"40020" FROM group_msg_table WHERE ${IS_54} LIMIT 8`).catch(() => []);
    let bad = 0;
    for (const r of c) {
      const uid = String(r[1] ?? '');
      const ok = /^u_[A-Za-z0-9_-]{22}$/.test(uid);
      if (!ok) bad++;
      console.log(`  msg=${r[0]} revoke=${uid} ${ok ? '✓' : '✗非法'} sender=${r[2]} ${uid===String(r[2])?'(本人撤)':'(他人撤/管理员)'}`);
    }
    console.log(`  → 抽样 ${c.length} 条,非法 uid ${bad} 条`);

    console.log('\n══════ D) 首元素 elementType 值分布（全表，看正常消息是否几乎不为08）══════');
    for (const tbl of ['group_msg_table', 'c2c_msg_table']) {
      const d = await db.query(
        `SELECT ${ETYPE} AS et, COUNT(*) FROM ${tbl}
         WHERE "40800" IS NOT NULL AND instr("40800", X'd0fc15')>0
         GROUP BY et ORDER BY COUNT(*) DESC LIMIT 12`).catch(() => []);
      console.log(`  [${tbl}] elementType(hex) → 行数:`);
      for (const r of d) console.log(`    ${r[0]} × ${Number(r[1]).toLocaleString()}`);
    }
  } finally {
    db.close();
  }
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
