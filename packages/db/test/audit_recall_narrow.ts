/**
 * 收窄 anti-recall 判据的审计脚本 —— 看清「QQ 撤回三连击的中间态」，并量化
 * 「现行宽判据会误伤多少正常写」，据此把 WHEN 收到最紧。
 *
 * ── 为什么要新写一个（audit_qq_recall.ts 不够）────────────────────────────────
 * 现行线上判据（anti_recall.ts）是：
 *     body 变(40800) OR 转发缓存变(40900) OR 5/4 类型翻转
 * 这三样任何一个都拦。问题：**很多正常写也满足**——消息编辑、发图后 rkey 回填、
 * 引用/转发缓存刷新、语音转文字回写……它们都会改 40800/40900，于是被 RAISE 掉
 * （= 你观察到的“误判/不稳定”）。要收窄，得先拿到两组真实数据：
 *   (A) 真撤回的三连击，每一击到底改了什么、body 怎么长、撤回指纹何时出现；
 *   (B) 各种正常写，看它们命中现行判据(fire_cur)的情况。
 *
 * ── 关键假设：撤回灰条独有指纹 field 47704 (recallRevokeUid, tag=X'c2a517')──────
 * docs/anti-recall.md §5 已用它从 NEW.40800 提取撤回者 uid。普通消息 body 里不会
 * 有这个字段。若三连击**每一击**的 NEW.40800 都含 c2a517，判据就能收成：
 *     OLD.40002 IS NEW.40002  AND  会话命中  AND  instr(NEW.40800, X'c2a517') > 0
 * 去掉宽泛的 body/900 变动，正常编辑/回填/刷新全部放行 → 近乎零误判。
 * 本脚本就是来证实/证伪这个假设的——看 new_sig 是否从第一击(bodyLen≈88)就为 1。
 *
 * ── 诊断期会做的事（有副作用，看清楚）──────────────────────────────────────────
 *   • 临时把你现有的 weq_anti_recall_* 触发器**卸下**（SQL 先备份进 weq_narrow_meta，
 *     restore 一键还原）。→ 诊断期间**防撤回暂时失效**。
 *   • 装三表 AFTER UPDATE/INSERT/DELETE 的**纯记录**审计（绝不 RAISE）。
 *   • 因此你的测试撤回会**真的发生**（消息真被撤成 5/4）。审计只在“撤回行”顺带把
 *     OLD.40800 原文整块存进 orig_body 列，可事后手工恢复；正常写不存 blob，表不膨胀。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────────
 *   1) 关 QQ →  pnpm tsx packages/db/test/audit_recall_narrow.ts install
 *   2) 开 QQ → 在**被保护的会话**里制造样本：
 *        - 真撤回：小号发几条 → 撤回（本人撤 + 管理员撤他人各来一次）
 *        - 正常写：编辑一条消息、发一张图（等 rkey 回填）、发/收带引用的消息、
 *          语音转文字等——凡你怀疑“会被误拦”的操作都做一遍
 *   3) 关 QQ →  pnpm tsx packages/db/test/audit_recall_narrow.ts dump   # 逐行 + 汇总判读
 *   4) pnpm tsx packages/db/test/audit_recall_narrow.ts restore          # 还原真 trigger + 清审计
 *
 * 可选：dump [conv] 只看某会话（群号或 u_ uid）。
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv } from '@weq/testkit';

const KEY = testEnv.key;
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB = testEnv.msgDbPath;

const LOG = 'weq_narrow_log';
const META = 'weq_narrow_meta';

/** 撤回指纹：field 47704 recallRevokeUid 的 wire tag（撤回灰条独有）。 */
const SIG_REVOKE = `X'c2a517'`;
/** field 47703 recallSenderUid 的 wire tag（同为撤回灰条特征，做对照）。 */
const SIG_SENDER = `X'baa517'`;

/** 三张消息表 + 各自的会话过滤列（group=40027 群号 / c2c·dataline=40021 uid）。 */
const TABLES: ReadonlyArray<{ kind: string; table: string; convCol: string }> = [
  { kind: 'c2c', table: 'c2c_msg_table', convCol: '40021' },
  { kind: 'group', table: 'group_msg_table', convCol: '40027' },
  { kind: 'dataline', table: 'dataline_msg_table', convCol: '40021' },
];

