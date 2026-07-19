/**
 * 把真实 trigger 用的「38 列全 clone 补插灰条 INSERT」搬到普通连接执行，让 SQLite
 * 的真实报错吐出来。已排除：RAISE丢弃/BEFORE同表INSERT/WeQ干扰/最小灰条——都正常。
 * 唯一剩下的差异就是这条 38 列 + 真实 blob 拼接。哪列/哪约束挂，这里现形。
 *
 * ⚠️ 需关 QQ。成功则清理插入行。
 * Run: pnpm tsx packages/db/test/probe_full_insert.ts [群号] [靶子msgId可选]
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
function val(c: string, src: string): string {
  switch (c) {
    case '40001': return `${src}."40001" + 10 + (abs(random()) % 41)`;
    case '40002': return `abs(random()) % 2147483647`;
    case '40003': return `${src}."40003" + 1`;
    case '40008': return `IFNULL(${src}."40008",0) + 1`;
    case '40011': return '5'; case '40012': return '17';
    case '40050': return `strftime('%s','now')`; case '40058': return `strftime('%s','now')`;
    case '40800': {
      const tip=`(${lit(PRE)} || CAST(${src}."40033" AS TEXT) || ${lit(MID)} || replace(replace(CAST(${src}."40093" AS TEXT),char(92),char(92)||char(92)),char(34),char(92)||char(34)) || ${lit(POST)})`;
      const tl=`length(CAST(${tip} AS BLOB))`, ol=`(${HEAD} + 2 + ${tl} + ${TAIL})`;
      return `CAST(X'82f613' || unhex(printf('%02x%02x',(${ol}&127)|128,(${ol}>>7)&127)) || X'${EL_HEAD}' || X'${TIP_TAG}' || unhex(printf('%02x%02x',(${tl}&127)|128,(${tl}>>7)&127)) || CAST(${tip} AS BLOB) || X'${EL_TAIL}' AS BLOB)`;
    }
    case '40900': case '40801': case '40062': case '40600': case '40601': case '40605': return 'NULL';
    default: return `${src}."${c}"`;
  }
}

async function main(): Promise<void> {
  const nt = loadNative();
  if (nt.ntHelper.getQqProcesses().length) { console.error('先关 QQ'); process.exit(1); }
  const db = new QqDb(nt.ntHelper, { dbPath: DB, key: KEY, algo: ALGO });
  try {
    const pick = process.argv[3]
      ? [[BigInt(process.argv[3])]] as any
      : await db.query(`SELECT "40001" FROM group_msg_table WHERE "40027"=? AND "40011"=2 AND "40012"=1 ORDER BY "40003" DESC LIMIT 1`, [BigInt(GROUP)]);
    const mid = pick[0]![0] as bigint;
    const dbg = await db.query(`SELECT "40003","40033","40093","40002","40005" FROM group_msg_table WHERE "40001"=?`, [mid]);
    console.log(`靶子 msg=${mid} seq=${dbg[0]![0]} uin=${dbg[0]![1]} nick=${JSON.stringify(dbg[0]![2])} 40002=${dbg[0]![3]} 40005=${dbg[0]![4]}`);

    const cols = MSG_COLUMNS.map((c) => `"${c}"`).join(',');
    const vals = MSG_COLUMNS.map((c) => val(c, 'src')).join(',');
    console.log('\n执行 38 列 INSERT ...');
    try {
      await db.write(`INSERT INTO group_msg_table (${cols}) SELECT ${vals} FROM group_msg_table AS src WHERE src."40001"=?`, [mid]);
      console.log('✅ FULL 38列 INSERT 成功');
      const del = await db.write(`DELETE FROM group_msg_table WHERE "40027"=? AND "40011"=5 AND "40012"=17 AND instr(CAST("40800" AS TEXT),'撤回了一条消息')>0 AND "40050">=strftime('%s','now')-120`, [BigInt(GROUP)]);
      console.log(`（清理 ${del} 行）`);
    } catch (e) {
      console.log(`❌ FAIL = ${e instanceof Error ? e.message : e}`);
      // 若失败，逐步二分：先只插必要列看看
      console.log('\n→ 试最小列插入（排除是哪列约束）...');
      try {
        await db.write(
          `INSERT INTO group_msg_table ("40001","40002","40003","40011","40012","40027","40020","40050","40800")
           SELECT "40001"+123, abs(random())%2147483647, "40003", 5, 17, "40027", "40020", strftime('%s','now'),
                  CAST(X'82f613' AS BLOB)
             FROM group_msg_table WHERE "40001"=?`, [mid]);
        console.log('   最小列插入 ✅（说明是某个 clone 的列值/约束问题，非 blob）');
        await db.write(`DELETE FROM group_msg_table WHERE "40027"=? AND "40011"=5 AND "40012"=17 AND "40800"=X'82f613'`, [BigInt(GROUP)]);
      } catch (e2) { console.log(`   最小列也失败 = ${e2 instanceof Error ? e2.message : e2}`); }
    }
  } finally {
    db.close();
  }
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
