/**
 * 让被 RAISE(IGNORE) 吞掉的 INSERT 报错吐出来：把 trigger body 里的两条 INSERT
 * 搬到普通连接手动执行（OLD."col" → 靶子消息的真实值），SQLite 的真实报错就会
 * 原样抛出，精确定位哪条挂、为什么（UNIQUE? NULL毒化? blob?）。
 *
 * 靶子 = 群里一条真实普通消息（模拟"被撤消息"的 OLD）。两条 INSERT：
 *   ① INSERT 记录表
 *   ② INSERT 补插灰条（40003=OLD+1，最可能撞 group UNIQUE(40027,40003,40002)）
 * 各自独立 try，报错单独打印。会真写入，故末尾清理掉插入的行 + 记录表。
 *
 * ⚠️ 需关 QQ。补插灰条那条若成功会真插一行，脚本会删掉它。
 * Run: pnpm tsx packages/db/test/probe_insert_error.ts [群号] [靶子msgId可选]
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv } from '@weq/testkit';

const KEY = testEnv.key;
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB = testEnv.msgDbPath;
const GROUP = process.argv[2] ?? '673646675';

const MSG_COLUMNS = ['40001','40002','40003','40010','40011','40012','40013','40020','40026','40021','40027','40040','40041','40050','40052','40090','40093','40800','40900','40105','40005','40058','40006','40100','40600','40060','40850','40851','40601','40801','40605','40030','40033','40062','40083','40084','40008','40009'];

const EL_HEAD='c8fc15d3a5efcfc6cff0ab6ad0fc1508d8fc1511',TIP_TAG='fac817',EL_TAIL='80c9170088c917e11298c91700';
const HEAD=EL_HEAD.length/2+TIP_TAG.length/2, TAIL=EL_TAIL.length/2;
const lit=(s:string)=>`'${s.replace(/'/g,"''")}'`;
const PRE=`{"align":"center","items":[{"col":"3","jp":"tencent://ntqq-open?subCmd=profile&action=openMiniBuddyProfile&actionParams=%7B%22uin%22%3A%22`;
const MID=`%22%2C%22sourceType%22%3A%22QrCodeShareBuddyLink%22%7D","txt":"`;
const POST=`","type":"url"},{"txt":"撤回了一条消息","type":"nor"}]}`;

// 用"从靶子行读出的真实值"替换 OLD."col" —— 直接把子查询嵌进去（SELECT ... FROM src）
function graytipVal(c: string, srcRef: string): string {
  switch (c) {
    case '40001': return `${srcRef}."40001" + 10 + (abs(random()) % 41)`;
    case '40002': return `abs(random()) % 2147483647`;
    case '40003': return `${srcRef}."40003" + 1`;
    case '40008': return `IFNULL(${srcRef}."40008",0) + 1`;
    case '40011': return `5`; case '40012': return `17`;
    case '40050': return `strftime('%s','now')`; case '40058': return `strftime('%s','now')`;
    case '40800': {
      const tip=`(${lit(PRE)} || CAST(${srcRef}."40033" AS TEXT) || ${lit(MID)} || replace(replace(CAST(${srcRef}."40093" AS TEXT),'\\','\\\\'),'"','\\"') || ${lit(POST)})`;
      const tl=`length(CAST(${tip} AS BLOB))`, ol=`(${HEAD} + 2 + ${tl} + ${TAIL})`;
      return `CAST(X'82f613' || unhex(printf('%02x%02x',(${ol}&127)|128,(${ol}>>7)&127)) || X'${EL_HEAD}' || X'${TIP_TAG}' || unhex(printf('%02x%02x',(${tl}&127)|128,(${tl}>>7)&127)) || CAST(${tip} AS BLOB) || X'${EL_TAIL}' AS BLOB)`;
    }
    case '40900': case '40801': case '40062': case '40600': case '40601': case '40605': return `NULL`;
    default: return `${srcRef}."${c}"`;
  }
}

async function main(): Promise<void> {
  const nt = loadNative();
  if (nt.ntHelper.getQqProcesses().length) { console.error('先关 QQ'); process.exit(1); }
  const db = new QqDb(nt.ntHelper, { dbPath: DB, key: KEY, algo: ALGO });

  try {
    // 靶子：一条真实普通消息
    const pick = process.argv[3]
      ? [{ 0: BigInt(process.argv[3]) }] as any
      : await db.query(`SELECT "40001" FROM group_msg_table WHERE "40027"=? AND "40011"=2 AND "40012"=1 ORDER BY "40003" DESC LIMIT 1`, [BigInt(GROUP)]);
    const mid = pick[0]![0] as bigint;
    const info = await db.query(`SELECT "40003","40033","40093","40020" FROM group_msg_table WHERE "40001"=?`, [mid]);
    console.log(`靶子 msg=${mid} seq(40003)=${info[0]![0]} uin(40033)=${info[0]![1]} nick(40093)=${JSON.stringify(info[0]![2])}`);

    // 先看 OLD.40003+1 是否已被占用（撞 UNIQUE 的直接证据）
    const nextSeq = (info[0]![0] as bigint) + 1n;
    const clash = await db.query(`SELECT COUNT(*) FROM group_msg_table WHERE "40027"=? AND "40003"=?`, [BigInt(GROUP), nextSeq]);
    console.log(`\n① UNIQUE 预检：seq=${nextSeq}（OLD.40003+1）已存在 ${clash[0]![0]} 行  ${Number(clash[0]![0])>0?'★撞了！group UNIQUE(40027,40003,40002) 会拒绝':'（空位，不撞）'}`);

    // 建记录表
    await db.write(`CREATE TABLE IF NOT EXISTS weq_recall_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, msgid INTEGER, conv TEXT, table_kind TEXT, sender_uid TEXT, revoke_uid TEXT, orig_seq INTEGER, recall_ts INTEGER, orig_body BLOB)`);

    // ② 手动执行"记录表 INSERT"（OLD→子查询）
    console.log(`\n② 记录表 INSERT：`);
    try {
      await db.write(
        `INSERT INTO weq_recall_log (msgid,conv,table_kind,sender_uid,revoke_uid,orig_seq,recall_ts,orig_body)
         SELECT "40001", CAST("40027" AS TEXT), 'group', "40020", '', "40003", strftime('%s','now'), "40800"
           FROM group_msg_table WHERE "40001"=?`, [mid]);
      console.log(`   ✅ 成功`);
      await db.write(`DELETE FROM weq_recall_log WHERE msgid=?`, [mid]);
    } catch (e) { console.log(`   ❌ 失败: ${e instanceof Error ? e.message : e}`); }

    // ③ 手动执行"补插灰条 INSERT"（OLD→子查询 src）
    console.log(`\n③ 补插灰条 INSERT：`);
    const cols = MSG_COLUMNS.map((c) => `"${c}"`).join(',');
    const vals = MSG_COLUMNS.map((c) => graytipVal(c, 'src')).join(',');
    let _insertedId: bigint | null = null;
    try {
      // 先算出将要插入的 40001，方便清理
      const nid = await db.query(`SELECT "40001" + 10 + (abs(random()) % 41) FROM group_msg_table WHERE "40001"=?`, [mid]);
      _insertedId = nid[0]![0] as bigint;
      await db.write(
        `INSERT INTO group_msg_table (${cols})
         SELECT ${vals} FROM group_msg_table AS src WHERE src."40001"=?`, [mid]);
      console.log(`   ✅ 成功（若真插入，稍后清理）`);
    } catch (e) { console.log(`   ❌ 失败: ${e instanceof Error ? e.message : e}`); }

    // 清理可能插入的灰条（按内容找"撤回了一条消息"更稳，避免 random id 误差）
    const del = await db.write(
      `DELETE FROM group_msg_table WHERE "40027"=? AND "40011"=5 AND "40012"=17
        AND instr(CAST("40800" AS TEXT), '撤回了一条消息') > 0
        AND "40050" >= strftime('%s','now') - 120`, [BigInt(GROUP)]);
    if (del > 0) console.log(`   （已清理刚插入的测试灰条 ${del} 行）`);

    await db.write(`DROP TABLE IF EXISTS weq_recall_log`);
    console.log('\n(已清理记录表)');
  } finally {
    db.close();
  }
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
