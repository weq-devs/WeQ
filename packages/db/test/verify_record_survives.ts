/**
 * 真机验证方案C 地基：BEFORE UPDATE + RAISE(IGNORE) 拦截 + 写记录表（不补插灰条）。
 * QQ 真实撤回（单事务3连击）下：① 原文保住吗 ② 记录表能活吗（WeQ 靠它补插）。
 *
 * 拦截判据每次都成立（不加幂等锁到 WHEN，避免第一次拦后放行后续）；记录表用
 * INSERT OR IGNORE + msgid 唯一，天然去重（同一 msgid 3 连击只记一次）。
 *
 * 用法：
 *   1) 关 QQ → pnpm tsx packages/db/test/verify_record_survives.ts install
 *   2) 开 QQ → 小号群里发消息 → 撤回 → 关 QQ
 *   3) pnpm tsx packages/db/test/verify_record_survives.ts verify
 *   4) pnpm tsx packages/db/test/verify_record_survives.ts cleanup
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB = process.env.WEQ_TEST_DB_PATH ?? String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const GROUP = process.argv[3] ?? '673646675';
const CMD = process.argv[2] ?? 'verify';
const TRIG = 'weq_anti_recall_group';

function openDb(): QqDb { return new QqDb(loadNative().ntHelper, { dbPath: DB, key: KEY, algo: ALGO }); }
function assertClosed(): void { if (loadNative().ntHelper.getQqProcesses().length) { console.error('先关 QQ'); process.exit(1); } }

async function install(db: QqDb): Promise<void> {
  // 记录表：msgid 唯一约束 → INSERT OR IGNORE 天然对同一 msgid 去重
  await db.write(`CREATE TABLE IF NOT EXISTS weq_recall_log (
    msgid INTEGER PRIMARY KEY, conv TEXT, table_kind TEXT, sender_uid TEXT, revoke_uid TEXT,
    orig_seq INTEGER, recall_ts INTEGER, orig_body BLOB)`);
  await db.write(`DROP TRIGGER IF EXISTS ${TRIG}`);
  // 拦截 + 记录（OR IGNORE 去重）。WHEN 不含幂等锁 → 3 连击每次都拦。
  await db.write(
    `CREATE TRIGGER ${TRIG} BEFORE UPDATE ON group_msg_table
     WHEN OLD."40002" IS NEW."40002" AND OLD."40027" IN (${GROUP})
       AND (NEW."40800" IS NOT OLD."40800" OR NEW."40900" IS NOT OLD."40900"
            OR (NEW."40011"=5 AND NEW."40012"=4 AND (IFNULL(OLD."40011",-1)<>5 OR IFNULL(OLD."40012",-1)<>4)))
     BEGIN
       INSERT OR IGNORE INTO weq_recall_log(msgid,conv,table_kind,sender_uid,revoke_uid,orig_seq,recall_ts,orig_body)
         VALUES(OLD."40001", CAST(OLD."40027" AS TEXT), 'group', OLD."40020",
                CASE WHEN instr(NEW."40800", X'c2a517')>0 THEN CAST(substr(NEW."40800", instr(NEW."40800", X'c2a517')+4, 24) AS TEXT) ELSE '' END,
                OLD."40003", strftime('%s','now'), OLD."40800");
       SELECT RAISE(IGNORE);
     END`,
  );
  console.log('✅ 装好：拦截 + 记录表(不补插灰条)。开 QQ → 发消息 → 撤回 → 关 QQ → verify');
}

async function verify(db: QqDb): Promise<void> {
  const log = await db.query(`SELECT msgid,sender_uid,revoke_uid,orig_seq,recall_ts,length(orig_body) FROM weq_recall_log ORDER BY recall_ts DESC LIMIT 10`).catch(() => []);
  console.log(`=== weq_recall_log ${log.length} 行 ===`);
  for (const r of log) {
    const own = String(r[1]) === String(r[2]);
    console.log(`  msg=${r[0]} sender=${r[1]} revoke=${r[2]} ${r[2] ? (own?'(本人)':'(★他人/管理员)') : '(未提取)'} seq=${r[3]} ts=${r[4]} bodyLen=${r[5]}`);
  }
  // 记录里每条 msgid 的原消息现状（是否被撤=5/4，还是保住=2/x）
  console.log(`\n=== 记录表里各 msgid 的原消息现状 ===`);
  for (const r of log) {
    const cur = await db.query(`SELECT "40011","40012",length("40800") FROM group_msg_table WHERE "40001"=?`, [r[0] as bigint]).catch(() => []);
    if (cur.length) {
      const kept = String(cur[0]![0]) === '2';
      console.log(`  msg=${r[0]}  现 ${cur[0]![0]}/${cur[0]![1]} bodyLen=${cur[0]![2]}  ${kept?'✅ 原文保住(拦截成功)':'❌ 变5/4(没拦住)'}`);
    }
  }
  console.log(`\n=== 判读 ===`);
  console.log(`  记录表≥1 且 原消息保住(2/x) → ★方案C地基成立！QQ单事务下 拦截+记录 都活。`);
  console.log(`  记录表=0 → 记录被 QQ 单事务的 RAISE 废掉，方案C此路不通。`);
  console.log(`  记录表≥1 但 原消息变5/4 → 记录活了但没拦住（WHEN 或时序问题）。`);
}

async function cleanup(db: QqDb): Promise<void> {
  await db.write(`DROP TRIGGER IF EXISTS ${TRIG}`);
  await db.write(`DROP TABLE IF EXISTS weq_recall_log`);
  console.log('✅ 清理完成（卸 trigger + 删记录表）');
}

async function main(): Promise<void> {
  const db = openDb();
  try {
    if (CMD === 'install') { assertClosed(); await install(db); }
    else if (CMD === 'verify') { await verify(db); }
    else if (CMD === 'cleanup') { assertClosed(); await cleanup(db); }
    else console.error('用法: install | verify | cleanup [群号]');
  } finally { db.close(); }
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
