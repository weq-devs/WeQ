/**
 * 只读诊断：群里最新几条到底是什么（按 rowid = 真实插入顺序），解码 40800 看
 * 最后一条是"喵喵喵"原文还是补插的撤回灰条。以及记录表现状、被撤原消息是���保住。
 * 全只读，不写任何库。
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { decodeBody } from '../src/msg/util';
import { testEnv } from '@weq/testkit';

const KEY = testEnv.key;
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const LIVE = testEnv.msgDbPath;
const GROUP = process.argv[2] ?? '673646675';

const brief = (els: any[]): string =>
  els.map((e) => {
    if (e.kind === 'text') return `text:${JSON.stringify(e.textContent?.slice(0, 20))}`;
    if (e.kind === 'grayTipPoke') return `灰条tipJson:${String(e.tipJson).slice(0, 90)}`;
    if (String(e.kind).startsWith('grayTip')) return `${e.kind}`;
    return e.kind;
  }).join(' + ');

async function main(): Promise<void> {
  const nt = loadNative();
  const db = new QqDb(nt.ntHelper, { dbPath: LIVE, key: KEY, algo: ALGO });

  // 最新 12 条：按 rowid（插入顺序）+ 40050（渲染时间）双视角
  const recent = await db.query(
    `SELECT rowid,"40001","40011","40012","40050","40093","40033","40800"
       FROM group_msg_table WHERE "40027"=? ORDER BY rowid DESC LIMIT 12`,
    [BigInt(GROUP)],
  );
  console.log(`=== 群 ${GROUP} 最新 12 条（rowid desc = 真实插入顺序）===`);
  for (const r of recent) {
    const els = decodeBody(r[7]) as any[];
    console.log(`  rowid=${r[0]} msg=${r[1]} type=${r[2]}/${r[3]} time=${r[4]} nick=${r[5] === null ? 'NULL' : JSON.stringify(r[5])} :: ${brief(els)}`);
  }

  // 记录表
  console.log(`\n=== weq_recall_log ===`);
  try {
    const log = await db.query(`SELECT msgid,sender_uid,revoke_uid,orig_seq,recall_ts,length(orig_body) FROM weq_recall_log ORDER BY seq DESC LIMIT 5`);
    if (!log.length) console.log('  (空 — 已被 cleanup 删表，或本次没记录)');
    for (const r of log) console.log(`  msg=${r[0]} sender=${r[1]} revoke=${r[2]} seq=${r[3]} ts=${r[4]} bodyLen=${r[5]}`);
  } catch { console.log('  (表不存在 — cleanup 已 DROP)'); }

  db.close();
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
