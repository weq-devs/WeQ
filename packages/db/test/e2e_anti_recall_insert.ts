/**
 * 端到端验证新版 trigger（拦截 + 记录 + 补插灰条），全程在真库、但只针对一个
 * 指定测试群/消息，且用完即清，不碰你真实的 anti-recall 配置。
 *
 * 步骤：
 *   1. 用 AntiRecallDb 内部同款 SQL，针对 TEST_GROUP 装一个临时 trigger（名字带 _e2e_ 区分）
 *   2. 建记录表
 *   3. 造一次「撤回式 UPDATE」：把 TEST_MSG 的 40800 改成任意新 blob、40011/40012→5/4
 *      （模拟 QQ 撤回；40002 保持不变以命中放行判据）
 *   4. 读回验证：① 原 40800 是否保住 ② weq_recall_log 是否+1行 ③ 是否补插了 5/17 灰条
 *   5. 清理：删临时 trigger、删补插的灰条行、清空记录表里本次记录
 *
 *   ⚠️ 需要 QQ 关闭（写操作）。会短暂写库但全部可回滚。先备份更稳。
 *
 * Run: pnpm tsx packages/db/test/e2e_anti_recall_insert.ts <testGroupCode> <testMsgId>
 *   testMsgId 必须是该群里一条真实的普通消息（会被临时改写再恢复）。
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { decodeBody } from '../src/msg/util';

const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;

const TEST_GROUP = process.argv[2] ?? '673646675';
let TEST_MSG = BigInt(process.argv[3] ?? '0');

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

async function main(): Promise<void> {
  const nt = loadNative();
  if (nt.ntHelper.getQqProcesses().length) { console.error('先关 QQ'); process.exit(1); }

  const db = new QqDb(nt.ntHelper, { dbPath: DB, key: KEY, algo: ALGO });
  const TRIG = 'weq_anti_recall_e2e';

  try {
    // 没传 msgId → 自动从测试群挑一条最新的普通文本消息
    if (TEST_MSG === 0n) {
      const pick = await db.query(
        `SELECT "40001" FROM group_msg_table WHERE "40027"=? AND "40011"=2 AND "40012"=1 ORDER BY rowid DESC LIMIT 1`,
        [BigInt(TEST_GROUP)],
      );
      if (!pick.length) { console.error(`群 ${TEST_GROUP} 里找不到普通文本消息，手动传 msgId`); return; }
      TEST_MSG = pick[0]![0] as bigint;
      console.log(`自动选中测试消息 msgId=${TEST_MSG}`);
    }

    // 前置：读原始 40800 存着，最后核对是否保住
    const before = await db.query(`SELECT "40800","40033","40093","40003" FROM group_msg_table WHERE "40001"=? LIMIT 1`, [TEST_MSG]);
    if (!before.length) { console.error('测试消息不存在'); return; }
    const origBody = before[0]![0] as Uint8Array;
    console.log(`原消息: uin=${before[0]![1]} nick=${before[0]![2]} seq=${before[0]![3]} bodyLen=${origBody?.byteLength}`);

    // 1. 建记录表
    await db.write(`CREATE TABLE IF NOT EXISTS weq_recall_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, msgid INTEGER, conv TEXT, table_kind TEXT,
      sender_uid TEXT, revoke_uid TEXT, orig_seq INTEGER, recall_ts INTEGER, orig_body BLOB)`);

    // 2. 装临时 trigger（复刻新版 body，硬编码到 TEST_GROUP，含记录+补插+RAISE）
    await db.write(`DROP TRIGGER IF EXISTS ${TRIG}`);
    await db.write(buildE2eTrigger(TRIG, TEST_GROUP));

    // 记录补插前的行数、记录表行数
    const cntBefore = Number((await db.query(`SELECT COUNT(*) FROM group_msg_table WHERE "40027"=? AND "40011"=5 AND "40012"=17`, [TEST_GROUP]))[0]![0]);
    const logBefore = Number((await db.query(`SELECT COUNT(*) FROM weq_recall_log`))[0]![0]);

    // 3. 造一次撤回式 UPDATE：改 40800（用一个不同的 blob）+ 40011/40012→5/4，40002 不动
    const fakeRevokeBody = Buffer.concat([Buffer.from(origBody), Buffer.from([0x00])]); // 任意“变了”的 blob
    const affected = await db.write(
      `UPDATE group_msg_table SET "40800"=?, "40011"=5, "40012"=4 WHERE "40001"=?`,
      [fakeRevokeBody, TEST_MSG],
    );
    console.log(`\n撤回式 UPDATE affected=${affected}（期望 0：被 RAISE(IGNORE) 取消）`);

    // 4. 验证
    const after = await db.query(`SELECT "40800","40011","40012" FROM group_msg_table WHERE "40001"=? LIMIT 1`, [TEST_MSG]);
    const bodyKept = Buffer.from(after[0]![0] as Uint8Array).equals(Buffer.from(origBody));
    console.log(`① 原 body 保住? ${bodyKept ? '✅' : '❌'}  (40011/40012 现=${after[0]![1]}/${after[0]![2]}，期望仍 2/1)`);

    const logAfter = Number((await db.query(`SELECT COUNT(*) FROM weq_recall_log`))[0]![0]);
    console.log(`② 记录表 +${logAfter - logBefore} 行 ${logAfter - logBefore === 1 ? '✅' : '❌'}`);
    if (logAfter > logBefore) {
      const rec = await db.query(`SELECT msgid,conv,table_kind,sender_uid,revoke_uid,orig_seq,recall_ts,length(orig_body) FROM weq_recall_log ORDER BY seq DESC LIMIT 1`);
      console.log(`   记录: ${json(rec[0])}`);
    }

    const cntAfter = Number((await db.query(`SELECT COUNT(*) FROM group_msg_table WHERE "40027"=? AND "40011"=5 AND "40012"=17`, [TEST_GROUP]))[0]![0]);
    console.log(`③ 补插灰条 +${cntAfter - cntBefore} 行 ${cntAfter - cntBefore === 1 ? '✅' : '❌'}`);
    if (cntAfter > cntBefore) {
      const gt = await db.query(`SELECT "40001","40800" FROM group_msg_table WHERE "40027"=? AND "40011"=5 AND "40012"=17 ORDER BY "40001" DESC LIMIT 1`, [TEST_GROUP]);
      const els = decodeBody(gt[0]![1]);
      console.log(`   补插灰条 decode: ${json(els.map((e: any) => ({ kind: e.kind, tipJson: e.tipJson })))}`);
      // 清理：删掉这条补插的灰条
      await db.write(`DELETE FROM group_msg_table WHERE "40001"=?`, [gt[0]![0]]);
      console.log(`   （已清理补插的测试灰条 40001=${gt[0]![0]}）`);
    }

    // 5. 清理
    await db.write(`DROP TRIGGER IF EXISTS ${TRIG}`);
    await db.write(`DELETE FROM weq_recall_log`);
    await db.write(`DROP TABLE IF EXISTS weq_recall_log`);
    console.log('\n（已清理临时 trigger + 记录表）');
  } finally {
    db.close();
  }
}

/** 复刻 anti_recall.ts 新版 body，硬编码到一个群做 e2e。保持与源实现同构。 */
function buildE2eTrigger(name: string, group: string): string {
  const EL_HEAD = 'c8fc15d3a5efcfc6cff0ab6ad0fc1508d8fc1511', TIP_TAG = 'fac817', EL_TAIL = '80c9170088c917e11298c91700';
  const HEAD = EL_HEAD.length / 2 + TIP_TAG.length / 2, TAIL = EL_TAIL.length / 2;
  const PRE = `{"align":"center","items":[{"col":"3","jp":"tencent://ntqq-open?subCmd=profile&action=openMiniBuddyProfile&actionParams=%7B%22uin%22%3A%22`;
  const MID = `%22%2C%22sourceType%22%3A%22QrCodeShareBuddyLink%22%7D","txt":"`;
  const POST = `","type":"url"},{"txt":"撤回了一条消息","type":"nor"}]}`;
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const tip = `(${lit(PRE)} || CAST(OLD."40033" AS TEXT) || ${lit(MID)} || replace(replace(CAST(OLD."40093" AS TEXT), '\\', '\\\\'), '"', '\\"') || ${lit(POST)})`;
  const tipLen = `length(CAST(${tip} AS BLOB))`;
  const outerLen = `(${HEAD} + 2 + ${tipLen} + ${TAIL})`;
  const tipBlob = `CAST(X'82f613' || unhex(printf('%02x%02x',(${outerLen}&127)|128,(${outerLen}>>7)&127)) || X'${EL_HEAD}' || X'${TIP_TAG}' || unhex(printf('%02x%02x',(${tipLen}&127)|128,(${tipLen}>>7)&127)) || CAST(${tip} AS BLOB) || X'${EL_TAIL}' AS BLOB)`;
  const cols = ['40001','40002','40003','40010','40011','40012','40013','40020','40026','40021','40027','40040','40041','40050','40052','40090','40093','40800','40900','40105','40005','40058','40006','40100','40600','40060','40850','40851','40601','40801','40605','40030','40033','40062','40083','40084','40008','40009'];
  const val = (c: string): string => {
    switch (c) {
      case '40001': return `OLD."40001" + 10 + (abs(random()) % 41)`;
      case '40002': return `abs(random()) % 2147483647`;
      case '40003': return `OLD."40003" + 1`;
      case '40008': return `IFNULL(OLD."40008",0) + 1`;
      case '40011': return `5`; case '40012': return `17`;
      case '40050': return `strftime('%s','now')`; case '40058': return `strftime('%s','now')`;
      case '40800': return tipBlob;
      case '40900': case '40801': case '40062': case '40600': case '40601': case '40605': return `NULL`;
      default: return `OLD."${c}"`;
    }
  };
  const revokeUid = `CASE WHEN instr(NEW."40800", X'c2a517')>0 THEN CAST(substr(NEW."40800", instr(NEW."40800", X'c2a517')+4, 24) AS TEXT) ELSE '' END`;
  return `CREATE TRIGGER ${name} BEFORE UPDATE ON group_msg_table
WHEN OLD."40002" IS NEW."40002" AND OLD."40027" IN (${group})
  AND (NEW."40800" IS NOT OLD."40800" OR NEW."40900" IS NOT OLD."40900"
       OR (NEW."40011"=5 AND NEW."40012"=4 AND (IFNULL(OLD."40011",-1)<>5 OR IFNULL(OLD."40012",-1)<>4)))
BEGIN
  INSERT INTO weq_recall_log (msgid,conv,table_kind,sender_uid,revoke_uid,orig_seq,recall_ts,orig_body)
    VALUES (OLD."40001", CAST(OLD."40027" AS TEXT), 'group', OLD."40020", ${revokeUid}, OLD."40003", strftime('%s','now'), OLD."40800");
  INSERT INTO group_msg_table (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(val).join(',')});
  SELECT RAISE(IGNORE);
END`;
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
