/**
 * 任务#2 验证：在真库上用**纯 SQL** 拼出一条 tipJson 撤回灰条 40800 blob，
 * 再用 codec decodeBody 解回来，确认 nick/uin/seq 三处变量正确嵌入、结构合法、
 * 可被 WeQ 渲染。跑通 = 这段 SQL 可直接嵌进 trigger body。
 *
 * 模板（自定义撤回提示灰条，仿参考样本 7737024164892267232 的 subType=17 结构）：
 *   {"align":"center","items":[
 *     {"col":"3","jp":"tencent://ntqq-open?...%22uin%22%3A%22<UIN>%22...","txt":"<NICK>","type":"url"},
 *     {"txt":"撤回了一条消息","type":"nor"}
 *   ]}
 * 变量：<UIN>=OLD.40030(targetUin,群里是发送者uin? 见下) / <NICK>=OLD.40093 senderNick。
 *   seq 先不放（可选）。这里先验证 uin+nick 两个变量的拼装闭环。
 *
 * 拼装策略（全内置函数）：
 *   tipJson 文本 = 固定前缀 || UIN || 固定中段 || JSON转义(NICK) || 固定后缀
 *   40800 blob = CAST(
 *       X'<MsgBody外壳前缀直到tipardía field tag>'
 *     || unhex(printf 2字节varint(length(tipjson)))   -- tipJson 长度前缀
 *     || CAST(tipjson AS BLOB)
 *     || X'<tipJson后的固定尾部字段>'
 *     AS BLOB)
 *   但外层 MsgBody 也有总长度前缀，也要动态。见脚本内注释。
 *
 * Run: pnpm tsx packages/db/test/probe_build_tipjson.ts
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { decodeBody } from '../src/msg/util';

const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

async function main(): Promise<void> {
  const nt = loadNative();
  const db = new QqDb(nt.ntHelper, { dbPath: DB, key: KEY, algo: ALGO });

  // 测试变量（模拟 trigger 里的 OLD 标量）
  const UIN = '1120602125';
  const NICK = '小枳壳';

  // ---- 1. 先在 SQL 里拼 tipJson 文本，看文本对不对 ----
  // JSON 里 uin 出现在 URL-encoded 段：%22uin%22%3A%22<UIN>%22
  // nick 是 txt 值，需 JSON 转义（\ 和 " ）。这里 NICK 无特殊字符，先跑通主路径。
  const tipParts = {
    pre: `{"align":"center","items":[{"col":"3","jp":"tencent://ntqq-open?subCmd=profile&action=openMiniBuddyProfile&actionParams=%7B%22uin%22%3A%22`,
    mid: `%22%2C%22sourceType%22%3A%22QrCodeShareBuddyLink%22%7D","txt":"`,
    post: `","type":"url"},{"txt":"撤回了一条消息","type":"nor"}]}`,
  };
  // 用参数化把 UIN/NICK 传进去，SQL 里 || 拼
  const tipRow = await db.query(
    `SELECT ? || ? || ? || replace(replace(?, '\\', '\\\\'), '"', '\\"') || ? AS tip`,
    [tipParts.pre, UIN, tipParts.mid, NICK, tipParts.post],
  );
  const tipText = String(tipRow[0]![0]);
  console.log('=== 拼出的 tipJson 文本 ===');
  console.log(tipText);
  // 验证它是合法 JSON
  try { JSON.parse(tipText); console.log('✅ 合法 JSON'); }
  catch (e) { console.log('❌ JSON 非法:', e); }

  // ---- 2. 拼完整 40800 blob（含两层动态长度前缀）----
  // MsgBody 外壳: 82f613 <总长varint> + element内容
  // element: c8fc15<elementId varint> d0fc1508 d8fc1511 fac817<tipLen varint><tipJson> 80c91700 88c917e112 98c91700
  // 为简化：elementId 用固定值（复用参考样本的），其余固定字节照搬参考解剖。
  //
  // 固定字节（hex）——来自 dissect_tipjson.ts 的解剖：
  const EL_HEAD = 'c8fc15d3a5efcfc6cff0ab6ad0fc1508d8fc1511'; // #45001 elementId + #45002=8 + #45003=17
  const TIP_TAG = 'fac817'; // #48271 tag
  const EL_TAIL = '80c9170088c917e11298c91700'; // #48272=0 #48273=2401 #48275=0

  // varint 2字节生成: len<16384 → [ (len&127)|128, (len>>7)&127 ]
  // element 内容长度 = len(EL_HEAD)/2 + len(TIP_TAG)/2 + tipLenPrefixBytes(2) + byteLen(tip) + len(EL_TAIL)/2
  // 注意 tipJson 是 UTF-8，中文3字节，必须用字节长度 → SQL: length(CAST(tip AS BLOB))
  const buildSql = `
    WITH v(tip) AS (SELECT ? || ? || ? || replace(replace(?, '\\', '\\\\'), '"', '\\"') || ?)
    SELECT
      CAST(
        X'82f613'
        || unhex(printf('%02x%02x',
             ((? + 2 + length(CAST(tip AS BLOB)) + ?) & 127) | 128,
             ((? + 2 + length(CAST(tip AS BLOB)) + ?) >> 7) & 127))
        || X'${EL_HEAD}'
        || X'${TIP_TAG}'
        || unhex(printf('%02x%02x',
             (length(CAST(tip AS BLOB)) & 127) | 128,
             (length(CAST(tip AS BLOB)) >> 7) & 127))
        || CAST(tip AS BLOB)
        || X'${EL_TAIL}'
      AS BLOB) AS body,
      length(CAST(tip AS BLOB)) AS tiplen
    FROM v`;
  const elHeadBytes = EL_HEAD.length / 2;
  const elTailBytes = EL_TAIL.length / 2;
  const tipTagBytes = TIP_TAG.length / 2;
  // 参数：pre,uin,mid,nick,post,  然后 4 个算式里的常量: elHeadBytes+tipTagBytes 和 elTailBytes
  const built = await db.query(buildSql, [
    tipParts.pre, UIN, tipParts.mid, NICK, tipParts.post,
    BigInt(elHeadBytes + tipTagBytes), BigInt(elTailBytes),
    BigInt(elHeadBytes + tipTagBytes), BigInt(elTailBytes),
  ]);
  const blob = built[0]![0];
  const tiplen = built[0]![1];
  console.log(`\n=== 拼出的 40800 blob ===`);
  console.log(`typeof=${blob instanceof Uint8Array ? 'blob' : typeof blob}  tiplen(bytes)=${tiplen}`);
  if (blob instanceof Uint8Array) {
    console.log(`length=${blob.byteLength}`);
    console.log(`hex=${Buffer.from(blob).toString('hex')}`);
    console.log('\n=== codec 解码回来 ===');
    console.log(json(decodeBody(blob)));
  }

  db.close();
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
