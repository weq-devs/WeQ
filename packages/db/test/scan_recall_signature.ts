/**
 * 只读扫描：用真实库的**全量静态数据**验证「首元素 elementType `!8 → 8`」判据能否
 * 精准识别撤回，回答两个硬指标：
 *   ① 撤回漏判率：有没有撤回消息，其首元素 elementType 不是 8（→ 写入时 NEW 非 8 → 漏拦）
 *   ② 正常误杀率：有多少「非撤回」消息，首元素 elementType 却是 8（→ 可能被误当撤回）
 *
 * ── 为什么静态扫描能回答动态判据 ─────────────────────────────────────────────
 * 收窄判据是 trigger 时刻比较 OLD/NEW：NEW 首元素=8 且 OLD 首元素≠8。静态库看不到
 * OLD→NEW 跃迁，但能回答两件等价的事：
 *   • 已 settle 的撤回灰条在库里必然是「首元素=8」。若存在撤回消息首元素≠8，说明写入
 *     那一刻 NEW 也不是 8 → `!8→8` 会漏。统计这类 = 漏判上界。
 *   • backfill 写的是**真内容**（首元素≠8），天然不满足 NEW=8。真正的误杀风险只来自
 *     「非撤回但首元素=8」的消息（戳一戳/群通知/精华等其它灰条）。统计这类 + 它们的
 *     子类型分布 = 误杀面。
 *
 * ── 首元素 elementType 提取（不解完整 protobuf）─────────────────────────────
 * 40800 里首个 element 的 field 45002(elementType) wire tag = X'd0fc15'，值恒单字节
 * （类型编号 1~8 < 128）。`substr(body, instr(body,X'd0fc15')+3, 1)` 切出该字节。
 * 与 anti_recall.ts 用 X'c2a517' 抽 revokeUid 同招，无需 protobuf 解析器。
 *
 * ── 撤回判定（两个独立信号，交叉验证）─────────────────────────────────────────
 *   • 5/4      ：40011=5 AND 40012=4（旧文档的“撤回指纹”，实为 settle 后的稳态）
 *   • c2a517   ：body 含 field 47704 recallRevokeUid（撤回灰条独有；占位空/离线撤回
 *                可能后补，覆盖率本脚本一并测）
 * 撤回集合 = 5/4 ∪ c2a517。分别统计覆盖率，看哪个更可靠。
 *
 * 只读，不写任何东西，可在 QQ 开着时跑（只走读连接）。大库上 instr 全表扫描可能几秒。
 *
 * 用法：
 *   pnpm tsx packages/db/test/scan_recall_signature.ts            # 三表全量
 *   pnpm tsx packages/db/test/scan_recall_signature.ts group      # 只看某表 c2c|group|dataline
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;

const TABLES: ReadonlyArray<{ kind: string; table: string }> = [
  { kind: 'c2c', table: 'c2c_msg_table' },
  { kind: 'group', table: 'group_msg_table' },
  { kind: 'dataline', table: 'dataline_msg_table' },
];

/** 首元素 elementType 字节的 hex（无 40800 或找不到 tag → NULL）。 */
const ETYPE = `CASE WHEN "40800" IS NOT NULL AND instr("40800", X'd0fc15') > 0
  THEN hex(substr("40800", instr("40800", X'd0fc15') + 3, 1)) ELSE NULL END`;
/** 是否含撤回者字段 recallRevokeUid。 */
const HAS_REVOKE = `(("40800" IS NOT NULL) AND instr("40800", X'c2a517') > 0)`;
/** 是否含发送者字段 recallSenderUid（对照）。 */
const HAS_SENDER = `(("40800" IS NOT NULL) AND instr("40800", X'baa517') > 0)`;
/** 稳态撤回类型。 */
const IS_54 = `("40011" = 5 AND "40012" = 4)`;
/** 撤回集合：5/4 或 含撤回者字段。 */
const IS_RECALL = `(${IS_54} OR ${HAS_REVOKE})`;
/** 首元素是灰条(elementType=8)。 */
const IS_GRAYTIP = `(instr("40800", X'd0fc15') > 0 AND hex(substr("40800", instr("40800", X'd0fc15') + 3, 1)) = '08')`;

