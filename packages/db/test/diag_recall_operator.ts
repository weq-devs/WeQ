/**
 * 只读诊断：定位「管理员撤回被误判为对方撤回」的根因 —— 撤回灰条里两个 uid 字段
 * （baa517=47703 / c2a517=47704）到底哪个是操作者、哪个是原发送者。
 *
 * 现网只抽 c2a517 当 revoke_uid，并与 OLD.40020(原作者) 比较判自撤/他撤。若 c2a517
 * 其实是「原发送者」而非「操作者」，则管理员撤他人时 c2a517==40020 → 恒判自撤 → UI
 * 显示「对方撤回」。本脚本捞出两字段不等的行（=他撤样本），对照 40020 一锤定音。
 *
 * 抽取：tag(3B) + len(0x18=24) + 24B uid → substr(body, instr(tag)+4, 24)。只读，QQ 开着可跑。
 *
 * 用法：pnpm tsx packages/db/test/diag_recall_operator.ts [group|c2c]
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;

/** 抽某 tag 后的 24B uid（找不到→''）。 */
const uidOf = (tag: string): string =>
  `CASE WHEN instr("40800", ${tag})>0 THEN CAST(substr("40800", instr("40800", ${tag})+4, 24) AS TEXT) ELSE '' END`;
const U_BAA = uidOf(`X'baa517'`); // 47703
const U_C2A = uidOf(`X'c2a517'`); // 47704
const IS_54 = `("40011"=5 AND "40012"=4)`;

async function run(kind: string): Promise<void> {
  const table = kind === 'c2c' ? 'c2c_msg_table' : 'group_msg_table';
  const db = new QqDb(loadNative().ntHelper, { dbPath: DB, key: KEY, algo: ALGO });
  try {
    console.log(`\n### ${table} —— 撤回灰条两 uid 字段 vs 原作者(40020)`);

    const total = Number((await db.query(`SELECT COUNT(*) FROM ${table} WHERE ${IS_54}`))[0]?.[0] ?? 0);
    // 两字段是否相等的分布
    const eq = Number((await db.query(`SELECT COUNT(*) FROM ${table} WHERE ${IS_54} AND ${U_BAA}=${U_C2A}`))[0]?.[0] ?? 0);
    const neq = total - eq;
    console.log(`  5/4 撤回行 ${total}  ｜ baa517==c2a517（疑自撤）${eq}  ｜ 两者不等（疑他撤）${neq}`);

    // baa517 / c2a517 各自等于 40020 的比例（40020=原作者；等于它的那个字段 = 原发送者字段）
    const baaEq20 = Number((await db.query(`SELECT COUNT(*) FROM ${table} WHERE ${IS_54} AND ${U_BAA}=CAST("40020" AS TEXT)`))[0]?.[0] ?? 0);
    const c2aEq20 = Number((await db.query(`SELECT COUNT(*) FROM ${table} WHERE ${IS_54} AND ${U_C2A}=CAST("40020" AS TEXT)`))[0]?.[0] ?? 0);
    console.log(`  等于原作者40020：baa517 ${baaEq20}/${total}   c2a517 ${c2aEq20}/${total}`);
    console.log(`   → 恒等于40020的那个字段=「原发送者」；另一个=「操作者」。`);

    // 他撤样本：两字段不等，看谁==40020
    const rows = await db.query(
      `SELECT "40001", CAST("40020" AS TEXT), ${U_BAA}, ${U_C2A}
       FROM ${table} WHERE ${IS_54} AND ${U_BAA}<>${U_C2A} LIMIT 12`).catch(() => []);
    if (!rows.length) {
      console.log('  （没抓到两字段不等的行——此库可能全是自撤。管理员撤他人需要真样本才能坐实。）');
    } else {
      console.log(`\n  他撤样本 ${rows.length} 条：`);
      for (const r of rows) {
        const [mid, u20, baa, c2a] = [String(r[0]), String(r[1]), String(r[2]), String(r[3])];
        const baaIsSender = baa === u20;
        const c2aIsSender = c2a === u20;
        const operator = baaIsSender ? `baa517=${baa}` : c2aIsSender ? `c2a517=${c2a}` : '两者都≠40020(?)';
        console.log(`    msg=${mid}`);
        console.log(`      40020(原作者)=${u20}`);
        console.log(`      baa517=${baa} ${baaIsSender ? '==40020(原发送者)' : '≠40020'}`);
        console.log(`      c2a517=${c2a} ${c2aIsSender ? '==40020(原发送者)' : '≠40020'}`);
        console.log(`      ⇒ 操作者 = ${operator}`);
      }
    }
    console.log(`\n  结论：现网抽 c2a517 当 revoke_uid。若上面「操作者」落在 baa517 → 抽反了,`);
    console.log(`        应改为「取与40020不等的那个字段」当操作者。`);
  } finally {
    db.close();
  }
}

run(process.argv[2] === 'c2c' ? 'c2c' : 'group').catch((e) => {
  console.error('failed:', e instanceof Error ? e.message : e); process.exit(1);
});
