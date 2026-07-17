/**
 * 修正诊断：之前用 "ORDER BY rowid" 但 SELECT 里 rowid 被 40001 值遮蔽/或表是
 * WITHOUT ROWID？先搞清 group_msg_table 的真实 rowid 与 40001 关系，再按**真 rowid**
 * 取最新，找到小号刚发/撤的消息 + 可能补插的灰条。全只读。
 *
 * Run: pnpm tsx packages/db/test/diag_true_latest.ts [群号]
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { decodeBody } from '../src/msg/util';

const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const LIVE =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const GROUP = process.argv[2] ?? '673646675';

const brief = (els: any[]): string =>
  els.map((e) => {
    if (e.kind === 'text') return `text:${JSON.stringify(String(e.textContent ?? '').slice(0, 24))}`;
    if (e.kind === 'grayTipPoke') return `★灰条:${String(e.tipJson).slice(0, 70)}`;
    if (String(e.kind).startsWith('grayTip')) return e.kind;
    return e.kind;
  }).join(' + ') || '(空)';

async function main(): Promise<void> {
  const nt = loadNative();
  const db = new QqDb(nt.ntHelper, { dbPath: LIVE, key: KEY, algo: ALGO });

  // 1. rowid 与 40001 是否相等？取几行对比
  const cmp = await db.query(
    `SELECT rowid AS rid, "40001" AS m FROM group_msg_table WHERE "40027"=? ORDER BY rowid DESC LIMIT 5`,
    [BigInt(GROUP)],
  );
  console.log('=== rowid vs 40001（看是否相等）===');
  let allEq = true;
  for (const r of cmp) {
    const eq = String(r[0]) === String(r[1]);
    if (!eq) allEq = false;
    console.log(`  rowid=${r[0]}  40001=${r[1]}  ${eq ? '=' : '≠ ★不等！'}`);
  }
  console.log(allEq ? '  → rowid==40001，排序等价' : '  → rowid≠40001，之前按40001排是错的！');

  // 2. 按 40003(seq) 真·最新 15 条 —— seq 才是发送顺序，msgId/rowid 不单调
  const rows = await db.query(
    `SELECT "40003","40001","40011","40012","40050","40020","40093","40800"
       FROM group_msg_table WHERE "40027"=?
      ORDER BY "40003" DESC LIMIT 15`,
    [BigInt(GROUP)],
  );
  console.log(`\n=== 群 ${GROUP} 真·最新 15 条（40003 seq desc）===`);
  for (const r of rows) {
    const els = decodeBody(r[7]) as any[];
    console.log(`  seq=${r[0]} msg=${r[1]} type=${r[2]}/${r[3]} t=${r[4]} sender=${String(r[5]).slice(0,12)} nick=${r[6] === null ? 'NULL' : JSON.stringify(r[6])} :: ${brief(els)}`);
  }

  // 3. 有没有我们补插的 5/17 “撤回了一条消息”灰条（按内容找，不靠排序）
  const ours = await db.query(
    `SELECT "40003","40001","40800" FROM group_msg_table
      WHERE "40027"=? AND "40011"=5 AND "40012"=17
      ORDER BY "40003" DESC LIMIT 10`,
    [BigInt(GROUP)],
  );
  console.log(`\n=== 群里所有 5/17 灰条（找"撤回了一条消息"）===`);
  let found = 0;
  for (const r of ours) {
    const els = decodeBody(r[2]) as any[];
    const tip = String(els[0]?.tipJson ?? '');
    const isOurs = tip.includes('撤回了一条消息');
    if (isOurs) found++;
    console.log(`  ${isOurs ? '★我们的' : '（系统）'} rowid=${r[0]} tip=${tip.slice(0, 80)}`);
  }
  console.log(`\n→ 我们补插的"撤回了一条消息"灰条: ${found} 条 ${found > 0 ? '✅ 补插成功过' : '（cleanup 已删/或没补成）'}`);

  db.close();
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
