/**
 * 决定性只读复现：把线上 group 触发器那条**混合类型** IN 列表原样搬到 SELECT 里，
 * 测群号 673646675 到底命不命中。列表里既有纯数字群号（'673646675'），又混进了
 * 'u_...' uid 字面量 —— 怀疑正是这个混合让 SQLite 对 INTEGER 列 40027 的 IN 亲和
 * 行为翻车。
 *
 * 三组对比：
 *   A. 纯字符串数字列表 IN ('673646675')              —— 之前证明命中
 *   B. 混合列表（数字串 + u_串），即线上触发器实际用的
 *   C. 纯数字字面量 IN (673646675)                     —— 对照
 *
 * 全 SELECT，不写库。
 * Run: pnpm tsx packages/db/test/diag_mixed_inlist.ts [groupCode]
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const LIVE =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const GROUP = process.argv[2] ?? '673646675';

async function main(): Promise<void> {
  const nt = loadNative();
  const db = new QqDb(nt.ntHelper, { dbPath: LIVE, key: KEY, algo: ALGO });

  const pureStr = `'${GROUP}'`;
  const pureNum = `${GROUP}`;
  // 混合列表：把目标群号夹在若干 u_ 字面量之间，复刻线上形态
  const mixed = `'u_DRENktQ9gS_Z02WOT6qugQ', '${GROUP}', 'u_ycOFKhEd7_qtOjfWv-UZLw', 'u_wRUspIAtivgCxdpsLcnncA'`;

  const q = async (inList: string): Promise<number> => {
    const r = await db.query(
      `SELECT COUNT(*) FROM group_msg_table WHERE "40027" IN (${inList})`,
    );
    return Number(r[0]![0]);
  };

  const a = await q(pureStr);
  const b = await q(mixed);
  const c = await q(pureNum);

  console.log(`群 ${GROUP} — 40027 IN(...) 命中行数`);
  console.log(`  A 纯字符串   IN (${pureStr})            → ${a}`);
  console.log(`  B 混合(线上) IN (…u_…, '${GROUP}', …u_…) → ${b}`);
  console.log(`  C 纯数字     IN (${pureNum})              → ${c}`);

  console.log('\n=== 判读 ===');
  if (a > 0 && b === 0) {
    console.log('  ❌ 实锤：一旦 IN 列表里混入 u_ 字符串，INTEGER 列 40027 的匹配整体失效！');
    console.log('     SQLite 对含非数字元素的 IN 列表可能整体按 TEXT 比较 → 群号(INTEGER)匹配不上。');
    console.log('     修复：group 触发器绝不能混入 u_；且群号应以数字字面量或分列表处理。');
  } else if (a > 0 && b > 0) {
    console.log('  ⚠️ 混合列表仍命中 → 根因不在混合类型，另查（连接 schema 重载 / 撤回列）。');
  } else {
    console.log(`  ？ A=${a} B=${b} C=${c}，需人工判读。`);
  }

  db.close();
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
