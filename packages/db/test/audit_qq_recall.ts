/**
 * 审计 QQ 真实撤回：装一个**只记录不拦截**的 AFTER + BEFORE 双 trigger，把 QQ 撤回
 * 那一刻对 group_msg_table 的每次 UPDATE 全量记进日志表 weq_qq_audit，重点看：
 *   - 撤回是 1 次 UPDATE 还是多次（分步写）
 *   - 每次 UPDATE 时 OLD/NEW 的 40002/40011/40012/40800长度 各是什么
 *   - 我们真实 WHEN 的每个子句在那一刻真假：
 *       p_rand_same = OLD.40002 IS NEW.40002   ← 放行判据，若 QQ 撤回时=0 就是元凶！
 *       p_in        = OLD.40027 IN (673646675)
 *       p_body_chg  = NEW.40800 IS NOT OLD.40800
 *       p_type54    = NEW 5/4 且 OLD 非5/4
 *       would_fire  = 完整 WHEN
 *   - INSERT/DELETE 也记（撤回若走 delete+insert 就现形）
 *
 * 只记录、绝不 RAISE，所以 QQ 撤回照常发生（原消息会变 5/4）——这是**牺牲一条测试
 * 消息换取真相**。用完 cleanup。
 *
 * 用法：
 *   1) 关 QQ →  pnpm tsx packages/db/test/audit_qq_recall.ts install
 *   2) 开 QQ → 小号发消息 → 撤回 → 关 QQ
 *   3) pnpm tsx packages/db/test/audit_qq_recall.ts dump
 *   4) pnpm tsx packages/db/test/audit_qq_recall.ts cleanup
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const GROUP = process.argv[3] ?? '673646675';
const CMD = process.argv[2] ?? 'dump';
const LOG = 'weq_qq_audit';
const TRIGS = ['weq_audit_upd', 'weq_audit_ins', 'weq_audit_del'];

function openDb(): QqDb {
  const nt = loadNative();
  return new QqDb(nt.ntHelper, { dbPath: DB, key: KEY, algo: ALGO });
}
function assertClosed(): void {
  if (loadNative().ntHelper.getQqProcesses().length) { console.error('先关 QQ'); process.exit(1); }
}

async function install(db: QqDb): Promise<void> {
  await db.write(`DROP TABLE IF EXISTS ${LOG}`);
  await db.write(`CREATE TABLE ${LOG} (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, op TEXT, msgid INTEGER,
    old_002 INTEGER, new_002 INTEGER, old_1112 TEXT, new_1112 TEXT,
    old_bodylen INTEGER, new_bodylen INTEGER,
    p_rand_same INT, p_in INT, p_body_chg INT, p_900_chg INT, p_type54 INT, would_fire INT)`);
  for (const t of TRIGS) await db.write(`DROP TRIGGER IF EXISTS ${t}`);

  // AFTER UPDATE：只记录（不拦），全量抓每次 UPDATE
  await db.write(`CREATE TRIGGER weq_audit_upd AFTER UPDATE ON group_msg_table
    WHEN OLD."40027" = ${GROUP}
    BEGIN
      INSERT INTO ${LOG}(ts,op,msgid,old_002,new_002,old_1112,new_1112,old_bodylen,new_bodylen,
        p_rand_same,p_in,p_body_chg,p_900_chg,p_type54,would_fire)
      VALUES(strftime('%H:%M:%f','now'),'UPDATE',OLD."40001",
        OLD."40002",NEW."40002",
        OLD."40011"||'/'||OLD."40012", NEW."40011"||'/'||NEW."40012",
        length(OLD."40800"), length(NEW."40800"),
        (OLD."40002" IS NEW."40002"),
        (OLD."40027" IN (${GROUP})),
        (NEW."40800" IS NOT OLD."40800"),
        (NEW."40900" IS NOT OLD."40900"),
        (NEW."40011"=5 AND NEW."40012"=4 AND (IFNULL(OLD."40011",-1)<>5 OR IFNULL(OLD."40012",-1)<>4)),
        (CASE WHEN OLD."40002" IS NEW."40002" AND OLD."40027" IN (${GROUP})
              AND (NEW."40800" IS NOT OLD."40800" OR NEW."40900" IS NOT OLD."40900"
                   OR (NEW."40011"=5 AND NEW."40012"=4 AND (IFNULL(OLD."40011",-1)<>5 OR IFNULL(OLD."40012",-1)<>4)))
         THEN 1 ELSE 0 END));
    END`);
  await db.write(`CREATE TRIGGER weq_audit_ins AFTER INSERT ON group_msg_table
    WHEN NEW."40027" = ${GROUP}
    BEGIN INSERT INTO ${LOG}(ts,op,msgid,new_1112,new_bodylen) VALUES(strftime('%H:%M:%f','now'),'INSERT',NEW."40001",NEW."40011"||'/'||NEW."40012",length(NEW."40800")); END`);
  await db.write(`CREATE TRIGGER weq_audit_del AFTER DELETE ON group_msg_table
    WHEN OLD."40027" = ${GROUP}
    BEGIN INSERT INTO ${LOG}(ts,op,msgid,old_1112,old_bodylen) VALUES(strftime('%H:%M:%f','now'),'DELETE',OLD."40001",OLD."40011"||'/'||OLD."40012",length(OLD."40800")); END`);

  console.log('✅ 审计 trigger 已装（只记录，不拦截）。开 QQ → 发消息 → 撤回 → 关 QQ → dump');
}

async function dump(db: QqDb): Promise<void> {
  const rows = await db.query(`SELECT ts,op,msgid,old_002,new_002,old_1112,new_1112,old_bodylen,new_bodylen,p_rand_same,p_in,p_body_chg,p_900_chg,p_type54,would_fire FROM ${LOG} ORDER BY seq`).catch(() => []);
  if (!rows.length) { console.log('日志为空（没抓到该群的写操作）'); return; }
  console.log(`审计日志 ${rows.length} 行：\n`);
  for (const r of rows) {
    if (r[1] === 'UPDATE') {
      console.log(`[${r[0]}] UPDATE msg=${r[2]}`);
      console.log(`   40002: ${r[3]} → ${r[4]}  ${String(r[3])===String(r[4])?'(不变)':'★变了！'}`);
      console.log(`   type:  ${r[5]} → ${r[6]}   bodyLen: ${r[7]} → ${r[8]}`);
      console.log(`   谓词: rand_same=${r[9]} in=${r[10]} body_chg=${r[11]} 900_chg=${r[12]} type54=${r[13]}`);
      console.log(`   >>> would_fire = ${r[14]} ${Number(r[14])===1?'(应拦+补插)':'❌ 没命中WHEN'}`);
    } else {
      console.log(`[${r[0]}] ${r[1]} msg=${r[2]} type=${r[1]==='INSERT'?r[6]:r[5]} bodyLen=${r[1]==='INSERT'?r[8]:r[7]}`);
    }
    console.log('');
  }
}

async function cleanup(db: QqDb): Promise<void> {
  for (const t of TRIGS) await db.write(`DROP TRIGGER IF EXISTS ${t}`);
  await db.write(`DROP TABLE IF EXISTS ${LOG}`);
  console.log('✅ 审计 trigger + 日志表已清理');
}

async function main(): Promise<void> {
  const db = openDb();
  try {
    if (CMD === 'install') { assertClosed(); await install(db); }
    else if (CMD === 'dump') { await dump(db); }
    else if (CMD === 'cleanup') { assertClosed(); await cleanup(db); }
    else console.error('用法: install | dump | cleanup  [群号]');
  } finally { db.close(); }
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
