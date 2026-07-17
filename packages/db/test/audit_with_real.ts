/**
 * 真相已明：QQ 撤回是 3 连击 UPDATE（body 52→88→128→153），每次 would_fire=1。
 * 真实 trigger 每次 BEFORE UPDATE 都 RAISE(IGNORE)+补插，但最终一条灰条都不剩。
 *
 * 本探测：真实 anti-recall trigger + 审计 trigger 并存，让 QQ 撤一次，看：
 *   - 真 trigger 每次触发时补插了没（审计 INSERT 会记录 5/17 灰条的插入）
 *   - 3 次 RAISE(IGNORE) 之间，补插的灰条为何最终消失
 * 猜想：RAISE(IGNORE) 只取消“当前行的 UPDATE”，但补插的 INSERT 是独立的、应留存。
 *   若审计显示“补插INSERT发生了3次但最终0条” → 是后续某步把它们删了（QQ？还是
 *   RAISE 的事务回滚？）。若“补插INSERT一次都没发生” → BEFORE+RAISE 下同表INSERT
 *   在 QQ 的多语句事务里被特殊处理。
 *
 * ⚠️ 只记录用；这里会装**真** trigger（会拦截+试图补插），撤回不会真的成功（被拦），
 *    但审计能看到 trigger 内部的 INSERT 行为。需要 QQ 参与。
 *
 * 用法：
 *   1) 关 QQ → pnpm tsx packages/db/test/audit_with_real.ts install
 *   2) 开 QQ → 小号发消息 → 撤回 → 关 QQ
 *   3) pnpm tsx packages/db/test/audit_with_real.ts dump
 *   4) pnpm tsx packages/db/test/audit_with_real.ts cleanup
 */
import { loadNative } from '@weq/native';
import { AntiRecallDb } from '../src/msg/anti_recall';
import { QqDb } from '../src/qq_db';

const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const GROUP = process.argv[3] ?? '673646675';
const CMD = process.argv[2] ?? 'dump';
const LOG = 'weq_qq_audit2';

function openDb(): QqDb {
  return new QqDb(loadNative().ntHelper, { dbPath: DB, key: KEY, algo: ALGO });
}
function assertClosed(): void {
  if (loadNative().ntHelper.getQqProcesses().length) { console.error('先关 QQ'); process.exit(1); }
}

async function install(db: QqDb): Promise<void> {
  // 1. 装真实 anti-recall trigger（拦截+记录+补插）
  const ar = new AntiRecallDb(loadNative().ntHelper, { dbPath: DB, key: KEY, algo: ALGO });
  await ar.reconcile([{ kind: 'group', id: GROUP }]);
  ar.close();

  // 2. 装审计表 + AFTER INSERT/DELETE 审计（AFTER UPDATE 会被真trigger的RAISE挡掉，所以
  //    只能靠 INSERT/DELETE 审计观察真trigger内部补插的 INSERT 是否发生）
  await db.write(`DROP TABLE IF EXISTS ${LOG}`);
  await db.write(`CREATE TABLE ${LOG}(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, op TEXT, msgid INTEGER, type TEXT, bodylen INTEGER)`);
  await db.write(`DROP TRIGGER IF EXISTS weq_a2_ins`);
  await db.write(`DROP TRIGGER IF EXISTS weq_a2_del`);
  await db.write(`CREATE TRIGGER weq_a2_ins AFTER INSERT ON group_msg_table WHEN NEW."40027"=${GROUP}
    BEGIN INSERT INTO ${LOG}(ts,op,msgid,type,bodylen) VALUES(strftime('%H:%M:%f','now'),'INSERT',NEW."40001",NEW."40011"||'/'||NEW."40012",length(NEW."40800")); END`);
  await db.write(`CREATE TRIGGER weq_a2_del AFTER DELETE ON group_msg_table WHEN OLD."40027"=${GROUP}
    BEGIN INSERT INTO ${LOG}(ts,op,msgid,type,bodylen) VALUES(strftime('%H:%M:%f','now'),'DELETE',OLD."40001",OLD."40011"||'/'||OLD."40012",length(OLD."40800")); END`);
  console.log('✅ 真trigger + 审计(INSERT/DELETE) 已装。开 QQ → 发消息 → 撤回 → 关 QQ → dump');
  console.log('   注意：审计表名 weq_qq_audit2；真trigger的记录表是 weq_recall_log');
}

async function dump(db: QqDb): Promise<void> {
  const audit = await db.query(`SELECT ts,op,msgid,type,bodylen FROM ${LOG} ORDER BY seq`).catch(() => []);
  console.log(`=== 审计(INSERT/DELETE事件) ${audit.length} 行 ===`);
  for (const r of audit) console.log(`  [${r[0]}] ${r[1]} msg=${r[2]} type=${r[3]} bodyLen=${r[4]}`);

  const log = await db.query(`SELECT msgid,sender_uid,revoke_uid,orig_seq,recall_ts FROM weq_recall_log ORDER BY seq`).catch(() => []);
  console.log(`\n=== 真trigger记录表 weq_recall_log ${log.length} 行 ===`);
  for (const r of log) console.log(`  msg=${r[0]} sender=${r[1]} revoke=${r[2]} seq=${r[3]} ts=${r[4]}`);

  const gt = await db.query(`SELECT "40001","40003" FROM group_msg_table WHERE "40027"=? AND "40011"=5 AND "40012"=17 AND instr(CAST("40800" AS TEXT),'撤回了一条消息')>0`, [BigInt(GROUP)]).catch(() => []);
  console.log(`\n=== 现存"撤回了一条消息"灰条 ${gt.length} 条 ===`);
  for (const r of gt) console.log(`  msg=${r[0]} seq=${r[1]}`);

  console.log('\n=== 判读 ===');
  console.log(`  审计里 5/17 的 INSERT 次数 = 真trigger补插触发次数；记录表行数 = 记录INSERT成功次数`);
  console.log(`  若 INSERT有 但 现存灰条=0 → 补插后被 DELETE（看审计有无 DELETE 5/17）或被 RAISE 回滚`);
}

async function cleanup(db: QqDb): Promise<void> {
  await new AntiRecallDb(loadNative().ntHelper, { dbPath: DB, key: KEY, algo: ALGO }).reconcile([]);
  await db.write(`DROP TRIGGER IF EXISTS weq_a2_ins`);
  await db.write(`DROP TRIGGER IF EXISTS weq_a2_del`);
  await db.write(`DROP TABLE IF EXISTS ${LOG}`);
  await db.write(`DROP TABLE IF EXISTS weq_recall_log`);
  const del = await db.write(`DELETE FROM group_msg_table WHERE "40027"=? AND "40011"=5 AND "40012"=17 AND instr(CAST("40800" AS TEXT),'撤回了一条消息')>0`, [BigInt(GROUP)]);
  console.log(`✅ 清理完成（删灰条 ${del} 行）`);
}

async function main(): Promise<void> {
  const db = openDb();
  try {
    if (CMD === 'install') { assertClosed(); await install(db); }
    else if (CMD === 'dump') { await dump(db); }
    else if (CMD === 'cleanup') { assertClosed(); await cleanup(db); }
    else console.error('用法: install | dump | cleanup [群号]');
  } finally { db.close(); }
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
