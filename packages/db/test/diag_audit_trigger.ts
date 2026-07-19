/**
 * 诊断 trigger（只记录，绝不拦截）—— 定位"群聊 anti-recall 不触发"的根因。
 *
 * 在 group_msg_table 上装 INSERT / UPDATE / DELETE 三个审计触发器，每次操作都往
 * 我们自己的日志表 weq_trig_log 里 INSERT 一行。QQ 不认识这张表，不会碰它。
 *
 * UPDATE 触发器逐列拆开记录"线上 anti-recall 版触发器的每个谓词"的真假值，直接
 * 看撤回那一刻 SQLite 在 trigger 运行时上下文里到底怎么求值：
 *   p_rand_same   = (OLD.40002 IS NEW.40002)          期望 1
 *   p_in_mixed    = (OLD.40027 IN <线上混合列表>)       期望 1，若 0 就是根因
 *   p_in_num      = (OLD.40027 IN <纯数字>)            对照
 *   p_in_str      = (OLD.40027 IN <纯字符串>)          对照
 *   p_body_chg    = (NEW.40800 IS NOT OLD.40800)       撤回时期望 1
 *   p_900_chg     = (NEW.40900 IS NOT OLD.40900)
 *   p_type_54     = (NEW.40011=5 AND NEW.40012=4 …)
 *   old_g / new_g = OLD.40027 / NEW.40027 的真实值
 *   old_gt/new_gt = typeof(...)                        看运行时存储类
 *   would_fire    = 把线上完整 WHEN 整体算一遍                 ← 最关键
 *
 * 用法：
 *   pnpm tsx packages/db/test/diag_audit_trigger.ts install    # 关 QQ 后装
 *   （开 QQ → 发一条群消息 → 撤回 → 关 QQ）
 *   pnpm tsx packages/db/test/diag_audit_trigger.ts dump [群号] # 读日志
 *   pnpm tsx packages/db/test/diag_audit_trigger.ts uninstall   # 关 QQ 后清理
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv } from '@weq/testkit';

const KEY = testEnv.key;
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB = testEnv.msgDbPath;

// 线上 group 触发器实际用的混合 IN 列表（含目标测试群 673646675 与若干 u_）。
// 直接照搬形态，保证诊断与线上同构。
const MIXED_IN = `'1092701080', '673646675', 'u_DRENktQ9gS_Z02WOT6qugQ', 'u_ycOFKhEd7_qtOjfWv-UZLw', '1090396070'`;
const NUM_IN = `1092701080, 673646675, 1090396070`;
const STR_IN = `'1092701080', '673646675', '1090396070'`;

const LOG = 'weq_trig_log';
const TRIGGERS = ['weq_diag_ins', 'weq_diag_upd', 'weq_diag_del'];

function openDb(): QqDb {
  const nt = loadNative();
  return new QqDb(nt.ntHelper, { dbPath: DB, key: KEY, algo: ALGO });
}

async function assertQqClosed(): Promise<void> {
  const nt = loadNative();
  const pids = nt.ntHelper.getQqProcesses();
  if (pids.length) throw new Error(`QQ 还在运行 (pids: ${pids.join(',')})，请先完全关闭 QQ。`);
}

/** 线上完整 WHEN 表达式（照搬 anti_recall.ts，用于 would_fire 整体求值）。 */
const FULL_WHEN = `(OLD."40002" IS NEW."40002"
  AND OLD."40027" IN (${MIXED_IN})
  AND (
    NEW."40800" IS NOT OLD."40800"
    OR NEW."40900" IS NOT OLD."40900"
    OR (NEW."40011" = 5 AND NEW."40012" = 4
        AND (IFNULL(OLD."40011", -1) <> 5 OR IFNULL(OLD."40012", -1) <> 4))
  ))`;