const UPD_TRIGS = TABLES.map((t) => `weq_narrow_upd_${t.kind}`);
const INS_TRIGS = TABLES.map((t) => `weq_narrow_ins_${t.kind}`);
const DEL_TRIGS = TABLES.map((t) => `weq_narrow_del_${t.kind}`);
const ALL_TRIGS = [...UPD_TRIGS, ...INS_TRIGS, ...DEL_TRIGS];

function openDb(): QqDb {
  return new QqDb(loadNative().ntHelper, { dbPath: DB, key: KEY, algo: ALGO });
}
function assertClosed(): void {
  const pids = loadNative().ntHelper.getQqProcesses();
  if (pids.length) { console.error(`先关 QQ (pids: ${pids.join(',')})`); process.exit(1); }
}

// ── install ──────────────────────────────────────────────────────────────────

async function install(db: QqDb): Promise<void> {
  // 1) 备份并卸下现有真 trigger（诊断期需要让被拦的写真实落地）。
  await db.write(`CREATE TABLE IF NOT EXISTS ${META} (name TEXT PRIMARY KEY, sql TEXT)`);
  const real = await db.query(
    `SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'weq_anti_recall_%'`,
  );
  for (const r of real) {
    await db.write(`INSERT OR REPLACE INTO ${META}(name, sql) VALUES(?, ?)`, [r[0]!, r[1]!]);
  }
  for (const r of real) {
    await db.write(`DROP TRIGGER IF EXISTS ${String(r[0])}`);
  }
  console.log(`🔻 已备份并卸下真 trigger ${real.length} 个：${real.map((r) => r[0]).join(', ') || '(无)'}`);
  console.log('   ⚠️ 诊断期间防撤回失效，restore 会还原。');

  // 2) 审计日志表。每条“内容层 UPDATE”记一行，带足指纹。
  await db.write(`DROP TABLE IF EXISTS ${LOG}`);
  await db.write(`CREATE TABLE ${LOG} (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT, op TEXT, tbl TEXT, msgid INTEGER, conv TEXT,
    old_002 INTEGER, new_002 INTEGER,          -- msgRandom：撤回不变(放行判据依据)
    old_type TEXT, new_type TEXT,              -- 40011/40012
    old_blen INTEGER, new_blen INTEGER,        -- 40800 body 字节长度（看三连击 52→88→…）
    old_900len INTEGER, new_900len INTEGER,    -- 40900 转发/引用缓存长度
    old_sig INT, new_sig INT,                  -- OLD/NEW body 是否含 recallRevokeUid(c2a517)
    new_sender_sig INT,                        -- NEW body 是否含 recallSenderUid(baa517)
    old_head TEXT, new_head TEXT,              -- body 前 64 字节 hex（看结构演变）
    p_rand_same INT, p_body_chg INT, p_900_chg INT, p_type54 INT,
    fire_cur INT,    -- 现行宽判据：body变 OR 900变 OR 5/4翻（在“内容层”前提下）
    fire_sig INT,    -- 收窄候选①：仅 new body 含撤回指纹
    fire_sig54 INT,  -- 收窄候选②：指纹 OR 5/4（兜住可能不带指纹的中间态）
    orig_body BLOB   -- 仅撤回行存 OLD.40800 原文（可恢复）；正常写为 NULL
  )`);

  for (const t of ALL_TRIGS) await db.write(`DROP TRIGGER IF EXISTS ${t}`);

  // 3) 三表审计 trigger（纯记录，不 RAISE）。
  for (let i = 0; i < TABLES.length; i++) {
    const { kind, table, convCol } = TABLES[i]!;

    // 现行“内容层”条件（去掉会话过滤与 40002 放行，好把 WeQ 自己的写也一并看到）。
    const contentChg = `(NEW."40800" IS NOT OLD."40800"
        OR NEW."40900" IS NOT OLD."40900"
        OR (NEW."40011"=5 AND NEW."40012"=4 AND (IFNULL(OLD."40011",-1)<>5 OR IFNULL(OLD."40012",-1)<>4)))`;
    const sigNew = `instr(NEW."40800", ${SIG_REVOKE}) > 0`;
    const type54 = `(NEW."40011"=5 AND NEW."40012"=4 AND (IFNULL(OLD."40011",-1)<>5 OR IFNULL(OLD."40012",-1)<>4))`;
    const isRecall = `(${sigNew} OR (NEW."40011"=5 AND NEW."40012"=4))`;

    await db.write(`CREATE TRIGGER ${UPD_TRIGS[i]} AFTER UPDATE ON ${table}
      WHEN ${contentChg}
      BEGIN
        INSERT INTO ${LOG}(ts,op,tbl,msgid,conv,old_002,new_002,old_type,new_type,
          old_blen,new_blen,old_900len,new_900len,old_sig,new_sig,new_sender_sig,
          old_head,new_head,p_rand_same,p_body_chg,p_900_chg,p_type54,
          fire_cur,fire_sig,fire_sig54,orig_body)
        VALUES(strftime('%H:%M:%f','now'),'UPDATE','${kind}',OLD."40001",CAST(OLD."${convCol}" AS TEXT),
          OLD."40002",NEW."40002",
          OLD."40011"||'/'||OLD."40012", NEW."40011"||'/'||NEW."40012",
          length(OLD."40800"),length(NEW."40800"),
          length(OLD."40900"),length(NEW."40900"),
          (instr(OLD."40800", ${SIG_REVOKE})>0),(instr(NEW."40800", ${SIG_REVOKE})>0),
          (instr(NEW."40800", ${SIG_SENDER})>0),
          hex(substr(OLD."40800",1,64)),hex(substr(NEW."40800",1,64)),
          (OLD."40002" IS NEW."40002"),
          (NEW."40800" IS NOT OLD."40800"),(NEW."40900" IS NOT OLD."40900"),
          ${type54},
          1,                                   -- fire_cur：本行已满足 contentChg，恒 1
          (CASE WHEN ${sigNew} THEN 1 ELSE 0 END),
          (CASE WHEN ${sigNew} OR ${type54} THEN 1 ELSE 0 END),
          (CASE WHEN ${isRecall} THEN OLD."40800" ELSE NULL END));
      END`);

    // 撤回若走 delete+insert（文档说是就地 UPDATE，这里做对照兜底）。
    await db.write(`CREATE TRIGGER ${INS_TRIGS[i]} AFTER INSERT ON ${table}
      WHEN instr(NEW."40800", ${SIG_REVOKE})>0 OR (NEW."40011"=5 AND NEW."40012"=4)
      BEGIN
        INSERT INTO ${LOG}(ts,op,tbl,msgid,conv,new_type,new_blen,new_sig)
        VALUES(strftime('%H:%M:%f','now'),'INSERT','${kind}',NEW."40001",CAST(NEW."${convCol}" AS TEXT),
          NEW."40011"||'/'||NEW."40012",length(NEW."40800"),(instr(NEW."40800", ${SIG_REVOKE})>0));
      END`);
    await db.write(`CREATE TRIGGER ${DEL_TRIGS[i]} AFTER DELETE ON ${table}
      WHEN instr(OLD."40800", ${SIG_REVOKE})>0 OR (OLD."40011"=5 AND OLD."40012"=4)
      BEGIN
        INSERT INTO ${LOG}(ts,op,tbl,msgid,conv,old_type,old_blen,old_sig)
        VALUES(strftime('%H:%M:%f','now'),'DELETE','${kind}',OLD."40001",CAST(OLD."${convCol}" AS TEXT),
          OLD."40011"||'/'||OLD."40012",length(OLD."40800"),(instr(OLD."40800", ${SIG_REVOKE})>0));
      END`);
  }

  console.log('✅ 审计 trigger 已装（c2c/group/dataline，仅记录不拦截）。');
  console.log('   开 QQ → 制造样本（撤回 + 各种正常写）→ 关 QQ → dump');
}