async function one(db: QqDb, kind: string, table: string): Promise<void> {
  const q = async (expr: string): Promise<number> => {
    const r = await db.query(`SELECT COUNT(*) FROM ${table} WHERE ${expr}`).catch(() => [[0]]);
    return Number(r[0]?.[0] ?? 0);
  };

  const total = Number((await db.query(`SELECT COUNT(*) FROM ${table}`).catch(() => [[0]]))[0]?.[0] ?? 0);
  if (total === 0) { console.log(`\n### ${kind} (${table}) —— 空表，跳过`); return; }

  const grayTip = await q(IS_GRAYTIP);
  const recall = await q(IS_RECALL);
  const r54 = await q(IS_54);
  const rUid = await q(HAS_REVOKE);
  const rSender = await q(HAS_SENDER);
  const r54AndUid = await q(`${IS_54} AND ${HAS_REVOKE}`);
  const r54NoUid = await q(`${IS_54} AND NOT ${HAS_REVOKE}`);
  const uidNo54 = await q(`${HAS_REVOKE} AND NOT ${IS_54}`);

  // ① 漏判：撤回消息但首元素≠8（写入时 NEW 非 8 → !8→8 会漏）
  const recallNotGray = await q(`${IS_RECALL} AND NOT ${IS_GRAYTIP}`);
  // ② 误杀面：非撤回但首元素=8（其它灰条：戳一戳/群通知/精华…）
  const grayNotRecall = await q(`${IS_GRAYTIP} AND NOT ${IS_RECALL}`);

  console.log(`\n### ${kind} (${table})  总行 ${total.toLocaleString()}`);
  console.log(`  灰条(首元素=8)         : ${grayTip.toLocaleString()}`);
  console.log(`  撤回集合(5/4 ∪ c2a517) : ${recall.toLocaleString()}`);
  console.log(`    ├ 5/4 稳态           : ${r54.toLocaleString()}`);
  console.log(`    ├ 含 c2a517(revokeUid): ${rUid.toLocaleString()}   含 baa517(senderUid): ${rSender.toLocaleString()}`);
  console.log(`    ├ 5/4 且有 uid       : ${r54AndUid.toLocaleString()}`);
  console.log(`    ├ 5/4 但缺 uid       : ${r54NoUid.toLocaleString()}   ← 这些若写库,revokeUid 抽不到→假“管理员”`);
  console.log(`    └ 有 uid 但非 5/4    : ${uidNo54.toLocaleString()}   ← 中间态/占位空补写`);

  console.log(`\n  ① 撤回漏判上界: 撤回但首元素≠8 = ${recallNotGray.toLocaleString()}  ` +
    `${recallNotGray === 0 ? '✅ !8→8 不漏任何 settle 撤回' : `⚠️ 占比 ${(100 * recallNotGray / Math.max(recall,1)).toFixed(2)}%,需看样本`}`);
  console.log(`  ② 正常误杀面: 首元素=8 但非撤回 = ${grayNotRecall.toLocaleString()}  ` +
    `${grayNotRecall === 0 ? '✅ 无其它灰条混入' : '(其它灰条,靠子类型区分,见下)'}`);

  // 误杀面按 40012(subType) 分布 —— 看是戳一戳/群通知等（这些通常是 INSERT 不是 UPDATE,
  // 且不会从“真消息”原地变来,故实际不会被 !8→8 的 OLD≠8 误伤;此处量化其规模）
  if (grayNotRecall > 0) {
    const dist = await db.query(
      `SELECT "40011","40012",COUNT(*) FROM ${table}
       WHERE ${IS_GRAYTIP} AND NOT ${IS_RECALL}
       GROUP BY "40011","40012" ORDER BY COUNT(*) DESC LIMIT 12`).catch(() => []);
    console.log(`     非撤回灰条 type 分布(40011/40012):`);
    for (const r of dist) console.log(`       ${r[0]}/${r[1]}  × ${Number(r[2]).toLocaleString()}`);
  }

  // 漏判样本：撤回但首元素≠8，抽几条看 head，判断是真漏还是误标
  if (recallNotGray > 0) {
    const s = await db.query(
      `SELECT "40001","40011","40012",${ETYPE},${HAS_REVOKE},${IS_54},hex(substr("40800",1,48))
       FROM ${table} WHERE ${IS_RECALL} AND NOT ${IS_GRAYTIP} LIMIT 8`).catch(() => []);
    console.log(`     漏判样本(撤回但首元素≠8):`);
    for (const r of s) console.log(`       msg=${r[0]} type=${r[1]}/${r[2]} etype=${r[3]} uid=${r[4]} 54=${r[5]} head=${String(r[6]).slice(0,40)}…`);
  }
}

async function main(): Promise<void> {
  const only = process.argv[2];
  const db = new QqDb(loadNative().ntHelper, { dbPath: DB, key: KEY, algo: ALGO });
  try {
    console.log('══════ 撤回判据静态扫描（只读）══════');
    for (const t of TABLES) {
      if (only && only !== t.kind) continue;
      await one(db, t.kind, t.table);
    }
    console.log('\n══════ 判读 ══════');
    console.log('  ① 若三表“撤回漏判上界”全 0 → NEW 首元素=8 能抓住所有已 settle 撤回,不漏。');
    console.log('  ② 误杀面即其它灰条(戳一戳/群通知…),它们是 INSERT 新行、非“真消息原地变来”,');
    console.log('     故 !8→8 的 OLD≠8 前提天然把它们挡在外(不是 UPDATE、或 OLD 本就是灰条)。');
    console.log('  ③ “5/4 但缺 uid”“有 uid 但非 5/4” 两行 → 决定“uid 空不入库”这道门会拦掉多少、放行多少。');
  } finally {
    db.close();
  }
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