async function install(db: QqDb): Promise<void> {
  await db.write(
    `CREATE TABLE IF NOT EXISTS ${LOG} (
       seq INTEGER PRIMARY KEY AUTOINCREMENT,
       op TEXT, msgid INTEGER,
       old_g, new_g, old_gt TEXT, new_gt TEXT,
       p_rand_same INT, p_in_mixed INT, p_in_num INT, p_in_str INT,
       p_body_chg INT, p_900_chg INT, p_type_54 INT,
       old_type INT, new_type INT, old_sub INT, new_sub INT,
       would_fire INT
     )`,
  );

  // UPDATE：全量谓词审计
  await db.write(
    `CREATE TRIGGER weq_diag_upd AFTER UPDATE ON group_msg_table
     BEGIN
       INSERT INTO ${LOG}(op,msgid,old_g,new_g,old_gt,new_gt,
         p_rand_same,p_in_mixed,p_in_num,p_in_str,p_body_chg,p_900_chg,p_type_54,
         old_type,new_type,old_sub,new_sub,would_fire)
       VALUES('UPDATE', OLD."40001", OLD."40027", NEW."40027",
         typeof(OLD."40027"), typeof(NEW."40027"),
         (OLD."40002" IS NEW."40002"),
         (OLD."40027" IN (${MIXED_IN})),
         (OLD."40027" IN (${NUM_IN})),
         (OLD."40027" IN (${STR_IN})),
         (NEW."40800" IS NOT OLD."40800"),
         (NEW."40900" IS NOT OLD."40900"),
         (NEW."40011"=5 AND NEW."40012"=4 AND (IFNULL(OLD."40011",-1)<>5 OR IFNULL(OLD."40012",-1)<>4)),
         OLD."40011", NEW."40011", OLD."40012", NEW."40012",
         CASE WHEN ${FULL_WHEN} THEN 1 ELSE 0 END);
     END`,
  );

  // INSERT：记录（撤回若是 delete+insert，这里会看到）
  await db.write(
    `CREATE TRIGGER weq_diag_ins AFTER INSERT ON group_msg_table
     BEGIN
       INSERT INTO ${LOG}(op,msgid,new_g,new_gt,new_type,new_sub)
       VALUES('INSERT', NEW."40001", NEW."40027", typeof(NEW."40027"), NEW."40011", NEW."40012");
     END`,
  );

  // DELETE：记录
  await db.write(
    `CREATE TRIGGER weq_diag_del AFTER DELETE ON group_msg_table
     BEGIN
       INSERT INTO ${LOG}(op,msgid,old_g,old_gt,old_type,old_sub)
       VALUES('DELETE', OLD."40001", OLD."40027", typeof(OLD."40027"), OLD."40011", OLD."40012");
     END`,
  );

  console.log('✅ 诊断 trigger 已装（weq_diag_ins/upd/del）+ 日志表 weq_trig_log。');
  console.log('   现在：开 QQ → 在群里发一条消息 → 撤回它 → 关 QQ → 跑 dump。');
}

async function dump(db: QqDb, group?: string): Promise<void> {
  const where = group ? `WHERE old_g = ${group} OR new_g = ${group}` : '';
  const rows = await db.query(`SELECT * FROM ${LOG} ${where} ORDER BY seq`);
  if (!rows.length) { console.log('（日志为空——QQ 没产生写操作，或没撤回成功）'); return; }
  const cols = await db.query(`PRAGMA table_info(${LOG})`);
  const names = cols.map((c) => String(c[1]));
  console.log(`日志 ${rows.length} 行：\n`);
  for (const r of rows) {
    const o: Record<string, unknown> = {};
    names.forEach((n, i) => {
      o[n] = r[i];
    });
    console.log(`#${o.seq} ${o.op} msg=${o.msgid}`);
    if (o.op === 'UPDATE') {
      console.log(`   40027: OLD=${o.old_g}(${o.old_gt})  NEW=${o.new_g}(${o.new_gt})`);
      console.log(`   type:  OLD=${o.old_type}/${o.old_sub}  NEW=${o.new_type}/${o.new_sub}`);
      console.log(`   谓词:  rand_same=${o.p_rand_same}  in_mixed=${o.p_in_mixed}  in_num=${o.p_in_num}  in_str=${o.p_in_str}`);
      console.log(`          body_chg=${o.p_body_chg}  900_chg=${o.p_900_chg}  type_54=${o.p_type_54}`);
      console.log(`   >>> would_fire(线上完整WHEN) = ${o.would_fire} ${Number(o.would_fire) === 1 ? '(该拦住)' : '❌(没触发→根因在这一行谓词里找 0)'}`);
    } else {
      console.log(`   40027: ${o.old_g ?? o.new_g}(${o.old_gt ?? o.new_gt})  type=${o.old_type ?? o.new_type}/${o.old_sub ?? o.new_sub}`);
    }
    console.log('');
  }
}

async function uninstall(db: QqDb): Promise<void> {
  for (const t of TRIGGERS) await db.write(`DROP TRIGGER IF EXISTS ${t}`);
  await db.write(`DROP TABLE IF EXISTS ${LOG}`);
  console.log('✅ 诊断 trigger + 日志表已清理（你的 3 个 weq_anti_recall_* 不受影响）。');
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'dump';
  const db = openDb();
  try {
    if (cmd === 'install') { await assertQqClosed(); await install(db); }
    else if (cmd === 'dump') { await dump(db, process.argv[3]); }
    else if (cmd === 'uninstall') { await assertQqClosed(); await uninstall(db); }
    else console.error('用法: install | dump [群号] | uninstall');
  } finally {
    db.close();
  }
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