// ── dump ─────────────────────────────────────────────────────────────────────

interface Row {
  seq: number; ts: string; op: string; tbl: string; msgid: string; conv: string;
  old002: string; new002: string; oldType: string; newType: string;
  oldBlen: number; newBlen: number; old900: number; new900: number;
  oldSig: number; newSig: number; senderSig: number;
  oldHead: string; newHead: string;
  randSame: number; bodyChg: number; p900: number; type54: number;
  fireCur: number; fireSig: number; fireSig54: number;
}

async function dump(db: QqDb, conv?: string): Promise<void> {
  const where = conv ? `WHERE conv = ${conv.startsWith('u_') ? `'${conv}'` : `'${conv}'`}` : '';
  const raw = await db.query(
    `SELECT seq,ts,op,tbl,msgid,conv,old_002,new_002,old_type,new_type,
       old_blen,new_blen,old_900len,new_900len,old_sig,new_sig,new_sender_sig,
       old_head,new_head,p_rand_same,p_body_chg,p_900_chg,p_type54,
       fire_cur,fire_sig,fire_sig54
     FROM ${LOG} ${where} ORDER BY seq`,
  ).catch(() => []);
  if (!raw.length) { console.log('日志为空（没抓到内容层写操作）。'); return; }

  const rows: Row[] = raw.map((r) => ({
    seq: Number(r[0]), ts: String(r[1]), op: String(r[2]), tbl: String(r[3]),
    msgid: String(r[4]), conv: String(r[5] ?? ''),
    old002: String(r[6] ?? ''), new002: String(r[7] ?? ''),
    oldType: String(r[8] ?? ''), newType: String(r[9] ?? ''),
    oldBlen: Number(r[10] ?? 0), newBlen: Number(r[11] ?? 0),
    old900: Number(r[12] ?? 0), new900: Number(r[13] ?? 0),
    oldSig: Number(r[14] ?? 0), newSig: Number(r[15] ?? 0), senderSig: Number(r[16] ?? 0),
    oldHead: String(r[17] ?? ''), newHead: String(r[18] ?? ''),
    randSame: Number(r[19] ?? 0), bodyChg: Number(r[20] ?? 0), p900: Number(r[21] ?? 0),
    type54: Number(r[22] ?? 0),
    fireCur: Number(r[23] ?? 0), fireSig: Number(r[24] ?? 0), fireSig54: Number(r[25] ?? 0),
  }));

  // 一条消息可能被三连击成多行——按 msgid 判定该消息是否“撤回序列”。
  const recallMsgIds = new Set(
    rows.filter((r) => r.newSig === 1 || r.type54 === 1).map((r) => r.msgid),
  );
  const isRecallRow = (r: Row): boolean => recallMsgIds.has(r.msgid);

  // ── 逐行（看三连击中间态）──
  console.log(`\n══════ 逐行明细 ${rows.length} 行 ══════`);
  let lastMsg = '';
  for (const r of rows) {
    if (r.msgid !== lastMsg) { console.log(''); lastMsg = r.msgid; }
    const tag = isRecallRow(r) ? '🔴撤回' : '⚪正常';
    if (r.op !== 'UPDATE') {
      console.log(`#${r.seq} [${r.ts}] ${r.op} ${tag} ${r.tbl} msg=${r.msgid} type=${r.oldType || r.newType} blen=${r.oldBlen || r.newBlen} sig=${r.oldSig || r.newSig}`);
      continue;
    }
    console.log(`#${r.seq} [${r.ts}] UPDATE ${tag} ${r.tbl} msg=${r.msgid} conv=${r.conv}`);
    console.log(`    002:${r.old002}${r.old002 === r.new002 ? '=' : `→${r.new002} ★变`}  type:${r.oldType}→${r.newType}  blen:${r.oldBlen}→${r.newBlen}  900:${r.old900}→${r.new900}`);
    console.log(`    sig: old=${r.oldSig} new=${r.newSig}  senderSig=${r.senderSig}   谓词: rand_same=${r.randSame} body=${r.bodyChg} 900=${r.p900} 54=${r.type54}`);
    console.log(`    判据: fire_cur=${r.fireCur}  fire_sig=${r.fireSig}  fire_sig54=${r.fireSig54}`);
    console.log(`    newHead=${r.newHead.slice(0, 48)}…`);
  }

  // ── 汇总（缩窄能否成立）──
  const recallRows = rows.filter((r) => r.op === 'UPDATE' && isRecallRow(r));
  const normalRows = rows.filter((r) => r.op === 'UPDATE' && !isRecallRow(r));

  const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${n}/${d} (${Math.round((100 * n) / d)}%)`);

  console.log(`\n══════ 汇总判读 ══════`);
  console.log(`撤回序列 msgId 数：${recallMsgIds.size}   撤回 UPDATE 行：${recallRows.length}   正常 UPDATE 行：${normalRows.length}\n`);

  console.log(`【撤回行】各判据召回（越高越好，理想 100%）`);
  console.log(`   fire_cur   命中 ${pct(recallRows.filter((r) => r.fireCur === 1).length, recallRows.length)}`);
  console.log(`   fire_sig   命中 ${pct(recallRows.filter((r) => r.fireSig === 1).length, recallRows.length)}`);
  console.log(`   fire_sig54 命中 ${pct(recallRows.filter((r) => r.fireSig54 === 1).length, recallRows.length)}`);
  const firstHitSig = recallRows.length && recallRows.every((r) => r.fireSig === 1);
  console.log(`   → 撤回三连击每一击都带指纹？ ${firstHitSig ? '✅ 是（fire_sig 可单独兜全部中间态）' : '❌ 否（存在不带指纹的中间态，需 fire_sig54 兜底）'}`);

  console.log(`\n【正常写行】各判据误伤（越低越好，理想 0%）`);
  console.log(`   fire_cur   误伤 ${pct(normalRows.filter((r) => r.fireCur === 1).length, normalRows.length)}   ← 这就是当前“误判”的量`);
  console.log(`   fire_sig   误伤 ${pct(normalRows.filter((r) => r.fireSig === 1).length, normalRows.length)}`);
  console.log(`   fire_sig54 误伤 ${pct(normalRows.filter((r) => r.fireSig54 === 1).length, normalRows.length)}`);

  // 列出被现行判据误伤的正常写（便于识别是哪种操作）。
  const misfired = normalRows.filter((r) => r.fireCur === 1);
  if (misfired.length) {
    console.log(`\n【被现行判据误伤的正常写 ${misfired.length} 行】(fire_cur=1 但非撤回)`);
    for (const r of misfired) {
      const cause = r.type54 ? '5/4翻转' : r.bodyChg && r.p900 ? 'body+900变' : r.bodyChg ? 'body变' : '900变';
      const savedBySig = r.fireSig === 0 ? '✅收窄后放行' : '⚠️收窄后仍拦';
      console.log(`   #${r.seq} ${r.tbl} msg=${r.msgid} 因[${cause}] type=${r.oldType}→${r.newType} blen=${r.oldBlen}→${r.newBlen}  ${savedBySig}`);
    }
  }

  console.log(`\n结论指引：若 fire_sig 撤回召回=100% 且正常写误伤=0% → 直接把判据换成 instr(NEW.40800,X'c2a517')>0；`);
  console.log(`          若有中间态不带指纹 → 用 fire_sig54（指纹 OR 5/4）；两者仍需保留 OLD.40002 IS NEW.40002 + 会话过滤。`);
}

