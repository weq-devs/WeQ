/**
 * 只读全列对比：群聊撤回到底改了哪些列？（定位触发器为何不命中）
 *
 * 群聊失败、私聊成功，且过滤列(40027)已证明两种字面量都命中 → 差异只可能在触发器
 * 的条件列。私聊撤回不改 40002 已验证，但群聊是 QQ 另一套写入路径，未必相同。
 *
 * 做法：拿 live 里已撤回的群消息 msgId，去撤回前的完整 backup 查同一行，把**所有列**
 * 逐列对比，标出变化。这样无论是 40002、40800 还是别的列在群聊撤回时的行为，都一目了然。
 *
 * 全 SELECT，不写库。Run: pnpm tsx packages/db/test/diag_group_revoke_diff.ts [backup] [n]
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv } from '@weq/testkit';

const KEY = testEnv.key;
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const LIVE = testEnv.msgDbPath;
const BACKUP = process.argv[2] ?? `${LIVE}.bak-2026-07-16T01-07-00`;
const N = Number(process.argv[3] ?? 6);
const TABLE = 'group_msg_table';

const fmt = (v: unknown) =>
  v instanceof Uint8Array ? `<BLOB ${v.byteLength}B>` : v === null ? 'NULL' : String(v);

async function readRow(db: QqDb, cols: string[], msgId: bigint): Promise<unknown[] | null> {
  const sel = cols.map((c) => `"${c}"`).join(',');
  const r = await db.query(`SELECT ${sel} FROM ${TABLE} WHERE "40001"=? LIMIT 1`, [msgId]);
  return r.length ? (r[0] as unknown[]) : null;
}

async function main(): Promise<void> {
  const native = loadNative();
  const live = new QqDb(native.ntHelper, { dbPath: LIVE, key: KEY, algo: ALGO });
  const back = new QqDb(native.ntHelper, { dbPath: BACKUP, key: KEY, algo: ALGO });

  const info = await live.query(`PRAGMA table_info("${TABLE}")`);
  const cols = info.map((r) => String(r[1]));

  // live 里最近的已撤回群消息
  const revoked = await live.query(
    `SELECT "40001" FROM ${TABLE} WHERE "40011"=5 AND "40012"=4 ORDER BY rowid DESC LIMIT ?`,
    [BigInt(N)],
  );
  console.log(`live 已撤回群消息: ${revoked.length}，逐条与备份(撤回前)对比\n`);

  let matched = 0;
  const changeTally = new Map<string, number>();

  for (const rr of revoked) {
    const msgId = rr[0] as bigint;
    const liveRow = await readRow(live, cols, msgId);
    const backRow = await readRow(back, cols, msgId);
    if (!liveRow || !backRow) {
      console.log(`msg ${msgId}: ${!backRow ? '备份里没有(可能备份晚于该消息)' : 'live缺失'} — 跳过`);
      continue;
    }
    // 备份里若已经是 5/4，说明撤回前状态没抓到，对照意义小
    const bType = `${fmt(backRow[cols.indexOf('40011')])}/${fmt(backRow[cols.indexOf('40012')])}`;
    matched++;
    console.log(`════ msg ${msgId}  备份类型=${bType} ${bType === '5/4' ? '(备份也已撤回,对照弱)' : '(备份=原始✓)'}`);
    for (let i = 0; i < cols.length; i++) {
      const b = fmt(backRow[i]);
      const l = fmt(liveRow[i]);
      if (b !== l) {
        const star = cols[i] === '40002' ? ' ★40002' : cols[i] === '40800' ? ' (body)' : cols[i] === '40900' ? ' (40900)' : '';
        console.log(`    ${cols[i]}: ${b}  →  ${l}${star}`);
        changeTally.set(cols[i]!, (changeTally.get(cols[i]!) ?? 0) + 1);
      }
    }
  }

  console.log(`\n=== 变化列汇总（在 ${matched} 条中出现次数）===`);
  const sorted = [...changeTally.entries()].sort((a, b) => b[1] - a[1]);
  for (const [c, n] of sorted) console.log(`  ${c}: ${n}`);
  console.log('\n=== 判读 ===');
  console.log('  · 若 40002 出现在变化列 → 群聊撤回改了 40002，触发器 OLD.40002 IS NEW.40002 放行了它。');
  console.log('  · 若 40002 不变但 40800 变 → 触发器本应命中，问题在别处(连接重载/写入方式)。');

  live.close();
  back.close();
}

main().catch((e) => {
  console.error('failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