// ── restore ──────────────────────────────────────────────────────────────────

async function restore(db: QqDb): Promise<void> {
  for (const t of ALL_TRIGS) await db.write(`DROP TRIGGER IF EXISTS ${t}`);
  const saved = await db.query(`SELECT name, sql FROM ${META}`).catch(() => []);
  let n = 0;
  for (const r of saved) {
    const sql = String(r[1] ?? '');
    if (sql) { await db.write(sql); n++; }
  }
  await db.write(`DROP TABLE IF EXISTS ${META}`);
  console.log(`✅ 审计已清理；还原真 trigger ${n} 个：${saved.map((r) => r[0]).join(', ') || '(无)'}`);
  console.log(`   日志表 ${LOG} 保留（含 orig_body 原文，可手工恢复被撤消息）。不需要就手动 DROP。`);
}

/**
 * 清空撤回记录表 weq_recall_log —— 现有行全是宽判据(body/900 变即拦)误记的假撤回
 * （backfill 命中、revokeUid 抽空→假“管理员撤回”），是脏数据，会干扰后续测试。
 * 只 DELETE 行、保留表结构（trigger/读取侧仍依赖它存在）。QQ 关着跑（是写操作）。
 */
async function purge(db: QqDb): Promise<void> {
  const exists = await db.query(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='weq_recall_log' LIMIT 1`,
  ).catch(() => []);
  if (!exists.length) { console.log('weq_recall_log 不存在，无需清空。'); return; }
  const before = Number((await db.query(`SELECT COUNT(*) FROM weq_recall_log`))[0]?.[0] ?? 0);
  await db.write(`DELETE FROM weq_recall_log`);
  console.log(`✅ weq_recall_log 已清空（删除 ${before} 行脏数据，表结构保留）。`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'dump';
  const db = openDb();
  try {
    if (cmd === 'install') { assertClosed(); await install(db); }
    else if (cmd === 'dump') { await dump(db, process.argv[3]); }
    else if (cmd === 'restore') { assertClosed(); await restore(db); }
    else if (cmd === 'purge') { assertClosed(); await purge(db); }
    else console.error('用法: install | dump [conv] | restore | purge');
  } finally {
    db.close();
  }
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
